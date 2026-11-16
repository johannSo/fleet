/**
 * Reads the AI log in ClickHouse for the proxy's Traffic page.
 *
 * Only server.ts (and modules it imports) may use this.
 */
import { chQuery, chStatus, ensureSchema } from "./clickhouse";
import { mgmtJson } from "./cpa";
import type { TrafficPage, TrafficRow, TrafficStatus } from "./cpa-types";
import { captureStatus } from "./proxy-capture";

export interface TrafficQuery {
  limit?: number;
  /** Older than this row (ms + file), for scrolling. */
  before?: number;
  beforeFile?: string;
  /** Newer than this (ms), for "new requests" checks. */
  after?: number;
  q?: string;
  model?: string;
  failed?: boolean;
}

interface Row {
  at: string;
  end: string;
  machine: string;
  file: string;
  request_id: string;
  url: string;
  status: number;
  model: string;
  stream: boolean;
  provider: string;
  account: string;
  attempts: number;
  user_agent: string;
  key_preview: string;
  input_tokens: number;
  output_tokens: number;
  prompt: string;
  answer: string;
  bytes: number;
}

export async function trafficPage(q: TrafficQuery): Promise<TrafficPage> {
  await ensureSchema();
  const limit = Math.min(200, Math.max(1, q.limit ?? 50));
  const rows = await chQuery<Row>(
    `SELECT toUnixTimestamp64Milli(ts) AS at, toUnixTimestamp64Milli(end_ts) AS end, machine, file, request_id, url, status, model, stream,
            provider, account, attempts, user_agent, key_preview, input_tokens, output_tokens,
            leftUTF8(prompt, 600) AS prompt, leftUTF8(answer, 1200) AS answer, bytes
     FROM proxy_requests FINAL
     WHERE (ts, file) < (fromUnixTimestamp64Milli({before:Int64}, 'UTC'), {beforeFile:String})
       AND ts > fromUnixTimestamp64Milli({after:Int64}, 'UTC')
       AND ({q:String} = '' OR positionCaseInsensitiveUTF8(raw, {q:String}) > 0)
       AND ({model:String} = '' OR model = {model:String})
       AND ({failed:UInt8} = 0 OR status >= 400 OR status = 0)
     ORDER BY ts DESC, file DESC
     LIMIT {limit:UInt32}`,
    {
      before: q.before ?? 8.64e15,
      beforeFile: q.before ? (q.beforeFile ?? "") : "￿",
      after: q.after ?? 0,
      q: q.q ?? "",
      model: q.model ?? "",
      failed: q.failed ? 1 : 0,
      limit: limit + 1,
    },
  );
  const out: TrafficRow[] = rows.slice(0, limit).map((r) => ({
    at: Number(r.at),
    end: Number(r.end),
    machine: r.machine,
    file: r.file,
    requestId: r.request_id,
    url: r.url,
    status: r.status,
    model: r.model,
    stream: !!r.stream,
    provider: r.provider,
    account: r.account,
    attempts: r.attempts,
    userAgent: r.user_agent,
    key: r.key_preview,
    input: Number(r.input_tokens),
    output: Number(r.output_tokens),
    prompt: r.prompt,
    answer: r.answer,
    bytes: Number(r.bytes),
  }));
  return { rows: out, more: rows.length > limit };
}

export async function trafficRaw(machine: string, file: string): Promise<string | null> {
  const [r] = await chQuery<{ raw: string }>(
    "SELECT raw FROM proxy_requests FINAL WHERE machine = {machine:String} AND file = {file:String} ORDER BY ts DESC LIMIT 1",
    { machine, file },
  );
  return r?.raw ?? null;
}

export async function trafficModels(): Promise<string[]> {
  await ensureSchema();
  const rows = await chQuery<{ model: string }>("SELECT model FROM proxy_requests WHERE model != '' GROUP BY model ORDER BY count() DESC LIMIT 100");
  return rows.map((r) => r.model);
}

export async function trafficStatus(): Promise<TrafficStatus> {
  const [db, requestLog] = await Promise.all([
    chStatus(),
    mgmtJson<Record<string, unknown>>("GET", "/config/observability/logs")
      .then((c) => (typeof c?.["request-log"] === "boolean" ? (c["request-log"] as boolean) : null))
      .catch(() => null),
  ]);
  let rows: number | null = null;
  let rawBytes: number | null = null;
  let diskBytes: number | null = null;
  if (db.reachable) {
    try {
      await ensureSchema();
      const [a] = await chQuery<{ n: string; raw: string }>("SELECT count() AS n, sum(bytes) AS raw FROM proxy_requests FINAL");
      const [b] = await chQuery<{ disk: string }>(
        "SELECT sum(bytes_on_disk) AS disk FROM system.parts WHERE database = currentDatabase() AND table = 'proxy_requests' AND active",
      );
      rows = Number(a?.n ?? 0);
      rawBytes = Number(a?.raw ?? 0);
      diskBytes = Number(b?.disk ?? 0);
    } catch (e) {
      db.error = (e as Error).message;
    }
  }
  return { db, capture: captureStatus(), requestLog, rows, rawBytes, diskBytes };
}
