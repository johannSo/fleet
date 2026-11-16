import { createHash, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { STATE_DIR, isLoopback } from "./net";

/**
 * Who may use the panel:
 * - requests from this machine to localhost need nothing (you're already here);
 * - everyone else needs a session cookie, obtained with the password or by
 *   scanning a one-time pairing QR code shown in an already signed-in panel.
 */

const AUTH_FILE = path.join(STATE_DIR, "auth.json");
export const COOKIE = "fleet_session";
const SESSION_DAYS = 180;

export interface Device {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
  ip: string;
  mobile?: boolean;
}

interface AuthState {
  passwordHash: string;
  passwordSalt: string;
  sessions: Record<string, Device>; // keyed by sha256(token)
}

let state: AuthState | null = null;
let dirty = false;

const WORDS =
  "amber anchor aurora basalt beacon birch cedar cinder cobalt comet coral crater dune ember fern fjord flint frost glade granite harbor hazel indigo iris juniper kelp lagoon lantern lichen lunar maple marble meadow mist nebula nova oak obsidian onyx orbit pebble pine prism quartz raven reef ridge river saffron sage sequoia shale sierra slate spruce storm summit tide topaz tundra umber valley violet willow zephyr".split(
    " ",
  );

function hashPassword(pw: string, salt: string) {
  return scryptSync(pw, salt, 32).toString("hex");
}

function save() {
  if (!state) return;
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2));
  chmodSync(AUTH_FILE, 0o600);
  dirty = false;
}
setInterval(() => dirty && save(), 30_000).unref();

/** A memorable random passphrase, e.g. "cobalt-fjord-ember-42". */
function newPassphrase() {
  const pick = () => WORDS[randomInt(WORDS.length)];
  return `${pick()}-${pick()}-${pick()}-${randomInt(10, 100)}`;
}

/** Loads auth state; on first run creates a password and returns it so it can be shown once. */
export function initAuth(): { createdPassword: string | null } {
  try {
    state = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  } catch {
    state = null;
  }
  const envPw = process.env.FLEET_PASSWORD;
  if (state && !envPw) return { createdPassword: null };
  const pw = envPw || newPassphrase();
  const salt = randomBytes(16).toString("hex");
  state = { passwordHash: hashPassword(pw, salt), passwordSalt: salt, sessions: state?.sessions ?? {} };
  save();
  return { createdPassword: envPw ? null : pw };
}

export function resetPassword(): string {
  const pw = newPassphrase();
  const salt = randomBytes(16).toString("hex");
  state = { passwordHash: hashPassword(pw, salt), passwordSalt: salt, sessions: state?.sessions ?? {} };
  save();
  return pw;
}

export function checkPassword(pw: string): boolean {
  if (!state) return false;
  const a = Buffer.from(hashPassword(pw, state.passwordSalt), "hex");
  const b = Buffer.from(state.passwordHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");

function deviceName(ua: string): string {
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? (ua.match(/Android [\d.]+; ([^;)]+?)(?: Build|\))/)?.[1]?.trim() ?? "Android")
        : /Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /Linux/.test(ua)
              ? "Linux"
              : "Device";
  const browser = /EdgA?\//.test(ua) ? "Edge" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /CriOS|Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "";
  return browser ? `${os} · ${browser}` : os;
}

export function createSession(req: IncomingMessage): string {
  const token = randomBytes(32).toString("base64url");
  const id = sha(token);
  state!.sessions[id] = {
    id: id.slice(0, 12),
    name: deviceName(String(req.headers["user-agent"] ?? "")),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    ip: clientIp(req),
    mobile: /Mobile|Android|iPhone|iPad/.test(String(req.headers["user-agent"] ?? "")),
  };
  save();
  return token;
}

export function destroySession(token: string) {
  if (state && delete state.sessions[sha(token)]) save();
}

export function revokeDevice(shortId: string) {
  if (!state) return;
  for (const [k, d] of Object.entries(state.sessions)) if (d.id === shortId) delete state.sessions[k];
  save();
}

export function listDevices(currentToken: string | null): (Device & { current: boolean })[] {
  const cur = currentToken ? sha(currentToken) : null;
  return Object.entries(state?.sessions ?? {})
    .map(([k, d]) => ({ ...d, current: k === cur }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

export function readCookie(req: IncomingMessage, name = COOKIE): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function clientIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

/** True for requests made on this machine to a loopback hostname. */
export function isLocalRequest(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  return isLoopback(req.socket.remoteAddress) && ["localhost", "127.0.0.1", "[::1]"].includes(host);
}

export function sessionFor(req: IncomingMessage): Device | null {
  const token = readCookie(req);
  if (!token || !state) return null;
  const d = state.sessions[sha(token)];
  if (!d) return null;
  if (Date.now() - d.lastSeen > SESSION_DAYS * 86_400_000) {
    delete state.sessions[sha(token)];
    dirty = true;
    return null;
  }
  if (Date.now() - d.lastSeen > 60_000) {
    d.lastSeen = Date.now();
    d.ip = clientIp(req);
    dirty = true;
  }
  return d;
}

export function isAuthed(req: IncomingMessage): boolean {
  return isLocalRequest(req) || sessionFor(req) !== null;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? "; Secure" : ""}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/* ---------------- one-time pairing codes ---------------- */

const pairCodes = new Map<string, number>();
const PAIR_TTL = 5 * 60_000;

export function newPairCode(): { code: string; expiresAt: number } {
  for (const [c, exp] of pairCodes) if (exp < Date.now()) pairCodes.delete(c);
  const code = randomBytes(18).toString("base64url");
  const expiresAt = Date.now() + PAIR_TTL;
  pairCodes.set(code, expiresAt);
  return { code, expiresAt };
}

export function consumePairCode(code: string): boolean {
  const exp = pairCodes.get(code);
  pairCodes.delete(code);
  return !!exp && exp > Date.now();
}

/* ---------------- login throttling ---------------- */

const attempts = new Map<string, { n: number; until: number }>();

/** Returns seconds to wait if this IP is locked out, else 0. */
export function loginLocked(ip: string): number {
  const a = attempts.get(ip);
  return a && a.until > Date.now() ? Math.ceil((a.until - Date.now()) / 1000) : 0;
}

export function loginFailed(ip: string) {
  const a = attempts.get(ip) ?? { n: 0, until: 0 };
  a.n += 1;
  // 5 free tries, then exponential back-off up to 15 minutes
  if (a.n >= 5) a.until = Date.now() + Math.min(15 * 60_000, 2 ** (a.n - 5) * 15_000);
  attempts.set(ip, a);
}

export function loginSucceeded(ip: string) {
  attempts.delete(ip);
}
