/**
 * ClickHouse for the AI log. It runs in Docker on a fleet machine (see
 * ../clickhouse/install.sh) and listens on that machine's loopback only, so the panel
 * keeps an ssh tunnel to it. Connection details come from $STATE_DIR/clickhouse.json,
 * which install.sh writes; without that file the AI log is simply off.
 *
 * Only server.ts (and modules it imports) may use this.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { getNode } from "./fleet";
import { STATE_DIR } from "./net";
import { sshDest } from "./ssh";

interface ChConfig {
  machine: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

const CONF_FILE = path.join(STATE_DIR, "clickhouse.json");

export function chConfig(): ChConfig | null {
  try {
    const c = JSON.parse(readFileSync(CONF_FILE, "utf8"));
    if (!c.machine || !c.password) return null;
    return { machine: String(c.machine), port: Number(c.port) || 8123, user: String(c.user || "fleet"), password: String(c.password), database: String(c.database || "ai") };
  } catch {
    return null;
  }
}

/* ---------------- tunnel ---------------- */

let tunnel: { child: ChildProcess; port: number; ready: Promise<void> } | null = null;
let lastTunnelError: string | null = null;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = (srv.address() as { port: number }).port;
      srv.close(() => resolve(p));
    });
  });
}

/** Base URL of ClickHouse's HTTP interface: direct when it runs here, else through the tunnel. */
async function endpoint(c: ChConfig): Promise<string> {
  const node = getNode(c.machine);
  if (!node) throw new Error(`Machine "${c.machine}" from clickhouse.json isn't in the inventory`);
  if (node.local) return `http://127.0.0.1:${c.port}`;
  if (!node.sshTarget) throw new Error(`No connection set up for ${c.machine}`);
  if (tunnel && tunnel.child.exitCode == null && !tunnel.child.killed) {
    await tunnel.ready;
    return `http://127.0.0.1:${tunnel.port}`;
  }
  const port = await freePort();
  const child = spawn(
    "ssh",
    [
      "-N", "-T",
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=6",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=15",
      "-o", "ServerAliveCountMax=3",
      "-o", "ControlPath=none",
      "-o", "StrictHostKeyChecking=accept-new",
      "-L", `127.0.0.1:${port}:127.0.0.1:${c.port}`,
      ...sshDest(node),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
  const t = {
    child,
    port,
    ready: new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = async () => {
        if (child.exitCode != null) return reject(new Error(stderr.trim().split("\n").pop() || "ssh tunnel to ClickHouse exited"));
        try {
          const r = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(1500) });
          if (r.ok) return resolve();
        } catch {
          /* not forwarding yet */
        }
        if (Date.now() - started > 15_000) {
          child.kill();
          return reject(new Error("ssh tunnel to ClickHouse didn't come up"));
        }
        setTimeout(poll, 300);
      };
      poll();
    }),
  };
  child.on("exit", () => {
    if (tunnel === t) tunnel = null;
  });
  t.ready.catch((e) => (lastTunnelError = (e as Error).message));
  tunnel = t;
  await t.ready;
  lastTunnelError = null;
  return `http://127.0.0.1:${port}`;
}

export function closeClickhouse() {
  tunnel?.child.kill();
  tunnel = null;
}

/* ---------------- queries ---------------- */

export type ChParams = Record<string, string | number | boolean>;

async function call(sql: string, { body, params, timeoutMs = 30_000 }: { body?: string; params?: ChParams; timeoutMs?: number } = {}): Promise<string> {
  const c = chConfig();
  if (!c) throw new Error("ClickHouse isn't set up (run clickhouse/install.sh)");
  const base = await endpoint(c);
  const qs = new URLSearchParams({ database: c.database });
  for (const [k, v] of Object.entries(params ?? {})) qs.set(`param_${k}`, String(v));
  let init: RequestInit;
  if (body != null) {
    qs.set("query", sql);
    init = { method: "POST", body };
  } else {
    init = { method: "POST", body: sql };
  }
  const r = await fetch(`${base}/?${qs}`, {
    ...init,
    headers: { "X-ClickHouse-User": c.user, "X-ClickHouse-Key": c.password, "Content-Type": "text/plain; charset=utf-8" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text.trim().split("\n")[0].slice(0, 500) || `ClickHouse HTTP ${r.status}`);
  return text;
}

/** Runs a SELECT and returns its rows. Use `{name:Type}` placeholders with `params`, never string concatenation. */
export async function chQuery<T>(sql: string, params?: ChParams): Promise<T[]> {
  const text = await call(`${sql} FORMAT JSONEachRow`, { params });
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

export async function chExec(sql: string, params?: ChParams): Promise<void> {
  await call(sql, { params });
}

export async function chInsert(table: string, rows: object[]): Promise<void> {
  if (!rows.length) return;
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("bad table name");
  await call(`INSERT INTO ${table} SETTINGS date_time_input_format = 'best_effort' FORMAT JSONEachRow`, {
    body: rows.map((r) => JSON.stringify(r)).join("\n"),
    timeoutMs: 120_000,
  });
}

/* ---------------- schema ---------------- */

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS proxy_requests (
    ts            DateTime64(3, 'UTC'),
    end_ts        DateTime64(3, 'UTC'),
    machine       LowCardinality(String),
    file          String,
    request_id    String,
    url           LowCardinality(String),
    method        LowCardinality(String),
    status        UInt16,
    model         LowCardinality(String),
    stream        Bool,
    provider      LowCardinality(String),
    account       LowCardinality(String),
    attempts      UInt8,
    user_agent    String,
    key_preview   LowCardinality(String),
    input_tokens  UInt32,
    output_tokens UInt32,
    prompt        String CODEC(ZSTD(3)),
    answer        String CODEC(ZSTD(3)),
    raw           String CODEC(ZSTD(6)),
    bytes         UInt32,
    ingested_at   DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX raw_tokens raw TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 1
  )
  ENGINE = ReplacingMergeTree(ingested_at)
  PARTITION BY toYYYYMM(ts)
  ORDER BY (machine, ts, file)`,
];

let schemaReady: Promise<void> | null = null;

export function ensureSchema(): Promise<void> {
  schemaReady ??= (async () => {
    for (const s of SCHEMA) await chExec(s);
  })().catch((e) => {
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

export interface ChStatus {
  configured: boolean;
  machine: string | null;
  reachable: boolean;
  version: string | null;
  error: string | null;
}

export async function chStatus(): Promise<ChStatus> {
  const c = chConfig();
  if (!c) return { configured: false, machine: null, reachable: false, version: null, error: null };
  try {
    const [v] = await chQuery<{ v: string }>("SELECT version() AS v");
    return { configured: true, machine: c.machine, reachable: true, version: v?.v ?? null, error: null };
  } catch (e) {
    return { configured: true, machine: c.machine, reachable: false, version: null, error: lastTunnelError ?? (e as Error).message };
  }
}
