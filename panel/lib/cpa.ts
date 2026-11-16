/**
 * The AI proxy: CLIProxyAPI (proxy/cliproxyapi, built by proxy/install.sh) running as
 * the fleet-proxy.service user unit. The panel is its control panel: it talks to CPA's
 * Management API on localhost with a key that never leaves this machine, and drives the
 * service with systemctl.
 *
 * Only server.ts (and modules it imports) may use this.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { STATE_DIR } from "./net";

const run = promisify(execFile);

export const PROXY_DIR = path.join(STATE_DIR, "proxy");
export const PROXY_CONFIG = path.join(PROXY_DIR, "config.yaml");
const KEY_FILE = path.join(PROXY_DIR, "mgmt.key");
export const PROXY_UNIT = "fleet-proxy.service";

function managementKey(): string | null {
  try {
    return readFileSync(KEY_FILE, "utf8").trim() || null;
  } catch {
    return null;
  }
}

/** server.port and server.host from config.yaml, without a YAML parser: they're top-level scalars of `server:`. */
export function listenConfig(): { port: number; host: string } {
  let port = Number(process.env.PROXY_PORT || 8317);
  let host = "";
  try {
    const text = readFileSync(PROXY_CONFIG, "utf8");
    const block = text.match(/^server:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m)?.[1] ?? "";
    const p = block.match(/^[ \t]{1,4}port:\s*"?(\d+)/m)?.[1];
    const h = block.match(/^[ \t]{1,4}host:\s*"?([^"\s#]*)/m)?.[1];
    if (p) port = Number(p);
    if (h != null) host = h;
  } catch {
    /* not installed */
  }
  return { port, host };
}

export const baseUrl = () => `http://127.0.0.1:${listenConfig().port}`;

export class CpaError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface CpaResponse {
  status: number;
  headers: Headers;
  body: Buffer;
}

/** A Management API call. `api` picks /v8/management (default) or the legacy /v0/management. */
export async function management(method: string, pathAndQuery: string, body?: Buffer | string, contentType?: string, api: "v8" | "v0" = "v8"): Promise<CpaResponse> {
  const key = managementKey();
  if (!key) throw new CpaError(503, "The proxy isn't installed yet: run proxy/install.sh");
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (body != null) headers["content-type"] = contentType || "application/json";
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/${api}/management${pathAndQuery}`, {
      method,
      headers,
      body: body as BodyInit | undefined,
      signal: AbortSignal.timeout(method === "GET" ? 20_000 : 310_000),
    });
  } catch (err) {
    throw new CpaError(502, `The proxy isn't answering on ${baseUrl()} (${(err as Error).cause ? String((err as { cause: Error }).cause.message ?? (err as Error).cause) : (err as Error).message})`);
  }
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
}

/** Management call that expects JSON back. */
export async function mgmtJson<T = unknown>(method: string, p: string, body?: unknown): Promise<T> {
  const r = await management(method, p, body === undefined ? undefined : JSON.stringify(body));
  const text = r.body.toString("utf8");
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (r.status >= 400) {
    const msg = (data && typeof data === "object" && ((data as { error?: unknown }).error ?? (data as { message?: unknown }).message)) || text || `HTTP ${r.status}`;
    throw new CpaError(r.status, typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data as T;
}

/* ---------------- the service ---------------- */

export interface ServiceState {
  installed: boolean;
  active: string; // active, inactive, failed, activating…
  sub: string;
  pid: number | null;
  since: number | null;
  memory: number | null;
}

export async function serviceState(): Promise<ServiceState> {
  try {
    const { stdout } = await run("systemctl", ["--user", "show", PROXY_UNIT, "-p", "LoadState,ActiveState,SubState,MainPID,ActiveEnterTimestamp,MemoryCurrent", "--timestamp=unix"], { timeout: 5000 });
    const v = Object.fromEntries(
      stdout
        .trim()
        .split("\n")
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    const since = Number(String(v.ActiveEnterTimestamp ?? "").replace("@", ""));
    const mem = Number(v.MemoryCurrent);
    return {
      installed: v.LoadState === "loaded",
      active: v.ActiveState ?? "unknown",
      sub: v.SubState ?? "",
      pid: Number(v.MainPID) || null,
      since: since ? since * 1000 : null,
      memory: Number.isFinite(mem) && mem < 2 ** 60 ? mem : null,
    };
  } catch {
    return { installed: false, active: "unknown", sub: "", pid: null, since: null, memory: null };
  }
}

export async function serviceAction(action: "start" | "stop" | "restart"): Promise<void> {
  await run("systemctl", ["--user", action, PROXY_UNIT], { timeout: 30_000 });
}

/** Recent service output (startup errors land here, not in CPA's own log). */
export async function serviceJournal(lines = 200): Promise<string> {
  try {
    const { stdout } = await run("journalctl", ["--user", "-u", PROXY_UNIT, "-n", String(Math.min(2000, lines)), "--no-pager", "-o", "short-iso"], { timeout: 8000, maxBuffer: 8 << 20 });
    return stdout;
  } catch (err) {
    return String((err as Error).message);
  }
}

/* ---------------- client side of the proxy ---------------- */

/** A client API key from config, for the panel's own calls (model list, test prompts). */
async function clientKey(): Promise<string | null> {
  const keys = await mgmtJson<unknown>("GET", "/config/access/api-keys").catch(() => null);
  const list = Array.isArray(keys) ? keys : Array.isArray((keys as { value?: unknown })?.value) ? (keys as { value: unknown[] }).value : [];
  const k = list.map((x) => (typeof x === "string" ? x : String((x as { key?: string; "api-key"?: string })?.["api-key"] ?? (x as { key?: string })?.key ?? ""))).find(Boolean);
  return k || null;
}

export async function listModels(): Promise<{ id: string; owned_by?: string; created?: number }[]> {
  const key = await clientKey();
  if (!key) throw new CpaError(400, "Add an API key first");
  const res = await fetch(`${baseUrl()}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new CpaError(res.status, (await res.text()).slice(0, 500));
  const data = (await res.json()) as { data?: { id: string; owned_by?: string; created?: number }[] };
  return data.data ?? [];
}

/** One small chat completion through the proxy, the way a client would send it. */
export async function testPrompt(model: string, prompt: string): Promise<{ ok: boolean; status: number; ms: number; text: string; usage: unknown }> {
  const key = await clientKey();
  if (!key) throw new CpaError(400, "Add an API key first");
  const start = Date.now();
  const res = await fetch(`${baseUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 400, stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  const ms = Date.now() - start;
  const raw = await res.text();
  try {
    const data = JSON.parse(raw);
    if (!res.ok) return { ok: false, status: res.status, ms, text: data?.error?.message ?? raw, usage: null };
    return { ok: true, status: res.status, ms, text: data?.choices?.[0]?.message?.content ?? "", usage: data?.usage ?? null };
  } catch {
    return { ok: res.ok, status: res.status, ms, text: raw.slice(0, 2000), usage: null };
  }
}

export async function health(): Promise<{ ok: boolean; version: string | null; ms: number }> {
  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl()}/healthz`, { signal: AbortSignal.timeout(3000) });
    return { ok: res.ok, version: res.headers.get("x-cpa-version") ?? res.headers.get("x-cliproxyapi-version"), ms: Date.now() - start };
  } catch {
    return { ok: false, version: null, ms: Date.now() - start };
  }
}
