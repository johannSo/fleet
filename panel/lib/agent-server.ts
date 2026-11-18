/**
 * The panel's side of fleet-agent (docs/SERVER_AGENT.md): the /ws/agent
 * endpoint, machine tokens, installing and removing agents, and self-updates.
 * Only server.ts imports this (it logs to lib/audit.ts).
 *
 *   wss  /ws/agent                       an agent's connection (Authorization: Bearer <machine token>)
 *   GET  /agent/install/<code>           install script for a one-time install command (no session)
 *   GET  /agent/bin/<arch>               the agent binary (machine token, or the install script's ticket)
 *   GET  /agent/script/<sha256>          a custom script, for `fleet-agent approve` to show before approving (machine token)
 *   POST /api/agents/<id>/command        make a one-time install command
 *   DELETE /api/agents/<id>              revoke the machine's token (the agent stops reporting)
 *
 * Installing over ssh, re-keying and removing run in terminal tabs (lib/actions.ts → agentLaunch).
 */
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  agentConn,
  allAgents,
  registerAgent,
  resolveReply,
  unregisterAgent,
  type AgentConn,
  type AgentReport,
} from "./agents";
import { logActivity } from "./audit";
import { clientIp } from "./auth";
import { AGENT_ARCHES, AGENT_BIN_DIR, agentRelease, COLLECTOR_KINDS, goArch, type AgentArch, type CollectorKind } from "./collectors";
import { getNode, InventoryError, machineForAgentToken, recordAgent, setAgentTokenHash } from "./fleet";
import { STATE_DIR } from "./net";
import { scriptForApproval } from "./scripts";
import { SSH_BASE_OPTS, shq, sshDest } from "./ssh";
import { ingestAgentReport, ingestBackfill } from "./state";
import { CA_CERT } from "./tls";
import type { FleetNode } from "./types";

/* ---------------- tokens ---------------- */

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** Disconnects the machine's agent, if one is connected. */
function kick(id: string, reason: string) {
  agentConn(id)?.close(4001, reason);
}

/** Makes a new token for the machine; the old one stops working at once. */
function issueToken(node: FleetNode): string {
  const token = `fleetagent_${randomBytes(32).toString("base64url")}`;
  setAgentTokenHash(node.id, hashToken(token));
  kick(node.id, "token replaced");
  return token;
}

/** Revokes the machine's token: its agent is cut off and can't reconnect. */
export function revokeAgent(node: FleetNode, actor: string) {
  setAgentTokenHash(node.id, null);
  kick(node.id, "token revoked");
  logActivity({ source: "panel", kind: "panel.agent", actor, node: node.id, summary: "Removed the agent's token: it can no longer report", status: "ok" });
}

/* ---------------- what an install writes ---------------- */

const TAILSCALE = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

function tlsPort(): number {
  const p = Number(process.env.TLS_PORT ?? 4443);
  if (!p) throw new InventoryError("The panel's HTTPS listener is off (TLS_PORT=0); agents connect over HTTPS", 409);
  return p;
}

/** The panel's addresses an agent should try, in order: LAN, then Tailscale. */
export function panelUrls(): string[] {
  // Set by hand, e.g. a Tailscale MagicDNS name: FLEET_AGENT_URLS=https://panel:4443,https://100.64.0.10:4443
  const fixed = (process.env.FLEET_AGENT_URLS ?? "")
    .split(",")
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter((u) => /^https:\/\/[^\s/]+$/.test(u));
  if (fixed.length) return fixed;
  const port = tlsPort();
  // Real interfaces only: a Docker or VM bridge address (172.17.0.1…) means something else on every machine.
  const lan: string[] = [];
  const ts: string[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|vnet|cni|flannel|podman|lxc|lo)/.test(name)) continue;
    for (const a of list ?? []) {
      if (a.internal || a.family !== "IPv4") continue;
      if (TAILSCALE.test(a.address)) ts.push(a.address);
      else if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) lan.push(a.address);
    }
  }
  const ips = [...new Set([...lan, ...ts])];
  if (!ips.length) throw new InventoryError("The panel has no LAN or Tailscale address an agent could reach", 409);
  return ips.map((ip) => `https://${ip}:${port}`);
}

function caPem(): string {
  if (!existsSync(CA_CERT)) throw new InventoryError("The panel has no certificate authority yet (HTTPS is off)", 409);
  return readFileSync(CA_CERT, "utf8");
}

function configToml(node: FleetNode, urls: string[]): string {
  return [
    `# fleet-agent config, written by the Fleet panel on ${new Date().toISOString().slice(0, 10)}.`,
    "# Reinstall the agent from the panel to change it.",
    `id = ${JSON.stringify(node.id)}`,
    `urls = [${urls.map((u) => JSON.stringify(u)).join(", ")}]`,
    "",
  ].join("\n");
}

function release() {
  const rel = agentRelease();
  if (!rel || !Object.keys(rel.binaries).length) {
    throw new InventoryError("The panel has no fleet-agent build: run ./deploy.sh from the repo (or agent/build.sh)", 409);
  }
  return rel;
}

/* ---------------- terminal actions: install, new token, remove (over ssh) ---------------- */

const STAGE_DIR = path.join(STATE_DIR, "agent-stage");

/** Writes config, token and CA into a private directory the install script copies over ssh and then deletes. */
function stage(files: Record<string, string>): string {
  mkdirSync(STAGE_DIR, { recursive: true, mode: 0o700 });
  // Leftovers from a script that was killed before its cleanup ran.
  for (const d of readdirSync(STAGE_DIR)) {
    const p = path.join(STAGE_DIR, d);
    try {
      if (Date.now() - statSync(p).mtimeMs > 3_600_000) rmSync(p, { recursive: true, force: true });
    } catch {
      /* gone */
    }
  }
  const dir = path.join(STAGE_DIR, randomBytes(8).toString("hex"));
  mkdirSync(dir, { mode: 0o700 });
  for (const [name, data] of Object.entries(files)) writeFileSync(path.join(dir, name), data, { mode: 0o600 });
  return dir;
}

function banner(text: string) {
  return `printf '\\033[38;2;86;95;137m── \\033[38;2;122;162;247m%s\\033[38;2;86;95;137m ──\\033[0m\\n' ${shq(text)}`;
}

export interface AgentLaunch {
  title: string;
  command: string;
  file: string;
  args: string[];
}

/**
 * A terminal tab that installs, re-keys or removes a machine's agent. It runs on
 * the panel's machine and reaches the machine over ssh, so the token never
 * appears in a command line, the activity log or the transcript.
 */
export function agentLaunch(node: FleetNode, op: string, actor: string): AgentLaunch {
  if (node.local) throw new Error("The panel's own machine doesn't need an agent: it reads its metrics directly");
  if (!node.sshTarget) throw new Error(`${node.id} has no ssh connection: use the one-time install command instead`);
  const ssh = ["ssh", ...SSH_BASE_OPTS, "-o", "ConnectTimeout=8", "-o", "LogLevel=ERROR"].map(shq).join(" ");
  const dest = sshDest(node).map(shq).join(" ");
  const batch = `${ssh} -o BatchMode=yes ${dest}`;
  const tty = `${ssh} -t ${dest}`;

  if (op === "install") {
    release();
    const config = configToml(node, panelUrls());
    const ca = caPem();
    // The token is made last, once everything that can refuse has had its say.
    const dir = stage({ "config.toml": config, "ca.pem": ca, token: `${issueToken(node)}\n` });
    logActivity({ source: "panel", kind: "panel.agent", actor, node: node.id, summary: "Installing the agent over ssh (new token; any old one stopped working)", status: "info" });
    const script = [
      "set -euo pipefail",
      `S=${shq(dir)}; trap 'rm -rf "$S"' EXIT`,
      banner(`install fleet-agent on ${node.id}`),
      `m=$(${batch} uname -m)`,
      `case "$m" in x86_64|amd64) a=amd64 ;; aarch64|arm64) a=arm64 ;; *) echo "fleet-agent isn't built for $m"; exit 1 ;; esac`,
      `BIN=${shq(AGENT_BIN_DIR)}/fleet-agent-$a`,
      `[ -f "$BIN" ] || { echo "The panel has no fleet-agent build for $a: run ./deploy.sh"; exit 1; }`,
      `echo "→ copying fleet-agent ($a) and its config to ${node.id}"`,
      `tar -C "$S" -cf - config.toml ca.pem token | ${batch} 'mkdir -p ~/.config/fleet-agent ~/.local/bin && chmod 700 ~/.config/fleet-agent && umask 077 && tar -C ~/.config/fleet-agent -xf -'`,
      `${batch} 'cat > ~/.local/bin/.fleet-agent.new && chmod 755 ~/.local/bin/.fleet-agent.new && mv -f ~/.local/bin/.fleet-agent.new ~/.local/bin/fleet-agent' < "$BIN"`,
      `echo "→ installing the service"`,
      `${tty} '~/.local/bin/fleet-agent install'`,
    ].join("\n");
    return { title: "install agent", command: `copy fleet-agent to ${node.id} over ssh, then ~/.local/bin/fleet-agent install`, file: "bash", args: ["-c", script] };
  }

  if (op === "token") {
    const dir = stage({ token: `${issueToken(node)}\n` });
    logActivity({ source: "panel", kind: "panel.agent", actor, node: node.id, summary: "Made a new agent token (the old one stopped working)", status: "ok" });
    const script = [
      "set -euo pipefail",
      `S=${shq(dir)}; trap 'rm -rf "$S"' EXIT`,
      banner(`new token for fleet-agent on ${node.id}`),
      `${batch} 'umask 077 && mkdir -p ~/.config/fleet-agent && cat > ~/.config/fleet-agent/token && systemctl --user restart fleet-agent.service' < "$S/token"`,
      `echo "✓ new token in place; the agent reconnects with it"`,
    ].join("\n");
    return { title: "agent token", command: `write a new token to ${node.id}:~/.config/fleet-agent/token over ssh and restart fleet-agent`, file: "bash", args: ["-c", script] };
  }

  if (op === "remove") {
    revokeAgent(node, actor);
    const script = [banner(`remove fleet-agent from ${node.id}`), `${tty} '~/.local/bin/fleet-agent uninstall'`].join("\n");
    return { title: "remove agent", command: "~/.local/bin/fleet-agent uninstall", file: "bash", args: ["-c", script] };
  }

  throw new Error("Invalid agent operation");
}

/* ---------------- one-time install command ---------------- */

interface Shared {
  codes: Map<string, { node: string; base: string; expiresAt: number }>;
  tickets: Map<string, number>;
  /** Last connect/disconnect logged per machine, to keep flapping out of the activity log. */
  logged: Map<string, number>;
  /** Last update offered per machine. */
  offers: Map<string, { build: string; at: number }>;
  started: boolean;
}
const g = globalThis as unknown as { __fleetAgentServer?: Shared };
const sh: Shared = (g.__fleetAgentServer ??= { codes: new Map(), tickets: new Map(), logged: new Map(), offers: new Map(), started: false });

const CODE_TTL = 10 * 60_000;

function prune() {
  const now = Date.now();
  for (const [c, v] of sh.codes) if (v.expiresAt < now) sh.codes.delete(c);
  for (const [t, exp] of sh.tickets) if (exp < now) sh.tickets.delete(t);
}

/** The panel address for a command: the one the operator is using, when it's one of the panel's own. */
function commandBase(req: IncomingMessage): string {
  const urls = panelUrls();
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  const own = urls.find((u) => new URL(u).hostname === host);
  return own ?? urls[0];
}

function installScript(node: FleetNode, base: string, token: string, ticket: string): string {
  const rel = release();
  const urls = [...new Set([base, ...panelUrls()])];
  const arches = AGENT_ARCHES.filter((a) => rel.binaries[a])
    .map((a) => `  ${a === "amd64" ? "x86_64|amd64" : "aarch64|arm64"}) A=${a}; SUM=${rel.binaries[a]!.sha256} ;;`)
    .join("\n");
  return `#!/bin/sh
# fleet-agent for ${node.id}, from the Fleet panel at ${base}. This script worked once and is now spent.
set -eu
case "$(uname -m)" in
${arches}
  *) echo "fleet-agent isn't built for $(uname -m)" >&2; exit 1 ;;
esac
D="$HOME/.config/fleet-agent"
B="$HOME/.local/bin"
mkdir -p "$D" "$B"
chmod 700 "$D"
umask 077
cat > "$D/ca.pem" <<'FLEET_EOF'
${caPem().trim()}
FLEET_EOF
cat > "$D/config.toml" <<'FLEET_EOF'
${configToml(node, panelUrls()).trim()}
FLEET_EOF
printf '%s\\n' '${token}' > "$D/token"
umask 022
T="$B/.fleet-agent.download"
ok=0
for U in ${urls.map(shq).join(" ")}; do
  if curl -fsS --cacert "$D/ca.pem" -o "$T" "$U/agent/bin/$A?t=${ticket}"; then ok=1; break; fi
done
[ "$ok" = 1 ] || { rm -f "$T"; echo "couldn't download fleet-agent from the panel" >&2; exit 1; }
echo "$SUM  $T" | sha256sum -c --status - || { rm -f "$T"; echo "the fleet-agent download is corrupt (sha256 mismatch)" >&2; exit 1; }
chmod 755 "$T"
mv -f "$T" "$B/fleet-agent"
exec "$B/fleet-agent" install
`;
}

/* ---------------- HTTP ---------------- */

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function plain(res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

/** /agent/install/<code>, /agent/bin/<arch> and /agent/script/<sha256>: reached without a session, by the installer and by agents. */
export function handleAgentPublic(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const { pathname } = url;
  if (!pathname.startsWith("/agent/") || req.method !== "GET") return false;
  prune();

  const inst = pathname.match(/^\/agent\/install\/([\w-]{8,64})$/);
  if (inst) {
    const entry = sh.codes.get(inst[1]);
    sh.codes.delete(inst[1]);
    const node = entry && entry.expiresAt > Date.now() ? getNode(entry.node) : undefined;
    if (!entry || !node) {
      plain(res, 403, "echo 'This install command is invalid, used or expired. Get a new one from the machine'\"'\"'s page in the panel.' >&2; exit 1\n");
      return true;
    }
    try {
      const ticket = randomBytes(18).toString("base64url");
      sh.tickets.set(ticket, Date.now() + CODE_TTL);
      const script = installScript(node, entry.base, issueToken(node), ticket);
      logActivity({ source: "panel", kind: "panel.agent", actor: clientIp(req), node: node.id, summary: "Installing the agent with a one-time command (new token; any old one stopped working)", status: "info" });
      plain(res, 200, script, "text/x-shellscript; charset=utf-8");
    } catch (err) {
      plain(res, 500, `echo ${shq(`fleet panel: ${(err as Error).message}`)} >&2; exit 1\n`);
    }
    return true;
  }

  const bin = pathname.match(/^\/agent\/bin\/(amd64|arm64)$/);
  if (bin) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const ticket = url.searchParams.get("t") ?? "";
    const allowed = (bearer && machineForAgentToken(hashToken(bearer))) || (ticket && (sh.tickets.get(ticket) ?? 0) > Date.now());
    if (!allowed) return plain(res, 401, "Not authorized\n"), true;
    const b = agentRelease()?.binaries[bin[1] as AgentArch];
    if (!b) return plain(res, 404, "No build for that architecture\n"), true;
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(b.size), "cache-control": "no-store", "x-sha256": b.sha256 });
    createReadStream(b.file).pipe(res);
    return true;
  }

  // `fleet-agent approve <sha256>`, run by the machine's owner on the machine: shows the script, then asks.
  // The agent checks the hash itself, so the panel can't get a different script approved.
  const script = pathname.match(/^\/agent\/script\/([0-9a-f]{64})$/);
  if (script) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
    const id = bearer ? machineForAgentToken(hashToken(bearer)) : null;
    if (!id) return plain(res, 401, "Not authorized\n"), true;
    const found = scriptForApproval(id, script[1]);
    if (!found) return json(res, 404, { error: "The panel has no script with that hash (it was changed or deleted)" }), true;
    logActivity({ source: "panel", kind: "panel.script", actor: "fleet-agent", node: id, summary: `Sent “${found.name}” to the machine for approval`, status: "info" });
    return json(res, 200, { machine: id, name: found.name, script: found.script }), true;
  }

  plain(res, 404, "Not found\n");
  return true;
}

/** /api/agents/*: needs a signed-in session (server.ts checks it first). */
export function handleAgentApi(req: IncomingMessage, res: ServerResponse, url: URL, actor: string): boolean {
  const m = url.pathname.match(/^\/api\/agents\/([^/]+)(\/command)?$/);
  if (!m) return false;
  try {
    const node = getNode(decodeURIComponent(m[1]));
    if (!node) return json(res, 404, { error: "No such machine" }), true;
    if (m[2] && req.method === "POST") {
      if (node.local) throw new InventoryError("The panel's own machine doesn't need an agent");
      release();
      prune();
      const code = randomBytes(15).toString("base64url");
      const expiresAt = Date.now() + CODE_TTL;
      const base = commandBase(req);
      sh.codes.set(code, { node: node.id, base, expiresAt });
      logActivity({ source: "panel", kind: "panel.agent", actor, node: node.id, summary: "Made a one-time agent install command", status: "info" });
      // -k: the script is fetched before the panel's CA is on the machine; it carries the CA
      // and checks everything after it (the binary, the agent's connection) against it.
      return json(res, 200, { command: `curl -fsSk ${base}/agent/install/${code} | sh`, expiresAt }), true;
    }
    if (!m[2] && req.method === "DELETE") {
      revokeAgent(node, actor);
      return json(res, 200, { ok: true }), true;
    }
    return json(res, 405, { error: "Method not allowed" }), true;
  } catch (err) {
    return json(res, err instanceof InventoryError ? err.status : 500, { error: (err as Error).message }), true;
  }
}

/* ---------------- the WebSocket ---------------- */

const wss = new WebSocketServer({ noServer: true, maxPayload: 8 << 20 });
const PING_MS = 20_000;
const LOG_EVERY = 10 * 60_000;
const SEEN_EVERY = 5 * 60_000;

interface Live {
  ws: WebSocket;
  conn: AgentConn | null;
  alive: boolean;
  pingAt: number;
  seenAt: number;
  /** Set when the panel ends it on purpose, so the close isn't logged as a drop. */
  quiet: boolean;
}
const lives = new Set<Live>();

/** Connects and disconnects go to the activity log at most once per machine per 10 minutes. */
function logConnection(id: string, summary: string, detail?: string) {
  const last = sh.logged.get(id) ?? 0;
  if (Date.now() - last < LOG_EVERY) return;
  sh.logged.set(id, Date.now());
  logActivity({ source: "panel", kind: "panel.agent", actor: "fleet-agent", node: id, summary, detail, status: "info" });
}

/** Offers the panel's build to an agent running another one (at most hourly per build). */
function offerUpdate(conn: AgentConn) {
  const rel = agentRelease();
  const arch = goArch(conn.arch);
  const bin = arch ? rel?.binaries[arch] : undefined;
  if (!rel || !bin || conn.build === rel.build) return;
  const last = sh.offers.get(conn.id);
  if (last && last.build === rel.build && Date.now() - last.at < 3_600_000) return;
  sh.offers.set(conn.id, { build: rel.build, at: Date.now() });
  conn.offered = { build: rel.build, at: Date.now() };
  conn.send({ t: "update", build: rel.build, url: `/agent/bin/${arch}`, sha256: bin.sha256 });
}

function startTimers() {
  if (sh.started) return;
  sh.started = true;
  setInterval(() => {
    for (const l of lives) {
      if (!l.alive) {
        l.quiet = false;
        l.ws.terminate();
        continue;
      }
      l.alive = false;
      l.pingAt = Date.now();
      try {
        l.ws.ping();
      } catch {
        /* closing */
      }
      if (l.conn && Date.now() - l.seenAt > SEEN_EVERY) {
        l.seenAt = Date.now();
        recordAgent(l.conn.id, { seen: Date.now() });
      }
    }
    // A deploy may have brought a new build.
    for (const c of allAgents()) offerUpdate(c);
  }, PING_MS).unref();
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

function toReport(m: Record<string, unknown>, skew: number): AgentReport | null {
  const kind = m.kind as CollectorKind;
  if (!COLLECTOR_KINDS.includes(kind) || typeof m.out !== "string") return null;
  const at = typeof m.at === "number" && Number.isFinite(m.at) ? m.at + skew : Date.now();
  return {
    kind,
    at: Math.min(at, Date.now()),
    out: m.out,
    code: typeof m.code === "number" ? m.code : -1,
    ms: typeof m.ms === "number" ? m.ms : 0,
    err: str(m.err, 4000) || undefined,
    timedOut: m.timedOut === true,
  };
}

/** Upgrades /ws/agent; the machine is the one the bearer token belongs to. Only over HTTPS. */
export function handleAgentUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const refuse = (status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (!(req.socket as TLSSocket).encrypted) return refuse("403 Forbidden");
  const token = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
  const id = token ? machineForAgentToken(hashToken(token)) : null;
  if (!id || !getNode(id)) return refuse("401 Unauthorized");
  startTimers();
  const ip = clientIp(req);
  wss.handleUpgrade(req, socket, head, (ws) => serve(ws, id, ip));
}

function serve(ws: WebSocket, id: string, ip: string) {
  const live: Live = { ws, conn: null, alive: true, pingAt: 0, seenAt: Date.now(), quiet: false };
  lives.add(live);
  const helloTimer = setTimeout(() => ws.close(4002, "no hello"), 10_000);

  ws.on("pong", () => {
    live.alive = true;
    if (live.conn && live.pingAt) live.conn.rtt = Date.now() - live.pingAt;
  });

  ws.on("message", (raw) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    const node = getNode(id);
    if (!node) return ws.close(4001, "machine removed");
    const conn = live.conn;

    if (m.t === "hello") {
      if (conn) return;
      clearTimeout(helloTimer);
      const now = Date.now();
      const c: AgentConn = {
        id: node.id,
        version: str(m.version, 40),
        build: str(m.build, 40),
        arch: str(m.arch, 20),
        hostname: str(m.hostname, 100),
        connectedAt: now,
        skew: typeof m.now === "number" ? now - m.now : 0,
        rtt: null,
        lastReport: {},
        probeMs: 0,
        updateError: null,
        offered: null,
        pending: new Map(),
        send: (msg) => {
          if (ws.readyState !== ws.OPEN) return false;
          ws.send(JSON.stringify(msg));
          return true;
        },
        close: (code, reason) => {
          live.quiet = true;
          ws.close(code, reason);
        },
      };
      live.conn = c;
      const prev = registerAgent(c);
      if (prev) prev.close(4000, "replaced by a newer connection");
      const changed = node.agent.version !== c.version || node.agent.build !== c.build || node.agent.arch !== c.arch;
      recordAgent(node.id, { seen: now, version: c.version, build: c.build, arch: c.arch }, changed);
      const offered = sh.offers.get(node.id);
      if (offered && offered.build === c.build && node.agent.build !== c.build) {
        sh.offers.delete(node.id);
        logActivity({ source: "panel", kind: "panel.agent", actor: "fleet-agent", node: node.id, summary: `The agent updated itself to build ${c.build}`, detail: `version ${c.version}`, status: "ok" });
      } else if (!prev) {
        logConnection(node.id, `The agent connected (${c.version}, build ${c.build}, ${c.arch})`, `from ${ip}`);
      }
      live.pingAt = Date.now();
      ws.ping();
      offerUpdate(c);
      return;
    }
    if (!conn) return;

    switch (m.t) {
      case "report": {
        const r = toReport(m, conn.skew);
        if (!r) return;
        conn.lastReport[r.kind] = Date.now();
        ingestAgentReport(node, r);
        return;
      }
      case "backfill": {
        const reports = (Array.isArray(m.reports) ? m.reports : []).slice(0, 1000).map((x) => toReport(x as Record<string, unknown>, conn.skew)).filter((r): r is AgentReport => !!r);
        ingestBackfill(node, reports);
        return;
      }
      case "reply": {
        const r = toReport(m, conn.skew);
        if (!r) return;
        conn.lastReport[r.kind] = Date.now();
        resolveReply(conn, str(m.req, 40), r);
        return;
      }
      case "update-failed": {
        conn.updateError = str(m.error, 500) || "unknown error";
        logActivity({ source: "panel", kind: "panel.agent", actor: "fleet-agent", node: node.id, summary: `The agent couldn't update itself to build ${str(m.build, 40)}`, detail: conn.updateError, status: "error" });
        return;
      }
    }
  });

  ws.on("close", (code, reason) => {
    clearTimeout(helloTimer);
    lives.delete(live);
    const conn = live.conn;
    if (!conn) return;
    unregisterAgent(conn);
    const node = getNode(conn.id);
    if (node?.agent.installed) recordAgent(conn.id, { seen: Date.now() });
    if (!live.quiet && !agentConn(conn.id)) {
      logConnection(conn.id, "The agent disconnected; probing over ssh until it's back", `${code}${reason.length ? ` ${reason.toString()}` : ""}`);
    }
  });
  ws.on("error", () => {});
}
