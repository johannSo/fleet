/**
 * HTTP API for the inventory and the Claude skill. Called from server.ts, which
 * has already checked the session, or (for the inventory paths only) the
 * skill's bearer token; see tokenAllows().
 *
 *   GET    /api/inventory              every machine (JSON)
 *   GET    /api/inventory.md           the same as Markdown
 *   POST   /api/machines               add a machine (then indexes it)
 *   PATCH  /api/machines/:id           change fields
 *   DELETE /api/machines/:id           remove it
 *   POST   /api/machines/:id/index     re-index now
 *   GET    /api/panel/ssh-key          the key machines must authorize
 *   POST   /api/panel/ssh-key          create one if there is none
 *   PUT    /api/networks/name          name a subnet on the Network page ({cidr, name}; "" removes it)
 *   GET    /api/skill                  generated SKILL.md + its settings
 *   PUT    /api/skill                  change settings
 *   POST   /api/skill/token            new access token (old copies stop working)
 *   GET    /api/skill/download         SKILL.md (?format=zip for a .zip)
 *   POST   /api/skill/install          one-time install command
 *   GET    /skill/install?code=…       SKILL.md for that command (no session needed)
 */
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { logActivity } from "./audit";
import { createMachine, deleteMachine, getNode, getSetting, InventoryError, loadFleet, setNetworkName, setSetting, updateMachine } from "./fleet";
import { indexMachine } from "./indexer";
import { hostName, lanAddresses } from "./net";
import { inventoryMarkdown, skillMarkdown, zip } from "./skill";
import type { FleetNode, MachineInput } from "./types";

export interface ApiCtx {
  /** Who is asking, for the activity log. */
  actor: string;
  /** The panel's HTTP port, for the skill's default address. */
  port: number;
  /** Authorized by the skill's bearer token rather than a signed-in session. */
  viaToken?: boolean;
}

/**
 * The update script runs on the machine whenever someone presses Update, so
 * only a signed-in session may set it: a leaked skill token must not turn into
 * code execution across the fleet.
 */
function guardScript(body: MachineInput, ctx: ApiCtx) {
  if (ctx.viaToken && ("updateScript" in body || "updateScriptWhen" in body)) {
    throw new InventoryError("Update scripts can only be changed in the panel (Edit machine → Update)", 403);
  }
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, body: string | Buffer, type: string, headers: Record<string, string> = {}) {
  res.writeHead(200, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(body);
}

function readJson(req: IncomingMessage, limit = 256_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) {
        reject(new InventoryError("Request too large", 413));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const v = data ? JSON.parse(data) : {};
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
        resolve(v);
      } catch {
        reject(new InventoryError("Expected a JSON object"));
      }
    });
    req.on("error", reject);
  });
}

/* ---------------- skill settings and token ---------------- */

const TOKEN_PATHS = /^\/api\/(inventory(\.md)?|machines(\/.*)?|panel\/ssh-key)$/;

function liveAccess(): boolean {
  return getSetting("skill.live") !== "0";
}

function token(create: boolean): string | null {
  let t = getSetting("skill.token");
  if (!t && create) {
    t = `fleet_${randomBytes(24).toString("base64url")}`;
    setSetting("skill.token", t);
    setSetting("skill.token_at", String(Date.now()));
  }
  return t;
}

/** True when the request carries the skill's token and asks for something the token may do. */
export function tokenAllows(req: IncomingMessage, pathname: string): boolean {
  if (!TOKEN_PATHS.test(pathname)) return false;
  if (pathname === "/api/panel/ssh-key" && req.method !== "GET") return false;
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
  if (!m || !liveAccess()) return false;
  const want = token(false);
  if (!want) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function defaultPanelUrl(req: IncomingMessage, port: number): string {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  const loop = !host || host === "localhost" || host.startsWith("127.") || host === "[::1]";
  return `http://${loop ? (lanAddresses()[0] ?? `${hostName()}.local`) : host}:${port}`;
}

function skillSettings(req: IncomingMessage, port: number) {
  const defaultUrl = defaultPanelUrl(req, port);
  return {
    live: liveAccess(),
    panelUrl: getSetting("skill.url") || defaultUrl,
    customUrl: !!getSetting("skill.url"),
    defaultUrl,
    extra: getSetting("skill.extra") ?? "",
  };
}

function buildSkill(req: IncomingMessage, port: number): string {
  const s = skillSettings(req, port);
  return skillMarkdown(loadFleet(), {
    panelUrl: s.panelUrl.replace(/\/+$/, ""),
    token: s.live ? token(true) : null,
    extra: s.extra,
    generatedAt: Date.now(),
  });
}

/* ---------------- one-time install codes ---------------- */

const g = globalThis as unknown as { __skillCodes?: Map<string, number> };
const codes = (g.__skillCodes ??= new Map());
const CODE_TTL = 10 * 60_000;

function newCode(): { code: string; expiresAt: number } {
  for (const [c, exp] of codes) if (exp < Date.now()) codes.delete(c);
  const code = randomBytes(12).toString("base64url");
  const expiresAt = Date.now() + CODE_TTL;
  codes.set(code, expiresAt);
  return { code, expiresAt };
}

function redeemCode(code: string): boolean {
  const exp = codes.get(code);
  codes.delete(code);
  return !!exp && exp > Date.now();
}

/** GET /skill/install?code=…: the one path here that needs no session. */
export function handleSkillInstall(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ApiCtx): boolean {
  if (url.pathname !== "/skill/install" || req.method !== "GET") return false;
  if (!redeemCode(url.searchParams.get("code") ?? "")) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end("This install code is invalid, used or expired. Get a new one from the panel's Claude skill page.\n");
    return true;
  }
  logActivity({ source: "panel", kind: "panel.skill", actor: ctx.actor, summary: "Installed the Claude skill with a one-time command", status: "ok" });
  text(res, buildSkill(req, ctx.port), "text/markdown; charset=utf-8");
  return true;
}

/* ---------------- the panel's ssh key ---------------- */

const SSH_DIR = path.join(os.homedir(), ".ssh");
const KEY_FILES = ["id_ed25519", "id_ecdsa", "id_rsa"];

function panelKey(): { publicKey: string | null; file: string | null; user: string; host: string } {
  const base = { user: os.userInfo().username, host: hostName() };
  for (const f of KEY_FILES) {
    const pub = path.join(SSH_DIR, `${f}.pub`);
    if (existsSync(pub)) {
      try {
        return { ...base, publicKey: readFileSync(pub, "utf8").trim(), file: pub };
      } catch {
        /* unreadable; try the next */
      }
    }
  }
  return { ...base, publicKey: null, file: null };
}

function createKey(): Promise<void> {
  const file = path.join(SSH_DIR, "id_ed25519");
  if (existsSync(file)) return Promise.reject(new InventoryError(`${file} exists but has no .pub next to it`, 409));
  mkdirSync(SSH_DIR, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) =>
    execFile("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `fleet-panel@${hostName()}`, "-f", file], (err, _out, stderr) =>
      err ? reject(new InventoryError(`ssh-keygen failed: ${stderr || err.message}`, 500)) : resolve(),
    ),
  );
}

/* ---------------- handler ---------------- */

const CONNECTION_FIELDS = ["host", "user", "port", "alias"] as const;

async function indexed(node: FleetNode, ctx: ApiCtx, why: string): Promise<FleetNode> {
  const after = (await indexMachine(node)) ?? node;
  logActivity({
    source: "panel",
    kind: "panel.index",
    actor: ctx.actor,
    node: node.id,
    summary: after.indexError ? `${why}: couldn't index the hardware` : `${why}: indexed the hardware`,
    detail: after.indexError ?? undefined,
    status: after.indexError ? "error" : "ok",
  });
  return after;
}

export async function handleInventory(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ApiCtx): Promise<boolean> {
  const { pathname } = url;
  if (!/^\/api\/(inventory|machines|networks|panel\/ssh-key|skill)/.test(pathname)) return false;
  const method = req.method ?? "GET";
  try {
    if (pathname === "/api/inventory" && method === "GET") {
      const nodes = loadFleet();
      return json(res, 200, { machines: nodes, panel: nodes.find((n) => n.local)?.id ?? null }), true;
    }
    if (pathname === "/api/inventory.md" && method === "GET") {
      return text(res, inventoryMarkdown(loadFleet()), "text/markdown; charset=utf-8"), true;
    }

    if (pathname === "/api/machines" && method === "POST") {
      const body = (await readJson(req)) as MachineInput;
      guardScript(body, ctx);
      const node = createMachine(body);
      logActivity({ source: "panel", kind: "panel.machine", actor: ctx.actor, node: node.id, summary: "Added the machine", detail: node.sshCommand ?? undefined, status: "ok" });
      return json(res, 201, await indexed(node, ctx, "Added")), true;
    }

    const m = pathname.match(/^\/api\/machines\/([^/]+)(\/index)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (m[2]) {
        if (method !== "POST") return json(res, 405, { error: "POST to re-index" }), true;
        const node = getNode(id);
        if (!node) return json(res, 404, { error: `No machine called “${id}”` }), true;
        return json(res, 200, await indexed(node, ctx, "Re-indexed")), true;
      }
      if (method === "GET") {
        const node = getNode(id);
        return node ? json(res, 200, node) : json(res, 404, { error: `No machine called “${id}”` }), true;
      }
      if (method === "PATCH") {
        const body = (await readJson(req)) as MachineInput;
        guardScript(body, ctx);
        const before = getNode(id);
        const node = updateMachine(id, body);
        const fields = Object.keys(body).filter((k) => k !== "id");
        logActivity({ source: "panel", kind: "panel.machine", actor: ctx.actor, node: node.id, summary: `Edited ${fields.join(", ") || "nothing"}`, status: "ok" });
        const moved = before && CONNECTION_FIELDS.some((k) => k in body && JSON.stringify(before.ssh[k] ?? "") !== JSON.stringify(node.ssh[k] ?? ""));
        return json(res, 200, moved ? await indexed(node, ctx, "Connection changed") : node), true;
      }
      if (method === "DELETE") {
        const node = deleteMachine(id);
        logActivity({ source: "panel", kind: "panel.machine", actor: ctx.actor, node: node.id, summary: "Removed the machine", status: "ok" });
        return json(res, 200, { ok: true }), true;
      }
      return json(res, 405, { error: "Method not allowed" }), true;
    }

    if (pathname === "/api/networks/name" && method === "PUT") {
      // Session only: the skill's token never matches this path (TOKEN_PATHS).
      const b = await readJson(req, 4_000);
      const cidr = String(b.cidr ?? "");
      const name = String(b.name ?? "");
      setNetworkName(cidr, name);
      logActivity({ source: "panel", kind: "panel.network", actor: ctx.actor, summary: name.trim() ? `Named ${cidr} “${name.trim()}”` : `Removed the name of ${cidr}`, status: "ok" });
      return json(res, 200, { ok: true }), true;
    }

    if (pathname === "/api/panel/ssh-key") {
      if (method === "POST" && !panelKey().publicKey) {
        await createKey();
        logActivity({ source: "panel", kind: "panel.ssh-key", actor: ctx.actor, summary: "Created an ssh key for the panel", status: "ok" });
      }
      return json(res, 200, panelKey()), true;
    }

    if (pathname === "/api/skill" && method === "GET") {
      const t = getSetting("skill.token");
      return (
        json(res, 200, {
          markdown: buildSkill(req, ctx.port),
          settings: skillSettings(req, ctx.port),
          token: t ? { preview: `${t.slice(0, 10)}…${t.slice(-4)}`, createdAt: Number(getSetting("skill.token_at")) || null } : null,
        }),
        true
      );
    }
    if (pathname === "/api/skill" && method === "PUT") {
      const b = await readJson(req, 64_000);
      if ("live" in b) setSetting("skill.live", b.live ? "1" : "0");
      if ("panelUrl" in b) {
        const u = String(b.panelUrl ?? "").trim().replace(/\/+$/, "");
        if (u && !/^https?:\/\/[^\s/]+$/.test(u)) throw new InventoryError("Panel address should look like http://192.168.1.10:4747");
        setSetting("skill.url", u || null);
      }
      if ("extra" in b) {
        const e = String(b.extra ?? "");
        if (e.length > 20_000) throw new InventoryError("Extra instructions are too long (at most 20,000 characters)");
        setSetting("skill.extra", e.trim() || null);
      }
      logActivity({ source: "panel", kind: "panel.skill", actor: ctx.actor, summary: "Changed the Claude skill's settings", status: "ok" });
      return json(res, 200, { ok: true }), true;
    }
    if (pathname === "/api/skill/token" && method === "POST") {
      setSetting("skill.token", null);
      token(true);
      logActivity({ source: "panel", kind: "panel.skill", actor: ctx.actor, summary: "Made a new access token for the Claude skill (old copies lost live access)", status: "ok" });
      return json(res, 200, { ok: true }), true;
    }
    if (pathname === "/api/skill/download" && method === "GET") {
      const md = buildSkill(req, ctx.port);
      logActivity({ source: "panel", kind: "panel.skill", actor: ctx.actor, summary: "Downloaded the Claude skill", status: "ok" });
      if (url.searchParams.get("format") === "zip") {
        return text(res, zip([{ name: "fleet/SKILL.md", data: md }]), "application/zip", { "content-disposition": 'attachment; filename="fleet-skill.zip"' }), true;
      }
      return text(res, md, "text/markdown; charset=utf-8", { "content-disposition": 'attachment; filename="SKILL.md"' }), true;
    }
    if (pathname === "/api/skill/install" && method === "POST") {
      const { code, expiresAt } = newCode();
      const base = skillSettings(req, ctx.port).panelUrl.replace(/\/+$/, "");
      const command = `mkdir -p ~/.claude/skills/fleet && curl -fsS '${base}/skill/install?code=${code}' -o ~/.claude/skills/fleet/SKILL.md && echo 'Fleet skill installed'`;
      return json(res, 200, { command, expiresAt }), true;
    }

    return json(res, 404, { error: "Not found" }), true;
  } catch (err) {
    if (err instanceof InventoryError) return json(res, err.status, { error: err.message }), true;
    console.error("[inventory-api]", err);
    return json(res, 500, { error: (err as Error).message }), true;
  }
}
