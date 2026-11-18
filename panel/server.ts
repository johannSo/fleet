import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import next from "next";
import * as pty from "node-pty";
import QRCode from "qrcode";
import { WebSocketServer, type WebSocket } from "ws";
import { buildLaunch } from "./lib/actions";
import { handleAgentApi, handleAgentPublic, handleAgentUpgrade } from "./lib/agent-server";
import {
  accountInfo,
  changePassword,
  checkLogin,
  checkPassword,
  checkSetupCode,
  checkTotp,
  clearCookie,
  clientIp,
  consumePairCode,
  createSession as createAuthSession,
  createAccount,
  destroySession,
  hasAccount,
  initAuth,
  isAuthed,
  isLocalRequest,
  listDevices,
  loginFailed,
  loginLocked,
  loginSucceeded,
  newPairCode,
  passwordProblem,
  readCookie,
  revokeDevice,
  sessionCookie,
  sessionFor,
  setTotp,
  totpEnabled,
  USERNAME_RE,
} from "./lib/auth";
import { newTotpSecret, totpUri, verifyTotp } from "./lib/totp";
import { getNode, loadFleet, onFleetChange } from "./lib/fleet";
import { handleScripts } from "./lib/scripts";
import { handleInventory, handleSkillInstall, tokenAllows } from "./lib/inventory-api";
import { hostName, knownHostnames, lanAddresses } from "./lib/net";
import { CA_CERT, ensureCerts } from "./lib/tls";
import type { ClientMsg, ServerMsg, SessionInfo } from "./lib/types";
import type { ActivityQuery, ActivitySource } from "./lib/activity-types";
import { versionInfo } from "./lib/release";
import { CpaError, listModels, listenConfig, management, serviceAction, serviceJournal, serviceState, startSupervisedProxy, testPrompt } from "./lib/cpa";
import { onUsage, recentRequests, startUsageCollector, usageReport } from "./lib/cpa-usage";
import type { ProxyStatus, UsageRange, UsageSource } from "./lib/cpa-types";
import { importUsage, startUsageImporter, usageImportState } from "./lib/usage-import";
import { captureNow, onCapture, startProxyCapture } from "./lib/proxy-capture";
import { trafficModels, trafficPage, trafficRaw, trafficStatus } from "./lib/traffic";
import { activityNodes, appendTranscript, endTranscript, getActivity, logActivity, onActivity, queryActivity, readTranscript, updateActivity } from "./lib/audit";

const port = Number(process.env.PORT || 4747);
const tlsPort = Number(process.env.TLS_PORT ?? 4443);
// Reachable from the LAN; every non-local request must be signed in (see lib/auth.ts).
// Set HOST=127.0.0.1 to keep the panel on this machine only.
const host = process.env.HOST || "0.0.0.0";
const dev = process.env.NODE_ENV !== "production";
const extraHosts = (process.env.ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().replace(/:\d+$/, ""))
  .filter(Boolean);

function hostOf(value: string): string {
  // "box.local:4443" → "box.local", "[::1]:4747" → "[::1]"
  return value.toLowerCase().replace(/:\d+$/, "");
}

/** Blocks DNS rebinding (Host must be one of our own names) and cross-site requests (Origin must match Host). */
function trusted(req: IncomingMessage): boolean {
  const h = req.headers.host ?? "";
  if (!knownHostnames(extraHosts).has(hostOf(h))) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === h.toLowerCase();
  } catch {
    return false;
  }
}

/* ---------------- who did it ---------------- */

/** "iPhone · Safari (192.168.1.40)", "this machine", or just the IP. */
function actorOf(req: IncomingMessage): string {
  const device = sessionFor(req);
  const ip = clientIp(req);
  if (device) return `${device.name} (${ip})`;
  if (isLocalRequest(req)) return "this machine";
  return ip || "unknown";
}

const actors = new WeakMap<WebSocket, string>();
const actorFor = (ws: WebSocket) => actors.get(ws) ?? "unknown";

/* ---------------- terminal sessions ---------------- */

const MAX_BUFFER = 400_000;
const MAX_SESSIONS = 60;

interface Session {
  info: SessionInfo;
  proc: pty.IPty;
  buffer: string;
  clients: Set<WebSocket>;
  /** Activity log row for this session. */
  audit: number;
  /** What's been typed on the current line, for the activity log. */
  line: string;
  lineActor: string;
}

const ANSI_RE = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const SECRET_PROMPT = /(password|passphrase|passcode|\bpin\b|token|secret)[^\n]*[:?]\s*$/i;

function flushLine(s: Session) {
  const text = s.line;
  s.line = "";
  if (!text.trim()) return;
  // Passwords aren't echoed, so the screen still ends with the prompt that asked for one.
  const tail = s.buffer.slice(-300).replace(ANSI_RE, "").replace(/\r/g, "");
  const secret = SECRET_PROMPT.test(tail);
  logActivity({
    source: "terminal",
    kind: "terminal.input",
    actor: s.lineActor,
    node: s.info.node,
    summary: secret ? "•••••••• (answer to a password prompt, not logged)" : text,
    parent: s.audit,
    meta: secret ? { secret: true } : undefined,
  });
}

/** Rebuilds typed lines from raw keystrokes: handles backspace, Ctrl-C/U, arrows and pastes. */
function trackInput(s: Session, data: string, actor: string) {
  s.lineActor = actor;
  const clean = data
    .replace(/\x1b\[20[01]~/g, "")
    .replace(/\x1b(?:\[|O)A/g, "↑")
    .replace(/\x1b(?:\[|O)B/g, "↓")
    .replace(ANSI_RE, "");
  for (const ch of clean) {
    if (ch === "\r" || ch === "\n") flushLine(s);
    else if (ch === "\x7f" || ch === "\b") s.line = s.line.slice(0, -1);
    else if (ch === "\x15") s.line = "";
    else if (ch === "\x03" || ch === "\x04" || ch === "\x1a") {
      s.line += ch === "\x03" ? "^C" : ch === "\x04" ? "^D" : "^Z";
      flushLine(s);
    } else if (ch === "\t") s.line += "⇥";
    else if (ch >= " " || ch === "↑" || ch === "↓") s.line += ch;
    if (s.line.length > 20_000) flushLine(s);
  }
}

const sessions = new Map<string, Session>();
const sockets = new Set<WebSocket>();

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function list(): SessionInfo[] {
  return [...sessions.values()].map((s) => s.info).sort((a, b) => a.createdAt - b.createdAt);
}

function broadcastList() {
  const msg: ServerMsg = { t: "sessions", list: list() };
  for (const ws of sockets) send(ws, msg);
}

function prune() {
  if (sessions.size <= MAX_SESSIONS) return;
  for (const s of list()) {
    if (sessions.size <= MAX_SESSIONS) break;
    if (s.exited) sessions.delete(s.id);
  }
}

function createSession(ws: WebSocket, msg: Extract<ClientMsg, { t: "create" }>) {
  const node = getNode(msg.spec.node);
  if (!node) throw new Error(`Unknown node "${msg.spec.node}"`);
  const actor = actorFor(ws);
  let launch: ReturnType<typeof buildLaunch>;
  try {
    launch = buildLaunch(node, msg.spec, actor);
  } catch (err) {
    logActivity({
      source: "terminal",
      kind: `terminal.${msg.spec.action}`,
      actor,
      node: node.id,
      summary: `${msg.spec.action} refused`,
      detail: (err as Error).message,
      status: "error",
      meta: { params: msg.spec.params ?? {} },
    });
    throw err;
  }
  const proc = pty.spawn(launch.file, launch.args, {
    name: "xterm-256color",
    cols: Math.max(20, Math.min(500, msg.cols | 0)),
    rows: Math.max(5, Math.min(200, msg.rows | 0)),
    cwd: process.env.HOME,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" } as Record<string, string>,
  });
  const info: SessionInfo = {
    id: randomUUID(),
    node: node.id,
    action: msg.spec.action,
    spec: msg.spec,
    title: launch.title,
    command: launch.command,
    createdAt: Date.now(),
    exited: false,
    exitCode: null,
  };
  info.activityId = logActivity({
    source: "terminal",
    kind: `terminal.${msg.spec.action}`,
    actor,
    node: node.id,
    summary: launch.title,
    detail: launch.command,
    status: "running",
    ref: info.id,
    meta: { transcript: true, params: msg.spec.params ?? {} },
  });
  const session: Session = { info, proc, buffer: "", clients: new Set([ws]), audit: info.activityId, line: "", lineActor: actor };
  sessions.set(info.id, session);

  proc.onData((data) => {
    appendTranscript(session.audit, data);
    session.buffer += data;
    if (session.buffer.length > MAX_BUFFER) session.buffer = session.buffer.slice(-MAX_BUFFER);
    const out: ServerMsg = { t: "data", id: info.id, data };
    for (const c of session.clients) send(c, out);
  });
  proc.onExit(({ exitCode }) => {
    // node-pty can deliver the last chunk of output after the exit event;
    // give it a moment so the "exited" banner lands after the output.
    setTimeout(() => {
      info.exited = true;
      info.exitCode = exitCode;
      flushLine(session);
      endTranscript(session.audit);
      updateActivity(session.audit, { status: exitCode === 0 ? "ok" : "error", exitCode, ms: Date.now() - info.createdAt });
      const out: ServerMsg = { t: "exit", id: info.id, code: exitCode };
      for (const c of session.clients) send(c, out);
      broadcastList();
    }, 250);
  });

  send(ws, { t: "created", nonce: msg.nonce, session: info });
  prune();
  broadcastList();
}

function handle(ws: WebSocket, msg: ClientMsg) {
  switch (msg.t) {
    case "create":
      try {
        createSession(ws, msg);
      } catch (err) {
        send(ws, { t: "error", nonce: msg.nonce, message: (err as Error).message });
      }
      return;
    case "list":
      send(ws, { t: "sessions", list: list() });
      return;
  }
  const s = sessions.get(msg.id);
  if (!s) return;
  switch (msg.t) {
    case "attach":
      s.clients.add(ws);
      send(ws, { t: "replay", id: s.info.id, data: s.buffer });
      if (s.info.exited) send(ws, { t: "exit", id: s.info.id, code: s.info.exitCode });
      break;
    case "input":
      if (!s.info.exited) {
        trackInput(s, String(msg.data), actorFor(ws));
        s.proc.write(msg.data);
      }
      break;
    case "resize":
      if (!s.info.exited) {
        try {
          s.proc.resize(Math.max(20, Math.min(500, msg.cols | 0)), Math.max(5, Math.min(200, msg.rows | 0)));
        } catch {
          /* pty already gone */
        }
      }
      break;
    case "kill":
      if (!s.info.exited) {
        logActivity({ source: "terminal", kind: "terminal.kill", actor: actorFor(ws), node: s.info.node, summary: "Ended the session (SIGHUP)", parent: s.audit });
        s.proc.kill("SIGHUP");
      }
      break;
    case "close":
      if (!s.info.exited) {
        logActivity({ source: "terminal", kind: "terminal.kill", actor: actorFor(ws), node: s.info.node, summary: "Closed the tab, ending the session (SIGHUP)", parent: s.audit });
        s.proc.kill("SIGHUP");
      }
      sessions.delete(s.info.id);
      broadcastList();
      break;
  }
}

/* ---------------- auth endpoints ---------------- */

const PUBLIC_PREFIXES = ["/_next/", "/icons/", "/login", "/manifest.webmanifest", "/sw.js", "/offline.html", "/icon.svg", "/apple-icon.png", "/favicon.ico"];

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, limit = 8192): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error("too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** The request's JSON object, or null. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse((await readBody(req)) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Two-factor secrets shown to a device but not yet confirmed with a code, by session token. */
const pendingTotp = new Map<string, { secret: string; expires: number }>();

let tlsEnabled = false;

/** Addresses a phone could use, best first: the mDNS name, then LAN IPs. */
function phoneHosts(): string[] {
  return [`${hostName()}.local`, ...lanAddresses()];
}

async function qr(text: string) {
  return QRCode.toString(text, { type: "svg", margin: 4, errorCorrectionLevel: "M", color: { dark: "#16161e", light: "#ffffff" } });
}

async function handleAuth(req: IncomingMessage, res: ServerResponse, pathname: string, secure: boolean): Promise<boolean> {
  const method = req.method ?? "GET";

  if (pathname === "/ca.crt" && method === "GET") {
    if (!tlsEnabled) return json(res, 404, { error: "HTTPS is disabled" }), true;
    res.writeHead(200, {
      "content-type": "application/x-x509-ca-cert",
      "content-disposition": `attachment; filename="fleet-panel-${hostName()}.crt"`,
    });
    res.end(readFileSync(CA_CERT));
    return true;
  }

  if (pathname === "/pair" && method === "GET") {
    const code = new URL(req.url ?? "/", "http://x").searchParams.get("code") ?? "";
    if (!consumePairCode(code)) {
      logActivity({ source: "auth", kind: "auth.pair", actor: clientIp(req), summary: "Pairing failed: invalid or expired code", status: "error" });
      res.writeHead(302, { location: "/login?e=pair" });
      res.end();
      return true;
    }
    const token = createAuthSession(req);
    logActivity({ source: "auth", kind: "auth.pair", actor: `${clientIp(req)}`, summary: `Paired a new device: ${String(req.headers["user-agent"] ?? "").slice(0, 200)}`, status: "ok" });
    res.writeHead(302, { location: "/?paired=1", "set-cookie": sessionCookie(token, secure) });
    res.end();
    return true;
  }

  if (!pathname.startsWith("/api/auth/")) return false;

  if (pathname === "/api/auth/setup" && method === "POST") {
    const ip = clientIp(req);
    if (hasAccount()) return json(res, 409, { error: "The account already exists. Sign in instead." }), true;
    const wait = loginLocked(ip);
    if (wait) return json(res, 429, { error: `Too many attempts — try again in ${wait}s`, retryAfter: wait }), true;
    const b = await readJsonBody(req);
    if (!b) return json(res, 400, { error: "Bad request" }), true;
    // While there's no account, whoever reaches the panel first could claim it; so only this
    // machine, an already signed-in device, or someone with the printed setup code may.
    if (!isAuthed(req) && !checkSetupCode(str(b.setupCode))) {
      loginFailed(ip);
      logActivity({ source: "auth", kind: "auth.setup", actor: ip, summary: "Account setup refused: wrong setup code", status: "error" });
      return json(res, 403, { error: "That setup code isn't right. It's printed where the panel started (its terminal or `docker compose logs fleet`)." }), true;
    }
    const username = str(b.username).trim();
    const password = str(b.password);
    if (!USERNAME_RE.test(username)) return json(res, 400, { error: "Username: letters, digits, dot, dash or underscore, at most 32" }), true;
    const problem = passwordProblem(password);
    if (problem) return json(res, 400, { error: problem }), true;
    createAccount(username, password);
    loginSucceeded(ip);
    logActivity({ source: "auth", kind: "auth.setup", actor: actorOf(req), summary: `Created the panel account “${username}”`, status: "ok" });
    if (isLocalRequest(req) || sessionFor(req)) return json(res, 200, { ok: true }), true;
    return json(res, 200, { ok: true }, { "set-cookie": sessionCookie(createAuthSession(req), secure) }), true;
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    const ip = clientIp(req);
    if (!hasAccount()) return json(res, 409, { error: "There's no account yet. Create it first.", setup: true }), true;
    const wait = loginLocked(ip);
    if (wait) return json(res, 429, { error: `Too many attempts — try again in ${wait}s`, retryAfter: wait }), true;
    const b = await readJsonBody(req);
    if (!b) return json(res, 400, { error: "Bad request" }), true;
    if (!checkLogin(str(b.username), str(b.password))) {
      loginFailed(ip);
      logActivity({ source: "auth", kind: "auth.login", actor: ip, summary: "Sign-in failed: wrong username or password", status: "error" });
      return json(res, 401, { error: "Wrong username or password" }), true;
    }
    if (totpEnabled()) {
      const code = str(b.code);
      if (!code) return json(res, 401, { error: "Enter the 6-digit code from your authenticator app", needCode: true }), true;
      if (!checkTotp(code)) {
        loginFailed(ip);
        logActivity({ source: "auth", kind: "auth.login", actor: ip, summary: "Sign-in failed: wrong two-factor code", status: "error" });
        return json(res, 401, { error: "That code isn't right, or was already used. Wait for the next one.", needCode: true }), true;
      }
    }
    loginSucceeded(ip);
    const token = createAuthSession(req);
    logActivity({ source: "auth", kind: "auth.login", actor: ip, summary: `Signed in: ${String(req.headers["user-agent"] ?? "").slice(0, 200)}`, status: "ok" });
    return json(res, 200, { ok: true }, { "set-cookie": sessionCookie(token, secure) }), true;
  }

  if (pathname === "/api/auth/me" && method === "GET") {
    const device = sessionFor(req);
    return (
      json(res, 200, {
        authed: isAuthed(req),
        local: isLocalRequest(req),
        device,
        account: hasAccount(),
        username: isAuthed(req) ? (accountInfo()?.username ?? null) : null,
        totp: isAuthed(req) ? totpEnabled() : null,
        hostname: hostName(),
        tls: tlsEnabled ? { port: tlsPort } : null,
        port,
      }),
      true
    );
  }

  if (pathname === "/api/auth/logout" && method === "POST") {
    const token = readCookie(req);
    logActivity({ source: "auth", kind: "auth.logout", actor: actorOf(req), summary: "Signed out", status: "ok" });
    if (token) destroySession(token);
    return json(res, 200, { ok: true }, { "set-cookie": clearCookie() }), true;
  }

  // everything below needs a signed-in (or local) user
  if (!isAuthed(req)) return json(res, 401, { error: "Sign in first" }), true;

  if (pathname === "/api/auth/pair" && method === "POST") {
    const { code, expiresAt } = newPairCode();
    logActivity({ source: "auth", kind: "auth.pair-code", actor: actorOf(req), summary: "Created a pairing QR code", status: "info" });
    const hosts = await Promise.all(
      phoneHosts().map(async (h) => {
        const httpUrl = `http://${h}:${port}/pair?code=${code}`;
        const httpsUrl = tlsEnabled ? `https://${h}:${tlsPort}/pair?code=${code}` : null;
        const caUrl = tlsEnabled ? `http://${h}:${port}/ca.crt` : null;
        return {
          host: h,
          httpUrl,
          httpQr: await qr(httpUrl),
          httpsUrl,
          httpsQr: httpsUrl ? await qr(httpsUrl) : null,
          caUrl,
          caQr: caUrl ? await qr(caUrl) : null,
        };
      }),
    );
    return json(res, 200, { expiresAt, hosts, tls: tlsEnabled }), true;
  }

  if (pathname === "/api/auth/devices" && method === "GET") {
    return json(res, 200, { devices: listDevices(readCookie(req)) }), true;
  }

  if (pathname === "/api/auth/devices" && method === "DELETE") {
    const id = new URL(req.url ?? "/", "http://x").searchParams.get("id") ?? "";
    const gone = listDevices(null).find((d) => d.id === id);
    revokeDevice(id);
    logActivity({ source: "auth", kind: "auth.revoke", actor: actorOf(req), summary: `Signed out device ${gone ? `${gone.name} (${gone.ip})` : id}`, status: "ok" });
    return json(res, 200, { ok: true }), true;
  }

  /* Changing how you sign in needs the current password (not on this machine itself, which never signs in). */
  const stepUp = async (): Promise<{ b: Record<string, unknown> } | { error: number; msg: string }> => {
    const ip = clientIp(req);
    const wait = loginLocked(ip);
    if (wait) return { error: 429, msg: `Too many attempts — try again in ${wait}s` };
    const b = await readJsonBody(req);
    if (!b) return { error: 400, msg: "Bad request" };
    if (!hasAccount()) return { error: 409, msg: "Create the account first" };
    if (!isLocalRequest(req) && !checkPassword(str(b.password))) {
      loginFailed(ip);
      return { error: 403, msg: "That isn't the current password" };
    }
    return { b };
  };
  const pendingKey = readCookie(req) ?? "local";

  if (pathname === "/api/auth/password" && method === "POST") {
    const r = await stepUp();
    if ("error" in r) return json(res, r.error, { error: r.msg }), true;
    const next = str(r.b.next);
    const problem = passwordProblem(next);
    if (problem) return json(res, 400, { error: problem }), true;
    changePassword(next, readCookie(req));
    logActivity({ source: "auth", kind: "auth.password", actor: actorOf(req), summary: "Changed the panel password (other devices were signed out)", status: "ok" });
    return json(res, 200, { ok: true }), true;
  }

  if (pathname === "/api/auth/totp/start" && method === "POST") {
    if (!hasAccount()) return json(res, 409, { error: "Create the account first" }), true;
    const secret = newTotpSecret();
    for (const [k, p] of pendingTotp) if (p.expires < Date.now()) pendingTotp.delete(k);
    pendingTotp.set(pendingKey, { secret, expires: Date.now() + 10 * 60_000 });
    const uri = totpUri(secret, accountInfo()!.username, `Fleet (${hostName()})`);
    return json(res, 200, { secret, uri, qr: await qr(uri) }), true;
  }

  if (pathname === "/api/auth/totp/enable" && method === "POST") {
    const r = await stepUp();
    if ("error" in r) return json(res, r.error, { error: r.msg }), true;
    const pending = pendingTotp.get(pendingKey);
    if (!pending || pending.expires < Date.now()) return json(res, 410, { error: "That setup expired. Start again." }), true;
    const step = verifyTotp(pending.secret, str(r.b.code));
    if (step === null) return json(res, 400, { error: "That code isn't right. Check the app shows Fleet and try the newest code." }), true;
    pendingTotp.delete(pendingKey);
    setTotp(pending.secret, step);
    logActivity({ source: "auth", kind: "auth.totp", actor: actorOf(req), summary: "Turned on two-factor sign-in", status: "ok" });
    return json(res, 200, { ok: true }), true;
  }

  if (pathname === "/api/auth/totp/disable" && method === "POST") {
    const r = await stepUp();
    if ("error" in r) return json(res, r.error, { error: r.msg }), true;
    if (!totpEnabled()) return json(res, 200, { ok: true }), true;
    if (!isLocalRequest(req) && !checkTotp(str(r.b.code))) {
      loginFailed(clientIp(req));
      return json(res, 403, { error: "That code isn't right, or was already used" }), true;
    }
    setTotp(null);
    logActivity({ source: "auth", kind: "auth.totp", actor: actorOf(req), summary: "Turned off two-factor sign-in", status: "ok" });
    return json(res, 200, { ok: true }), true;
  }

  return json(res, 404, { error: "Not found" }), true;
}

/* ---------------- activity API ---------------- */

const SOURCES = new Set<ActivitySource>(["terminal", "ai", "panel", "auth", "proxy"]);

function handleActivity(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const { pathname, searchParams: sp } = url;
  if (!pathname.startsWith("/api/activity") || req.method !== "GET") return false;
  const t = pathname.match(/^\/api\/activity\/(\d+)\/transcript$/);
  if (t) {
    const text = readTranscript(Number(t[1]));
    if (text == null) return json(res, 404, { error: "No transcript for this session" }), true;
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
    return true;
  }
  const one = pathname.match(/^\/api\/activity\/(\d+)$/);
  if (one) {
    const e = getActivity(Number(one[1]));
    return e ? json(res, 200, e) : json(res, 404, { error: "Not found" }), true;
  }
  if (pathname !== "/api/activity") return json(res, 404, { error: "Not found" }), true;
  const num = (k: string) => (sp.get(k) && Number.isFinite(Number(sp.get(k))) ? Number(sp.get(k)) : undefined);
  const source = sp.get("source") as ActivitySource | null;
  const q: ActivityQuery = {
    node: sp.get("node") || undefined,
    source: source && SOURCES.has(source) ? source : undefined,
    q: sp.get("q")?.slice(0, 200) || undefined,
    before: num("before"),
    parent: num("parent"),
    limit: num("limit"),
  };
  return json(res, 200, { ...queryActivity(q), nodes: activityNodes() }), true;
}

/* ---------------- AI proxy (CLIProxyAPI) ---------------- */

function readRaw(req: IncomingMessage, limit = 4 << 20): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Tells every open panel to re-fetch proxy state. */
let proxyNotify: () => void = () => {};

/** A short line for the activity log for a change made through the Management API. */
function describeProxyChange(method: string, p: string, body: string): string | null {
  if (method === "GET") return null;
  const parsed = (() => {
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      return {} as Record<string, unknown>;
    }
  })();
  const name = typeof parsed.name === "string" ? parsed.name : Array.isArray(parsed.names) ? parsed.names.join(", ") : "";
  if (p.startsWith("/oauth/callback")) return "Submitted an OAuth sign-in redirect";
  if (p.startsWith("/oauth/session")) return "Cancelled a sign-in";
  if (p.startsWith("/oauth/import")) return "Imported a Vertex service account";
  if (p === "/credentials/status") return `${parsed.disabled ? "Disabled" : "Enabled"} account ${name}`;
  if (p === "/credentials/fields") return `Changed settings of account ${name}`;
  if (p === "/credentials/refresh") return parsed.all ? "Refreshed every account's token" : `Refreshed the token of ${name}`;
  if (p === "/credentials/verify") return `Verified account ${name}`;
  if (p.startsWith("/credentials") && method === "DELETE") return name ? `Removed account ${name}` : "Removed accounts";
  if (p.startsWith("/credentials") && method === "POST") return "Uploaded account files";
  if (p === "/routing/cooldown/reset") return "Reset an account's cooldown";
  if (p === "/config/access/api-keys") return "Changed the proxy's API keys";
  if (p.startsWith("/config/api-keys")) return `Changed upstream keys (${p.split("/").slice(3).join(" ") || "all"})`;
  if (p.startsWith("/config/oauth/model-alias")) return "Changed model aliases";
  if (p.startsWith("/config/oauth/excluded-models")) return "Changed excluded models";
  if (p === "/config.yaml") return "Replaced the proxy's config.yaml";
  if (p.startsWith("/config")) return `Changed proxy setting ${p.replace(/^\/config\/?/, "") || "(several)"}`;
  if (p.startsWith("/observability/logs")) return "Cleared the proxy logs";
  if (p.startsWith("/requests/api-call")) return null; // quota checks: read-only in effect
  return `${method} ${p}`;
}

/** Latest CLIProxyAPI release: CPA asks GitHub for it, so ask at most every 6 hours. */
let latestRelease: { at: number; value: string | null } = { at: 0, value: null };
async function latestVersion(): Promise<string | null> {
  if (Date.now() - latestRelease.at < 6 * 3_600_000) return latestRelease.value;
  latestRelease = { at: Date.now(), value: latestRelease.value };
  try {
    const r = await management("GET", "/server/latest-version");
    if (r.status < 400) latestRelease.value = (JSON.parse(r.body.toString()) as Record<string, string>)["latest-version"] ?? null;
  } catch {
    /* offline: keep the last answer */
  }
  return latestRelease.value;
}

async function proxyStatus(): Promise<ProxyStatus> {
  const service = await serviceState();
  const { port } = listenConfig();
  let reachable = false;
  let version: string | null = null;
  let error: string | null = null;
  try {
    // any management response carries the version; this one is cheap and always present
    const r = await management("GET", "/config/config-version");
    reachable = r.status < 500;
    version = r.headers.get("x-cpa-version");
    if (r.status === 401 || r.status === 403) error = "The panel's management key was rejected (mgmt.key doesn't match config.yaml)";
  } catch (err) {
    error = (err as Error).message;
  }
  const latest = reachable ? await latestVersion() : latestRelease.value;
  const urls = [`http://${hostName()}.local:${port}`, ...lanAddresses().map((a) => `http://${a}:${port}`), `http://localhost:${port}`];
  return { service, reachable, version, latest, port, urls, error };
}

async function handleProxy(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const { pathname, searchParams: sp } = url;
  if (!pathname.startsWith("/api/proxy/")) return false;
  const method = req.method ?? "GET";
  const sub = pathname.slice("/api/proxy".length);
  try {
    if (sub === "/status" && method === "GET") return json(res, 200, await proxyStatus()), true;

    if (sub === "/service" && method === "POST") {
      const action = String(JSON.parse((await readRaw(req, 4096)).toString() || "{}").action ?? "");
      if (action !== "start" && action !== "stop" && action !== "restart") return json(res, 400, { error: "Bad action" }), true;
      const start = Date.now();
      try {
        await serviceAction(action);
        logActivity({ source: "proxy", kind: `proxy.${action}`, actor: actorOf(req), summary: `${action[0].toUpperCase()}${action.slice(1)}ed the AI proxy`.replace("Stoped", "Stopped"), status: "ok", ms: Date.now() - start });
      } catch (err) {
        logActivity({ source: "proxy", kind: `proxy.${action}`, actor: actorOf(req), summary: `Couldn't ${action} the AI proxy`, detail: (err as Error).message, status: "error" });
        throw err;
      }
      proxyNotify();
      return json(res, 200, { ok: true }), true;
    }

    if (sub === "/journal" && method === "GET") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(await serviceJournal(Number(sp.get("lines")) || 300));
      return true;
    }

    if (sub === "/models" && method === "GET") return json(res, 200, { models: await listModels() }), true;

    if (sub === "/test" && method === "POST") {
      const b = JSON.parse((await readRaw(req, 64_000)).toString() || "{}");
      const model = String(b.model ?? "");
      const prompt = String(b.prompt ?? "").slice(0, 4000) || "Say hi in five words.";
      if (!model) return json(res, 400, { error: "Pick a model" }), true;
      const r = await testPrompt(model, prompt);
      logActivity({ source: "proxy", kind: "proxy.test", actor: actorOf(req), summary: `Test prompt to ${model}`, detail: `${prompt}\n\n→ ${r.text}`.slice(0, 8000), status: r.ok ? "ok" : "error", ms: r.ms, meta: { http: r.status } });
      return json(res, 200, r), true;
    }

    const usageSource = (): UsageSource => (["all", "proxy", "claude-code", "codex"].includes(sp.get("source") ?? "") ? sp.get("source") : "all") as UsageSource;

    if (sub === "/usage" && method === "GET") {
      const range = (["24h", "7d", "30d", "all"].includes(sp.get("range") ?? "") ? sp.get("range") : "24h") as UsageRange;
      return json(res, 200, usageReport(range, usageSource())), true;
    }

    // Usage from the other machines' Claude Code, Codex and CLIProxyAPI logs (lib/usage-import.ts).
    if (sub === "/usage/import" && method === "GET") return json(res, 200, usageImportState()), true;
    if (sub === "/usage/import" && method === "POST") {
      const machines = await importUsage();
      proxyNotify();
      return json(res, 200, { running: false, machines }), true;
    }

    if (sub === "/requests" && method === "GET") {
      const num = (k: string) => (sp.get(k) && Number.isFinite(Number(sp.get(k))) ? Number(sp.get(k)) : undefined);
      return (
        json(
          res,
          200,
          recentRequests({
            limit: num("limit"),
            before: num("before"),
            beforeId: num("beforeId"),
            failed: sp.get("failed") === "1",
            model: sp.get("model") || undefined,
            q: sp.get("q")?.slice(0, 200) || undefined,
            source: usageSource(),
          }),
        ),
        true
      );
    }

    // Traffic: every proxied request in full, from ClickHouse (lib/proxy-capture.ts, lib/traffic.ts).
    if (sub === "/traffic/status" && method === "GET") return json(res, 200, await trafficStatus()), true;
    if (sub === "/traffic/models" && method === "GET") return json(res, 200, { models: await trafficModels() }), true;
    if (sub === "/traffic/capture" && method === "POST") {
      await captureNow();
      return json(res, 200, { ok: true }), true;
    }
    if (sub === "/traffic/raw" && method === "GET") {
      const raw = await trafficRaw(sp.get("machine") ?? "", sp.get("file") ?? "");
      if (raw == null) return json(res, 404, { error: "Not in the AI log" }), true;
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(raw);
      return true;
    }
    if (sub === "/traffic" && method === "GET") {
      const num = (k: string) => (sp.get(k) && Number.isFinite(Number(sp.get(k))) ? Number(sp.get(k)) : undefined);
      return (
        json(
          res,
          200,
          await trafficPage({
            limit: num("limit"),
            before: num("before"),
            beforeFile: sp.get("beforeFile") ?? undefined,
            after: num("after"),
            q: sp.get("q")?.slice(0, 500) || undefined,
            model: sp.get("model") || undefined,
            failed: sp.get("failed") === "1",
          }),
        ),
        true
      );
    }

    // Management API passthrough: /api/proxy/m/<v8 path> and /api/proxy/v0/<v0 path>.
    const m = sub.match(/^\/(m|v0)(\/.*)$/);
    if (m) {
      const api = m[1] === "v0" ? "v0" : "v8";
      const target = m[2];
      if (target.startsWith("/oauth/callback") && method === "GET") return json(res, 405, { error: "POST the redirect URL instead" }), true;
      const body = method === "GET" || method === "HEAD" ? undefined : await readRaw(req);
      const r = await management(method, `${target}${url.search}`, body, req.headers["content-type"], api);
      const summary = r.status < 400 ? describeProxyChange(method, target, body?.toString("utf8").slice(0, 20_000) ?? "") : null;
      if (summary) {
        logActivity({ source: "proxy", kind: `proxy.${target.split("/")[1] || "config"}`, actor: actorOf(req), summary, status: "ok", meta: { method, path: target } });
        proxyNotify();
      }
      const headers: Record<string, string> = { "cache-control": "no-store", "content-type": r.headers.get("content-type") ?? "application/octet-stream" };
      const cd = r.headers.get("content-disposition");
      if (cd) headers["content-disposition"] = cd;
      const v = r.headers.get("x-cpa-version");
      if (v) headers["x-cpa-version"] = v;
      res.writeHead(r.status, headers);
      res.end(r.body);
      return true;
    }
    return json(res, 404, { error: "Not found" }), true;
  } catch (err) {
    const status = err instanceof CpaError ? err.status : 500;
    return json(res, status, { error: (err as Error).message }), true;
  }
}

/** Logs panel buttons that act on machines; they're Next route handlers, so watch them from here. */
function watchPanelAction(req: IncomingMessage, res: ServerResponse, url: URL) {
  const m = url.pathname.match(/^\/api\/nodes\/([^/]+)\/(wake|updates|probe)$/);
  if (!m) return;
  const [, node, what] = m;
  if (what === "wake" && req.method !== "POST") return;
  if (what === "updates" && url.searchParams.get("force") !== "1") return;
  const actor = actorOf(req);
  const start = Date.now();
  const summary = what === "wake" ? "Sent Wake-on-LAN magic packet" : what === "updates" ? "Checked for updates" : "Re-checked the machine";
  res.on("finish", () =>
    logActivity({
      source: "panel",
      kind: `panel.${what}`,
      actor,
      node: decodeURIComponent(node),
      summary: res.statusCode < 400 ? summary : `${summary.replace(/^Sent /, "")} failed (HTTP ${res.statusCode})`,
      status: res.statusCode < 400 ? "ok" : "error",
      ms: Date.now() - start,
      meta: { http: res.statusCode },
    }),
  );
}

/* ---------------- http ---------------- */

const { setupCode } = initAuth();
const app = next({ dev, hostname: "localhost", port });
const nextHandle = app.getRequestHandler();

app.prepare().then(() => {
  const upgradeNext = app.getUpgradeHandler();

  const handler = (secure: boolean) => async (req: IncomingMessage, res: ServerResponse) => {
    if (!trusted(req)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden: untrusted Host or Origin\n");
      return;
    }
    // The pairing code rides in a URL, so never leak URLs via Referer; never allow framing.
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("x-content-type-options", "nosniff");

    const url = new URL(req.url ?? "/", "http://x");
    const pathname = url.pathname;
    try {
      if (await handleAuth(req, res, pathname, secure)) return;
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
      return;
    }

    // The Claude skill's token opens the inventory API, and nothing else.
    // fleet-agent's installer and binary downloads carry their own one-time code or machine token.
    try {
      if (handleAgentPublic(req, res, url)) return;
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
      return;
    }

    const viaToken = !isAuthed(req) && tokenAllows(req, pathname);
    const actor = viaToken ? `Claude skill (${clientIp(req)})` : actorOf(req);
    if (handleSkillInstall(req, res, url, { actor, port })) return;

    const authed = isAuthed(req) || viaToken;
    const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`) || pathname.startsWith(`${p}?`));
    if (pathname === "/login" && authed && hasAccount()) {
      res.writeHead(302, { location: "/" });
      res.end();
      return;
    }
    if (!authed && !isPublic && !(dev && pathname.startsWith("/__nextjs"))) {
      const wantsHtml = req.method === "GET" && (req.headers.accept ?? "").includes("text/html");
      if (wantsHtml) {
        res.writeHead(302, { location: `/login?next=${encodeURIComponent(req.url ?? "/")}` });
        res.end();
      } else {
        json(res, 401, { error: "Sign in first" });
      }
      return;
    }
    if (await handleInventory(req, res, url, { actor, port, viaToken })) return;
    if (viaToken) return json(res, 401, { error: "Sign in first" });
    if (handleAgentApi(req, res, url, actor)) return;
    if (await handleScripts(req, res, url, actor)) return;
    if (await handleProxy(req, res, url)) return;
    if (pathname === "/api/version" && req.method === "GET") return json(res, 200, await versionInfo());
    try {
      if (handleActivity(req, res, url)) return;
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
      return;
    }
    watchPanelAction(req, res, url);
    nextHandle(req, res);
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  onActivity((event) => {
    const msg: ServerMsg = { t: "activity", event };
    for (const ws of sockets) send(ws, msg);
  });
  // AI proxy: collect usage, and tell open panels when something changed.
  let proxyTimer: ReturnType<typeof setTimeout> | null = null;
  proxyNotify = () => {
    if (proxyTimer) return;
    proxyTimer = setTimeout(() => {
      proxyTimer = null;
      for (const ws of sockets) send(ws, { t: "proxy" });
    }, 300);
  };
  onUsage(() => proxyNotify());
  startUsageCollector();
  startUsageImporter();
  onCapture(() => proxyNotify());
  startProxyCapture();

  // Push inventory changes (edits, new machines, fresh indexes) to every open panel.
  onFleetChange(() => {
    for (const ws of sockets) send(ws, { t: "fleet" });
  });

  wss.on("connection", (ws, req: IncomingMessage) => {
    actors.set(ws, actorOf(req));
    sockets.add(ws);
    send(ws, { t: "sessions", list: list() });
    ws.on("message", (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      handle(ws, msg);
    });
    ws.on("close", () => {
      sockets.delete(ws);
      for (const s of sessions.values()) s.clients.delete(ws);
    });
  });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const { pathname } = new URL(req.url ?? "/", "http://x");
    // fleet-agent: authenticated by its machine token, not a session (lib/agent-server.ts).
    if (pathname === "/ws/agent") {
      if (!trusted(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      handleAgentUpgrade(req, socket, head);
      return;
    }
    if (pathname === "/ws") {
      if (!trusted(req) || !isAuthed(req)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return;
    }
    // Let Next handle its own HMR socket in dev.
    if (dev && trusted(req)) upgradeNext(req, socket, head);
    else socket.destroy();
  };

  startSupervisedProxy();
  const server = createServer(handler(false));
  server.on("upgrade", onUpgrade);
  server.listen(port, host);

  const local = loadFleet().find((n) => n.local);
  const certs = tlsPort ? ensureCerts(local?.ips.map((i) => i.value) ?? []) : null;
  if (certs) {
    tlsEnabled = true;
    const tls = createHttpsServer({ key: certs.key, cert: certs.cert }, handler(true));
    tls.on("upgrade", onUpgrade);
    tls.listen(tlsPort, host);
  }

  const lan = lanAddresses();
  const lines = [
    "",
    `  ▲ fleet control panel (${dev ? "dev" : "production"})`,
    `    this machine   http://localhost:${port}`,
    ...(host === "127.0.0.1" || host === "localhost"
      ? ["    LAN            off (HOST=127.0.0.1)"]
      : [
          ...lan.map((a) => `    LAN            http://${a}:${port}${certs ? `   ·   https://${a}:${tlsPort}` : ""}`),
          `    mDNS           http://${hostName()}.local:${port}${certs ? `   ·   https://${hostName()}.local:${tlsPort}` : ""}`,
        ]),
    ...(setupCode
      ? [
          "",
          "    No account yet. Create it in the panel: on this machine at",
          `    http://localhost:${port}/login, or from another device with this setup code:`,
          `    setup code     ${setupCode}`,
        ]
      : []),
    "",
  ];
  console.log(lines.join("\n"));
});
