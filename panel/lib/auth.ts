import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { STATE_DIR, isLoopback } from "./net";
import { verifyTotp } from "./totp";

/**
 * Who may use the panel:
 * - requests from this machine to localhost need nothing (you're already here);
 * - everyone else needs a session cookie, obtained by signing in to the panel's
 *   one account (username, password and, if turned on, an authenticator code)
 *   or by scanning a one-time pairing QR code shown in an already signed-in panel.
 *
 * The account is created on first start, in the panel itself. Until it exists,
 * only this machine, an already signed-in device, or someone with the setup code
 * the panel prints when it starts can create it.
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

interface Account {
  username: string;
  passwordHash: string;
  passwordSalt: string;
  /** Authenticator-app secret (base32) and the last step a code was accepted for. */
  totp: { secret: string; usedStep: number } | null;
  createdAt: number;
}

interface AuthState {
  account: Account | null;
  sessions: Record<string, Device>; // keyed by sha256(token)
}

let state: AuthState = { account: null, sessions: {} };
let dirty = false;
/** Needed to create the account from another device while there is none; printed at startup. */
let setupCode: string | null = null;

export const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,31}$/;
export const MIN_PASSWORD = 10;

function hashPassword(pw: string, salt: string) {
  return scryptSync(pw, salt, 32).toString("hex");
}

function save() {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(AUTH_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(AUTH_FILE, 0o600);
  dirty = false;
}
setInterval(() => dirty && save(), 30_000).unref();

function makeAccount(username: string, password: string, totp: Account["totp"] = null): Account {
  const salt = randomBytes(16).toString("hex");
  return { username, passwordHash: hashPassword(password, salt), passwordSalt: salt, totp, createdAt: Date.now() };
}

/**
 * Loads auth state. Without an account it makes a setup code and returns it, so
 * the server can print it. FLEET_PASSWORD (and FLEET_USERNAME, default "admin")
 * creates the account, or resets its password, on every start.
 */
export function initAuth(): { setupCode: string | null } {
  let loaded: Partial<AuthState> & { passwordHash?: string } = {};
  try {
    loaded = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
  } catch {
    /* first start */
  }
  // Before accounts there was only a password; its devices stay signed in and the account gets made in the panel.
  state = { account: loaded.account ?? null, sessions: loaded.sessions ?? {} };
  const envPw = process.env.FLEET_PASSWORD;
  if (envPw) {
    const username = (process.env.FLEET_USERNAME || state.account?.username || "admin").trim();
    if (!USERNAME_RE.test(username)) throw new Error("FLEET_USERNAME: use letters, digits, dot, dash or underscore (at most 32)");
    state.account = makeAccount(username, envPw, state.account?.totp ?? null);
  }
  if (envPw || "passwordHash" in loaded) save();
  setupCode = state.account ? null : randomBytes(12).toString("base64url");
  return { setupCode };
}

export function hasAccount(): boolean {
  return state.account !== null;
}

export function accountInfo(): { username: string; totp: boolean; createdAt: number } | null {
  const a = state.account;
  return a ? { username: a.username, totp: !!a.totp, createdAt: a.createdAt } : null;
}

export function checkSetupCode(code: string): boolean {
  if (!setupCode || !code) return false;
  const a = Buffer.from(code.trim());
  const b = Buffer.from(setupCode);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Why a password won't do, or null. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters`;
  if (pw.length > 256) return "That password is too long (at most 256 characters)";
  return null;
}

export function createAccount(username: string, password: string) {
  if (state.account) throw new Error("There already is an account");
  state.account = makeAccount(username, password);
  setupCode = null;
  save();
}

function samePassword(a: Account, pw: string): boolean {
  const x = Buffer.from(hashPassword(pw, a.passwordSalt), "hex");
  const y = Buffer.from(a.passwordHash, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The account's password. */
export function checkPassword(pw: string): boolean {
  return !!state.account && samePassword(state.account, pw);
}

/** Username and password; the password is hashed even for a wrong username, so timing doesn't tell. */
export function checkLogin(username: string, pw: string): boolean {
  const a = state.account;
  if (!a) return false;
  const okPw = samePassword(a, pw);
  return okPw && username.trim().toLowerCase() === a.username.toLowerCase();
}

export function totpEnabled(): boolean {
  return !!state.account?.totp;
}

/** Checks an authenticator code for the account; each code works once. */
export function checkTotp(code: string): boolean {
  const t = state.account?.totp;
  if (!t) return false;
  const step = verifyTotp(t.secret, code, t.usedStep);
  if (step === null) return false;
  t.usedStep = step;
  save();
  return true;
}

/** Turns two-factor on with this secret (already confirmed with a code from that step), or off with null. */
export function setTotp(secret: string | null, usedStep = -1) {
  if (!state.account) throw new Error("No account");
  state.account.totp = secret ? { secret, usedStep } : null;
  save();
}

/** Sets a new password and signs out every device but the one with keepToken. */
export function changePassword(next: string, keepToken: string | null) {
  const a = state.account;
  if (!a) throw new Error("No account");
  state.account = { ...makeAccount(a.username, next, a.totp), createdAt: a.createdAt };
  const keep = keepToken ? sha(keepToken) : null;
  for (const k of Object.keys(state.sessions)) if (k !== keep) delete state.sessions[k];
  save();
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
  state.sessions[id] = {
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
  if (delete state.sessions[sha(token)]) save();
}

export function revokeDevice(shortId: string) {
  for (const [k, d] of Object.entries(state.sessions)) if (d.id === shortId) delete state.sessions[k];
  save();
}

export function listDevices(currentToken: string | null): (Device & { current: boolean })[] {
  const cur = currentToken ? sha(currentToken) : null;
  return Object.entries(state.sessions)
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
  if (!token) return null;
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
