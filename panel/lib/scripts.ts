/**
 * Saved commands (Run command → Your commands) and the approval check every
 * custom script goes through before it runs on a machine (lib/approval.ts).
 *
 *   GET    /api/scripts        every saved command, with its hash
 *   POST   /api/scripts        save one ({name, script})
 *   PATCH  /api/scripts/:id    change its name or script (a new script needs approving again)
 *   DELETE /api/scripts/:id    remove it
 *
 * Only server.ts imports this (it logs to lib/audit.ts). The skill's token can't reach it.
 */
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { approveCommand, isHash, type SavedScript } from "./approval";
import { logActivity } from "./audit";
import { getNode, getSetting, InventoryError, setSetting } from "./fleet";
import { normalizeScript, scriptHash } from "./script-hash";
import { shq } from "./ssh";
import type { FleetNode } from "./types";

const KEY = "scripts";
const MAX_SCRIPTS = 200;
const MAX_LENGTH = 20_000;

type Stored = Omit<SavedScript, "hash">;

function load(): Stored[] {
  try {
    const v = JSON.parse(getSetting(KEY) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function save(list: Stored[]) {
  setSetting(KEY, JSON.stringify(list));
}

const withHash = (s: Stored): SavedScript => ({ ...s, hash: scriptHash(s.script) });

export function listScripts(): SavedScript[] {
  return load().map(withHash);
}

export function getSavedScript(id: string): SavedScript | undefined {
  const s = load().find((x) => x.id === id);
  return s && withHash(s);
}

function cleanName(v: unknown, list: Stored[], self?: string): string {
  if (typeof v !== "string") throw new InventoryError("Give the command a name");
  const name = v.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  if (!name) throw new InventoryError("Give the command a name");
  if (name.length > 80) throw new InventoryError("The name is too long (at most 80 characters)");
  if (list.some((s) => s.id !== self && s.name.toLowerCase() === name.toLowerCase())) throw new InventoryError(`There's already a command called “${name}”`);
  return name;
}

function cleanScript(v: unknown): string {
  if (typeof v !== "string") throw new InventoryError("The command must be text");
  const script = normalizeScript(v);
  if (!script) throw new InventoryError("The command is empty");
  if (script.length > MAX_LENGTH) throw new InventoryError("The command is too long (at most 20,000 characters)");
  return script;
}

/* ---------------- approval ---------------- */

/**
 * A bash snippet that stops the run (exit 126) unless the machine approved the
 * script with this hash, and says how to approve it. The panel builds it on the
 * server around the exact script it is about to run, so nothing sent from a
 * browser can leave the check out or swap the script after it.
 */
export function approvalCheck(node: FleetNode, hash: string, what: string): string {
  if (!isHash(hash)) throw new Error("Not a script hash");
  const how = `To approve it, run this on ${node.id} yourself (at the machine or over your own ssh, not from the panel):`;
  return [
    `if ! awk -v h=${hash} '$1 == h { ok = 1 } END { exit !ok }' "$HOME/.config/fleet/approved-scripts" 2>/dev/null; then`,
    `  printf '\\033[38;2;247;118;142m%s\\033[0m\\n\\n%s\\n\\n  \\033[1m%s\\033[0m\\n\\n' ${shq(`${what} isn't approved on ${node.id}, so nothing was run.`)} ${shq(how)} ${shq(approveCommand(node, hash))}`,
    "  exit 126",
    "fi",
  ].join("\n");
}

/** The script a machine's agent asks for when its owner runs `fleet-agent approve <hash>` there. */
export function scriptForApproval(nodeId: string, hash: string): { name: string; script: string } | null {
  const node = getNode(nodeId);
  if (node?.updateScript && node.updateScriptHash === hash) return { name: `${node.id} update script`, script: node.updateScript };
  const s = listScripts().find((x) => x.hash === hash);
  return s ? { name: s.name, script: s.script } : null;
}

/* ---------------- HTTP ---------------- */

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, limit = 64_000): Promise<Record<string, unknown>> {
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

/** /api/scripts: needs a signed-in session (server.ts checks it first). */
export async function handleScripts(req: IncomingMessage, res: ServerResponse, url: URL, actor: string): Promise<boolean> {
  const m = url.pathname.match(/^\/api\/scripts(?:\/([\w-]{1,40}))?$/);
  if (!m) return false;
  const method = req.method ?? "GET";
  const log = (summary: string, detail?: string) => logActivity({ source: "panel", kind: "panel.script", actor, summary, detail, status: "ok" });
  try {
    const list = load();
    if (!m[1]) {
      if (method === "GET") return json(res, 200, { scripts: list.map(withHash) }), true;
      if (method !== "POST") return json(res, 405, { error: "Method not allowed" }), true;
      if (list.length >= MAX_SCRIPTS) throw new InventoryError(`At most ${MAX_SCRIPTS} saved commands`);
      const b = await readJson(req);
      const now = Date.now();
      const s: Stored = { id: randomBytes(6).toString("base64url"), name: cleanName(b.name, list), script: cleanScript(b.script), createdAt: now, updatedAt: now };
      save([...list, s]);
      log(`Saved the command “${s.name}” (each machine has to approve it before it runs)`, s.script);
      return json(res, 201, withHash(s)), true;
    }

    const i = list.findIndex((s) => s.id === m[1]);
    if (i < 0) return json(res, 404, { error: "That command doesn't exist any more" }), true;
    const old = list[i];
    if (method === "PATCH") {
      const b = await readJson(req);
      const next: Stored = { ...old, updatedAt: Date.now() };
      if ("name" in b) next.name = cleanName(b.name, list, old.id);
      if ("script" in b) next.script = cleanScript(b.script);
      list[i] = next;
      save(list);
      const changed = next.script !== old.script;
      log(`Edited the command “${next.name}”${changed ? " (machines have to approve the new version)" : ""}`, changed ? next.script : undefined);
      return json(res, 200, withHash(next)), true;
    }
    if (method === "DELETE") {
      save(list.filter((s) => s.id !== old.id));
      log(`Deleted the command “${old.name}”`);
      return json(res, 200, { ok: true }), true;
    }
    return json(res, 405, { error: "Method not allowed" }), true;
  } catch (err) {
    if (err instanceof InventoryError) return json(res, err.status, { error: err.message }), true;
    return json(res, 500, { error: (err as Error).message }), true;
  }
}
