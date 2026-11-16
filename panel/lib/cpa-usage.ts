/**
 * Usage history for the AI proxy. CLIProxyAPI no longer keeps statistics itself; it
 * publishes one event per request on a short-lived queue (60 s retention) for an
 * outside collector. This is that collector: it drains the queue every few seconds
 * into SQLite at $STATE_DIR/proxy/usage.db, kept forever, and answers the Proxy
 * page's usage queries.
 *
 * Only server.ts (and modules it imports) may use this.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { PROXY_DIR, mgmtJson } from "./cpa";
import { ORIGIN_LABELS, type ProxyRequest, type UsageImportStatus, type UsageOrigin, type UsageRange, type UsageReport, type UsageSource, keyPreview } from "./cpa-types";
import { loadFleet } from "./fleet";

mkdirSync(PROXY_DIR, { recursive: true, mode: 0o700 });
const DB_FILE = path.join(PROXY_DIR, "usage.db");
const db = new DatabaseSync(DB_FILE);
try {
  chmodSync(DB_FILE, 0o600);
} catch {
  /* ignore */
}
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    at          INTEGER NOT NULL,
    request_id  TEXT,
    model       TEXT NOT NULL,
    alias       TEXT,
    provider    TEXT,
    endpoint    TEXT,
    auth_index  TEXT,
    source      TEXT,
    key_hash    TEXT,
    key_preview TEXT,
    client_ip   TEXT,
    user_agent  TEXT,
    stream      INTEGER NOT NULL DEFAULT 0,
    failed      INTEGER NOT NULL DEFAULT 0,
    status      INTEGER,
    error       TEXT,
    latency_ms  INTEGER,
    ttft_ms     INTEGER,
    input       INTEGER NOT NULL DEFAULT 0,
    output      INTEGER NOT NULL DEFAULT 0,
    reasoning   INTEGER NOT NULL DEFAULT 0,
    cached      INTEGER NOT NULL DEFAULT 0,
    total       INTEGER NOT NULL DEFAULT 0,
    effort      TEXT
  );
  CREATE INDEX IF NOT EXISTS requests_at ON requests(at);
  CREATE INDEX IF NOT EXISTS requests_model ON requests(model);
  CREATE UNIQUE INDEX IF NOT EXISTS requests_rid ON requests(request_id) WHERE request_id IS NOT NULL AND request_id != '';
  CREATE TABLE IF NOT EXISTS imports (
    machine TEXT PRIMARY KEY,
    at      INTEGER NOT NULL,
    since   INTEGER NOT NULL DEFAULT 0,
    ok      INTEGER NOT NULL,
    added   TEXT,
    error   TEXT
  );
`);

/** This panel's own machine in the inventory, for rows from its own proxy. */
function localMachine(): string | null {
  try {
    return loadFleet().find((n) => n.local)?.id ?? null;
  } catch {
    return null;
  }
}

// v2: rows say which machine and which source (see UsageOrigin) they came from.
{
  const cols = new Set((db.prepare("PRAGMA table_info(requests)").all() as { name: string }[]).map((c) => c.name));
  if (!cols.has("machine")) db.exec("ALTER TABLE requests ADD COLUMN machine TEXT");
  if (!cols.has("origin")) {
    db.exec("ALTER TABLE requests ADD COLUMN origin TEXT NOT NULL DEFAULT 'fleet'");
    db.prepare("UPDATE requests SET machine = ? WHERE machine IS NULL").run(localMachine());
  }
  db.exec("CREATE INDEX IF NOT EXISTS requests_origin_at ON requests(origin, at)");
}

const insert = db.prepare(`
  INSERT OR IGNORE INTO requests (at, request_id, model, alias, provider, endpoint, auth_index, source, key_hash, key_preview, client_ip, user_agent,
    stream, failed, status, error, latency_ms, ttft_ms, input, output, reasoning, cached, total, effort, machine, origin)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fleet')`);

type Rec = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : v == null ? null : String(v));
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
const o = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});

/** Client keys are secrets: keep a hash to group by and a preview to show. */
function keyParts(key: string | null): [string | null, string | null] {
  if (!key) return [null, null];
  return [createHash("sha256").update(key).digest("hex").slice(0, 16), keyPreview(key)];
}

/** For API-key upstreams CPA reports the upstream key itself as the source: never store that. */
function accountLabel(r: Rec): string | null {
  const src = s(r.source);
  if (!src) return null;
  const type = (s(r.auth_type) ?? "").toLowerCase();
  if (type === "oauth" || src.includes("@")) return src;
  return type || /^(sk-|AIza|xai-|key-)/.test(src) || src.length >= 20 ? keyPreview(src) : src;
}

function store(r: Rec) {
  const t = o(r.tokens);
  const fail = o(r.fail);
  const [kh, kp] = keyParts(s(r.api_key));
  const at = Date.parse(s(r.timestamp) ?? "") || Date.now();
  const input = n(t.input_tokens);
  const output = n(t.output_tokens);
  insert.run(
    at,
    s(r.request_id) || null,
    s(r.model) || "unknown",
    s(r.alias) || null,
    s(r.provider) || s(r.executor_type) || null,
    s(r.endpoint) || null,
    s(r.auth_index) || null,
    accountLabel(r),
    kh,
    kp,
    s(r.resolved_client_ip) || s(r.client_ip) || null,
    (s(r.user_agent) ?? "").slice(0, 300) || null,
    r.stream ? 1 : 0,
    r.failed ? 1 : 0,
    n(fail.status_code) || (r.failed ? null : 200),
    r.failed ? ((s(fail.code) ? `${s(fail.code)}: ` : "") + (s(fail.body) ?? "")).slice(0, 4000) : null,
    n(r.latency_ms) || null,
    n(r.ttft_ms) || null,
    input,
    output,
    n(t.reasoning_tokens),
    n(t.cache_read_tokens) || n(t.cached_tokens),
    n(t.total_tokens) || input + output,
    s(r.reasoning_effort) || null,
    localMachine(),
  );
}

let listener: (() => void) | null = null;
/** Called after new requests were stored, for live updates. */
export function onUsage(fn: () => void) {
  listener = fn;
}

let draining = false;
async function drain() {
  if (draining) return;
  draining = true;
  try {
    let got = 0;
    for (let round = 0; round < 20; round++) {
      const items = await mgmtJson<unknown[]>("GET", "/observability/usage/queue?count=500");
      if (!Array.isArray(items) || !items.length) break;
      db.exec("BEGIN");
      try {
        for (const it of items) {
          const rec = typeof it === "string" ? JSON.parse(it) : it;
          if (rec && typeof rec === "object") store(rec as Rec);
        }
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      got += items.length;
      if (items.length < 500) break;
    }
    if (got) listener?.();
  } catch {
    /* proxy down or not installed: try again next tick */
  } finally {
    draining = false;
  }
}

let started = false;
export function startUsageCollector() {
  if (started) return;
  started = true;
  setInterval(drain, 5_000).unref();
  void drain();
}

/* ---------------- imports from other machines (lib/usage-import.ts) ---------------- */

/** A request found on another machine. `requestId` must be stable so re-imports update instead of duplicating. */
export interface ImportedRequest {
  at: number;
  requestId: string;
  machine: string;
  origin: Exclude<UsageOrigin, "fleet">;
  model: string;
  provider: string | null;
  endpoint: string | null;
  account: string | null;
  clientIp: string | null;
  userAgent: string | null;
  stream: boolean;
  failed: boolean;
  status: number | null;
  error: string | null;
  latencyMs: number | null;
  input: number;
  output: number;
  reasoning: number;
  cached: number;
}

// A message seen mid-stream may come back later with its final token counts: keep the larger.
const upsert = db.prepare(`
  INSERT INTO requests (at, request_id, model, provider, endpoint, source, client_ip, user_agent, stream, failed, status, error, latency_ms,
    input, output, reasoning, cached, total, machine, origin)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(request_id) WHERE request_id IS NOT NULL AND request_id != '' DO UPDATE SET
    model = excluded.model, provider = coalesce(excluded.provider, provider), source = coalesce(excluded.source, source),
    failed = excluded.failed, status = excluded.status, error = excluded.error,
    input = max(input, excluded.input), output = max(output, excluded.output), reasoning = max(reasoning, excluded.reasoning),
    cached = max(cached, excluded.cached), total = max(total, excluded.total)
  WHERE excluded.input > input OR excluded.output > output OR excluded.model != model OR excluded.failed != failed
    OR coalesce(excluded.source, '') != coalesce(source, '') OR coalesce(excluded.provider, '') != coalesce(provider, '')`);

/** Stores imported requests in one transaction; returns how many rows were added or changed, per origin. */
export function storeImported(rows: ImportedRequest[]): Partial<Record<UsageOrigin, number>> {
  const added: Partial<Record<UsageOrigin, number>> = {};
  if (!rows.length) return added;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const res = upsert.run(
        Math.round(r.at),
        r.requestId,
        r.model || "unknown",
        r.provider,
        r.endpoint,
        r.account,
        r.clientIp,
        r.userAgent?.slice(0, 300) ?? null,
        r.stream ? 1 : 0,
        r.failed ? 1 : 0,
        r.status,
        r.error?.slice(0, 4000) ?? null,
        r.latencyMs == null ? null : Math.round(r.latencyMs),
        r.input,
        r.output,
        r.reasoning,
        r.cached,
        r.input + r.output,
        r.machine,
        r.origin,
      );
      if (res.changes) added[r.origin] = (added[r.origin] ?? 0) + 1;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  if (Object.keys(added).length) listener?.();
  return added;
}

/** When a machine's session logs were last read completely, so the next run only reads newer files. */
export function importSince(machine: string): number {
  const r = db.prepare("SELECT since FROM imports WHERE machine = ?").get(machine) as { since: number } | undefined;
  return r?.since ?? 0;
}

export function saveImport(st: UsageImportStatus, since: number | null) {
  db.prepare(
    `INSERT INTO imports (machine, at, since, ok, added, error) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(machine) DO UPDATE SET at = excluded.at, since = CASE WHEN excluded.ok THEN excluded.since ELSE since END, ok = excluded.ok, added = excluded.added, error = excluded.error`,
  ).run(st.machine, st.at, since ?? 0, st.ok ? 1 : 0, JSON.stringify(st.added), st.error);
}

export function importStatus(): UsageImportStatus[] {
  return (db.prepare("SELECT * FROM imports ORDER BY machine").all() as Rec[]).map((r) => ({
    machine: s(r.machine) ?? "",
    at: n(r.at),
    ok: r.ok === 1,
    added: (() => {
      try {
        return JSON.parse(s(r.added) ?? "{}");
      } catch {
        return {};
      }
    })(),
    error: s(r.error),
  }));
}

/* ---------------- queries ---------------- */

const SOURCE_SQL: Record<UsageSource, string> = {
  all: "1 = 1",
  proxy: "origin IN ('fleet', 'cpa')",
  "claude-code": "origin = 'claude-code'",
  codex: "origin = 'codex'",
};
const sourceWhere = (src: UsageSource | undefined) => SOURCE_SQL[src ?? "all"] ?? SOURCE_SQL.all;
const ORIGIN_CASE = `CASE origin ${Object.entries(ORIGIN_LABELS)
  .map(([k, v]) => `WHEN '${k}' THEN '${v}'`)
  .join(" ")} ELSE origin END`;

const RANGES: Record<Exclude<UsageRange, "all">, { span: number; bucket: number }> = {
  "24h": { span: 86_400_000, bucket: 3_600_000 },
  "7d": { span: 7 * 86_400_000, bucket: 6 * 3_600_000 },
  "30d": { span: 30 * 86_400_000, bucket: 86_400_000 },
};

/** "All time": daily bars back to the first request, weekly once that is more than ~4 months. */
function allTimeRange(where: string): { span: number; bucket: number } {
  const first = (db.prepare(`SELECT min(at) AS t FROM requests WHERE ${where}`).get() as { t: number | null }).t;
  const days = first == null ? 30 : Math.max(30, Math.ceil((Date.now() - first) / 86_400_000) + 1);
  if (days <= 120) return { span: days * 86_400_000, bucket: 86_400_000 };
  return { span: Math.ceil(days / 7) * 7 * 86_400_000, bucket: 7 * 86_400_000 };
}

export function usageReport(range: UsageRange, source: UsageSource = "all"): UsageReport {
  const where = sourceWhere(source);
  const { span, bucket } = range === "all" ? allTimeRange(where) : (RANGES[range] ?? RANGES["24h"]);
  const now = Date.now();
  // align buckets to local hours/days so labels read naturally
  const tz = new Date().getTimezoneOffset() * 60_000;
  const end = Math.ceil((now - tz) / Math.min(bucket, 86_400_000)) * Math.min(bucket, 86_400_000) + tz;
  const since = end - span;
  const totals = db
    .prepare(
      `SELECT count(*) AS requests, coalesce(sum(failed),0) AS errors, coalesce(sum(input),0) AS input, coalesce(sum(output),0) AS output,
       coalesce(sum(cached),0) AS cached, coalesce(sum(reasoning),0) AS reasoning, coalesce(avg(CASE WHEN failed = 0 THEN latency_ms END),0) AS avgMs,
       coalesce(avg(CASE WHEN failed = 0 AND ttft_ms > 0 THEN ttft_ms END),0) AS avgTtft
       FROM requests WHERE at >= ? AND ${where}`,
    )
    .get(since) as UsageReport["totals"];
  const rows = db
    .prepare(
      `SELECT CAST((at - ?) / ? AS INTEGER) AS b, count(*) AS requests, sum(failed) AS errors, sum(input) AS input, sum(output) AS output
       FROM requests WHERE at >= ? AND ${where} GROUP BY b ORDER BY b`,
    )
    .all(Math.round(since), Math.round(bucket), Math.round(since)) as { b: number; requests: number; errors: number; input: number; output: number }[];
  const count = Math.round(span / bucket);
  const series = Array.from({ length: count }, (_, i) => ({ t: since + i * bucket, requests: 0, errors: 0, input: 0, output: 0 }));
  for (const r of rows) {
    const x = series[r.b];
    if (x) Object.assign(x, { requests: r.requests, errors: r.errors, input: r.input, output: r.output });
  }
  const group = (col: string, extra = "") =>
    db
      .prepare(
        `SELECT coalesce(${col}, '—') AS name, count(*) AS requests, sum(failed) AS errors, sum(input) AS input, sum(output) AS output
         FROM requests WHERE at >= ? AND ${where} ${extra} GROUP BY name ORDER BY (sum(input) + sum(output)) DESC, requests DESC LIMIT 12`,
      )
      .all(since) as unknown as UsageReport["byModel"];
  return {
    range,
    source,
    bucket,
    totals,
    series,
    byModel: group("model"),
    byProvider: group("provider"),
    byAccount: group("coalesce(source, auth_index)"),
    byKey: group("key_preview", "AND key_preview IS NOT NULL"),
    byMachine: group(`coalesce(machine, '?') || ' · ' || ${ORIGIN_CASE}`),
  };
}

/** Newest first. Page with `before` = the last row's `at` and `beforeId` = its `id` (imported rows don't arrive in time order). */
export function recentRequests(q: {
  limit?: number;
  before?: number;
  beforeId?: number;
  failed?: boolean;
  model?: string;
  q?: string;
  source?: UsageSource;
}): { requests: ProxyRequest[]; more: boolean } {
  const where: string[] = [sourceWhere(q.source)];
  const args: SQLInputValue[] = [];
  if (q.before) {
    where.push("(at < ? OR (at = ? AND id < ?))");
    args.push(q.before, q.before, q.beforeId ?? Number.MAX_SAFE_INTEGER);
  }
  if (q.failed) where.push("failed = 1");
  if (q.model) {
    where.push("model = ?");
    args.push(q.model);
  }
  if (q.q) {
    where.push("(model LIKE ? OR source LIKE ? OR error LIKE ? OR user_agent LIKE ? OR client_ip LIKE ? OR machine LIKE ?)");
    const like = `%${q.q}%`;
    args.push(like, like, like, like, like, like);
  }
  const limit = Math.min(500, Math.max(1, q.limit ?? 100));
  const rows = db
    .prepare(`SELECT * FROM requests WHERE ${where.join(" AND ")} ORDER BY at DESC, id DESC LIMIT ?`)
    .all(...args, limit + 1) as Rec[];
  const requests = rows.slice(0, limit).map(
    (r): ProxyRequest => ({
      id: n(r.id),
      at: n(r.at),
      requestId: s(r.request_id),
      model: s(r.model) ?? "",
      alias: s(r.alias),
      provider: s(r.provider),
      endpoint: s(r.endpoint),
      account: s(r.source) || s(r.auth_index),
      key: s(r.key_preview),
      clientIp: s(r.client_ip),
      userAgent: s(r.user_agent),
      stream: r.stream === 1,
      failed: r.failed === 1,
      status: r.status == null ? null : n(r.status),
      error: s(r.error),
      latencyMs: r.latency_ms == null ? null : n(r.latency_ms),
      ttftMs: r.ttft_ms == null ? null : n(r.ttft_ms),
      input: n(r.input),
      output: n(r.output),
      reasoning: n(r.reasoning),
      cached: n(r.cached),
      effort: s(r.effort),
      machine: s(r.machine),
      origin: (s(r.origin) ?? "fleet") as UsageOrigin,
    }),
  );
  return { requests, more: rows.length > limit };
}
