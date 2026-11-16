/**
 * Ships every request the AI proxy handles into ClickHouse (lib/clickhouse.ts), in full:
 * the client's request, each upstream attempt and the answer, as CLIProxyAPI writes them
 * with `request-log: true` (one file per request in its logs directory).
 *
 * A file is shipped once it has stopped changing; it's remembered as captured only after
 * ClickHouse accepted it, so nothing is lost while ClickHouse or the tunnel is down. The
 * files themselves stay where they are (CLIProxyAPI's size limit prunes them, and the
 * Usage page still reads them).
 *
 * Only server.ts (and modules it imports) may use this.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PROXY_CONFIG, PROXY_DIR } from "./cpa";
import { chConfig, chInsert, ensureSchema } from "./clickhouse";
import { loadFleet } from "./fleet";
import { parseLog } from "./proxy-log";

/** A file is complete once it hasn't changed for this long (CLIProxyAPI writes it in one go at the end). */
const SETTLE_MS = 2_500;
const BATCH_BYTES = 16 << 20;
const MAX_RAW = 48 << 20;

mkdirSync(PROXY_DIR, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(PROXY_DIR, "capture.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS captured (
    name  TEXT PRIMARY KEY,
    size  INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    at    INTEGER NOT NULL
  );
`);
const isCaptured = db.prepare("SELECT 1 FROM captured WHERE name = ? AND size = ? AND mtime = ?");
const markCaptured = db.prepare("INSERT OR REPLACE INTO captured (name, size, mtime, at) VALUES (?, ?, ?, ?)");

/** Where CLIProxyAPI writes its logs: ./logs next to its config if that exists, else <auth-dir>/logs. */
export function proxyLogsDir(): string {
  const local = path.join(PROXY_DIR, "logs");
  if (existsSync(local)) return local;
  try {
    const m = readFileSync(PROXY_CONFIG, "utf8").match(/^\s+auth-dir:\s*"?([^"\n#]+?)"?\s*$/m);
    if (m) return path.join(m[1].replace(/^~(?=\/)/, process.env.HOME ?? "~"), "logs");
  } catch {
    /* no config */
  }
  return path.join(PROXY_DIR, "auths", "logs");
}

const isRequestLog = (f: string) => f.endsWith(".log") && !/^main(-|\.)/.test(f);

function localMachine(): string {
  try {
    return loadFleet().find((n) => n.local)?.id ?? "local";
  } catch {
    return "local";
  }
}

export interface CaptureStatus {
  enabled: boolean;
  dir: string;
  pending: number;
  captured: number;
  lastAt: number | null;
  lastError: string | null;
}

const state = { pending: 0, lastAt: null as number | null, lastError: null as string | null };
let listener: (() => void) | null = null;
export function onCapture(fn: () => void) {
  listener = fn;
}

export function captureStatus(): CaptureStatus {
  const { n } = db.prepare("SELECT count(*) AS n FROM captured").get() as { n: number };
  return { enabled: !!chConfig(), dir: proxyLogsDir(), pending: state.pending, captured: n, lastAt: state.lastAt, lastError: state.lastError };
}

let running = false;
let again = false;

async function tick() {
  if (running) {
    again = true;
    return;
  }
  if (!chConfig()) return;
  running = true;
  try {
    do {
      again = false;
      await shipReady();
    } while (again);
  } finally {
    running = false;
  }
}

async function shipReady() {
  const dir = proxyLogsDir();
  let names: string[];
  try {
    names = readdirSync(dir).filter(isRequestLog);
  } catch {
    return; // no logs yet
  }
  const now = Date.now();
  const todo: { name: string; size: number; mtime: number }[] = [];
  for (const name of names) {
    let st;
    try {
      st = statSync(path.join(dir, name));
    } catch {
      continue; // pruned meanwhile
    }
    const mtime = Math.floor(st.mtimeMs);
    if (now - mtime < SETTLE_MS) continue;
    if (isCaptured.get(name, st.size, mtime)) continue;
    todo.push({ name, size: st.size, mtime });
  }
  state.pending = todo.length;
  if (!todo.length) return;
  todo.sort((a, b) => a.mtime - b.mtime);
  await ensureSchema();

  const machine = localMachine();
  let batch: { row: object; f: (typeof todo)[number] }[] = [];
  let bytes = 0;
  const flush = async () => {
    if (!batch.length) return;
    await chInsert("proxy_requests", batch.map((b) => b.row));
    const at = Date.now();
    db.exec("BEGIN");
    for (const { f } of batch) markCaptured.run(f.name, f.size, f.mtime, at);
    db.exec("COMMIT");
    state.pending -= batch.length;
    state.lastAt = at;
    batch = [];
    bytes = 0;
    listener?.();
  };

  try {
    for (const f of todo) {
      let raw: string;
      try {
        raw = readFileSync(path.join(dir, f.name), "utf8");
      } catch {
        continue;
      }
      if (raw.length > MAX_RAW) raw = `${raw.slice(0, MAX_RAW)}\n\n[… cut by the panel: the log was ${(f.size / 1048576).toFixed(0)} MB]`;
      const p = parseLog(raw);
      batch.push({
        f,
        row: {
          ts: new Date(p.ts || f.mtime).toISOString(),
          end_ts: new Date(f.mtime).toISOString(),
          machine,
          file: f.name,
          request_id: p.requestId || f.name.match(/-([0-9a-f]{8})\.log$/)?.[1] || "",
          url: p.url,
          method: p.method,
          status: p.status,
          model: p.model,
          stream: p.stream,
          provider: p.provider,
          account: p.account,
          attempts: Math.min(255, p.attempts),
          user_agent: p.userAgent,
          key_preview: p.key,
          input_tokens: p.input,
          output_tokens: p.output,
          prompt: p.prompt.slice(0, 20_000),
          answer: p.answer.slice(0, 200_000),
          raw,
          bytes: f.size,
        },
      });
      bytes += raw.length;
      if (bytes >= BATCH_BYTES || batch.length >= 200) await flush();
    }
    await flush();
    state.lastError = null;
  } catch (e) {
    state.lastError = (e as Error).message;
  }

  // Forget files CLIProxyAPI has pruned, so the table stays small.
  const present = new Set(names);
  const old = db.prepare("SELECT name FROM captured WHERE at < ?").all(now - 86_400_000) as { name: string }[];
  const del = db.prepare("DELETE FROM captured WHERE name = ?");
  for (const { name } of old) if (!present.has(name)) del.run(name);
}

let started = false;
let watcher: FSWatcher | null = null;

export function startProxyCapture() {
  if (started) return;
  started = true;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  const soon = () => {
    if (debounce) return;
    debounce = setTimeout(() => {
      debounce = null;
      void tick();
    }, SETTLE_MS + 200);
  };
  const watchDir = () => {
    if (watcher) return;
    try {
      watcher = watch(proxyLogsDir(), soon);
      watcher.on("error", () => {
        watcher?.close();
        watcher = null;
      });
    } catch {
      /* the directory appears once the first request is logged */
    }
  };
  watchDir();
  // The watcher makes it near-live; the interval catches anything it missed and retries after errors.
  setInterval(() => {
    watchDir();
    void tick();
  }, 10_000).unref();
  void tick();
}

/** Ship now (for the Traffic page's refresh), and wait for it. */
export async function captureNow(): Promise<void> {
  await tick();
}
