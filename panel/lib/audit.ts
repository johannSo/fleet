/**
 * Activity log: a permanent record of everything done to machines through the
 * panel — terminal sessions and what was typed into them, the AI's commands and
 * who approved them, power actions, Wake-on-LAN and sign-ins.
 *
 * Stored in SQLite at $STATE_DIR/activity.db; terminal output goes to one
 * transcript file per session under $STATE_DIR/transcripts/.
 *
 * Only server.ts (and modules it imports) may use this. Next's route handlers
 * are bundled separately and must not import it.
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ActivityEvent, ActivityQuery, ActivitySource, ActivityStatus } from "./activity-types";
import { STATE_DIR } from "./net";

const DB_FILE = path.join(STATE_DIR, "activity.db");
const TRANSCRIPT_DIR = path.join(STATE_DIR, "transcripts");
/** Per terminal session. Beyond this the transcript keeps going but stops being written. */
const MAX_TRANSCRIPT = 8_000_000;
const MAX_DETAIL = 64_000;

mkdirSync(TRANSCRIPT_DIR, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(DB_FILE);
// It holds command history: keep it private.
for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  try {
    chmodSync(f, 0o600);
  } catch {
    /* not created yet */
  }
}
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    source    TEXT NOT NULL,
    kind      TEXT NOT NULL,
    actor     TEXT NOT NULL,
    node      TEXT,
    summary   TEXT NOT NULL,
    detail    TEXT,
    status    TEXT,
    exit_code INTEGER,
    ms        INTEGER,
    parent    INTEGER,
    ref       TEXT,
    meta      TEXT,
    ended_at  INTEGER
  );
  CREATE INDEX IF NOT EXISTS events_at ON events(at);
  CREATE INDEX IF NOT EXISTS events_node ON events(node, at);
  CREATE INDEX IF NOT EXISTS events_parent ON events(parent);
  CREATE INDEX IF NOT EXISTS events_ref ON events(ref);
`);
for (const f of [`${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  try {
    chmodSync(f, 0o600);
  } catch {
    /* ignore */
  }
}
// Anything still "running" died with the previous server process.
db.prepare(`UPDATE events SET status = 'error', meta = json_set(coalesce(meta, '{}'), '$.note', 'Interrupted: the panel restarted') WHERE status IN ('running', 'pending', 'approval')`).run();

let listener: ((e: ActivityEvent) => void) | null = null;
/** Called with every new or changed event, for live updates in the UI. */
export function onActivity(fn: (e: ActivityEvent) => void) {
  listener = fn;
}

interface Row {
  id: number;
  at: number;
  source: string;
  kind: string;
  actor: string;
  node: string | null;
  summary: string;
  detail: string | null;
  status: string | null;
  exit_code: number | null;
  ms: number | null;
  parent: number | null;
  ref: string | null;
  meta: string | null;
  ended_at: number | null;
  children?: number;
}

function toEvent(r: Row): ActivityEvent {
  let meta: Record<string, unknown> = {};
  try {
    meta = r.meta ? JSON.parse(r.meta) : {};
  } catch {
    /* ignore */
  }
  return {
    id: r.id,
    at: r.at,
    source: r.source as ActivitySource,
    kind: r.kind,
    actor: r.actor,
    node: r.node,
    summary: r.summary,
    detail: r.detail,
    status: r.status as ActivityStatus | null,
    exitCode: r.exit_code,
    ms: r.ms,
    parent: r.parent,
    ref: r.ref,
    meta,
    endedAt: r.ended_at,
    children: r.children ?? 0,
    hasTranscript: meta.transcript === true,
  };
}

const getStmt = db.prepare(`SELECT e.*, (SELECT count(*) FROM events c WHERE c.parent = e.id) AS children FROM events e WHERE e.id = ?`);

export function getActivity(id: number): ActivityEvent | null {
  const r = getStmt.get(id) as Row | undefined;
  return r ? toEvent(r) : null;
}

function notify(id: number) {
  if (!listener) return;
  const e = getActivity(id);
  if (e) {
    try {
      listener(e);
    } catch {
      /* ignore */
    }
  }
}

export interface NewActivity {
  source: ActivitySource;
  kind: string;
  actor: string;
  node?: string | null;
  summary: string;
  detail?: string | null;
  status?: ActivityStatus | null;
  exitCode?: number | null;
  ms?: number | null;
  parent?: number | null;
  ref?: string | null;
  meta?: Record<string, unknown>;
  at?: number;
}

const insertStmt = db.prepare(
  `INSERT INTO events (at, source, kind, actor, node, summary, detail, status, exit_code, ms, parent, ref, meta, ended_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

function clip(s: string | null | undefined, max = MAX_DETAIL): string | null {
  if (s == null) return null;
  return s.length > max ? `[… ${s.length - max} earlier characters dropped …]\n${s.slice(-max)}` : s;
}

/** Records something. Never throws: logging must not break the action itself. */
export function logActivity(a: NewActivity): number {
  try {
    const done = a.status && a.status !== "running" && a.status !== "pending" && a.status !== "approval";
    const at = a.at ?? Date.now();
    const r = insertStmt.run(
      at,
      a.source,
      a.kind,
      a.actor,
      a.node ?? null,
      a.summary.slice(0, 4000),
      clip(a.detail),
      a.status ?? null,
      a.exitCode ?? null,
      a.ms ?? null,
      a.parent ?? null,
      a.ref ?? null,
      a.meta ? JSON.stringify(a.meta) : null,
      done ? at : null,
    );
    const id = Number(r.lastInsertRowid);
    notify(id);
    return id;
  } catch (err) {
    console.error("[activity] couldn't log:", (err as Error).message);
    return -1;
  }
}

export interface ActivityPatch {
  status?: ActivityStatus;
  detail?: string | null;
  exitCode?: number | null;
  ms?: number | null;
  summary?: string;
  meta?: Record<string, unknown>;
}

/** Updates an event (e.g. a session that finished). Meta is merged. */
export function updateActivity(id: number, p: ActivityPatch) {
  if (id < 0) return;
  try {
    const sets: string[] = [];
    const vals: SQLInputValue[] = [];
    if (p.status !== undefined) {
      sets.push("status = ?");
      vals.push(p.status);
      if (p.status !== "running" && p.status !== "pending" && p.status !== "approval") {
        sets.push("ended_at = coalesce(ended_at, ?)");
        vals.push(Date.now());
      }
    }
    if (p.detail !== undefined) {
      sets.push("detail = ?");
      vals.push(clip(p.detail));
    }
    if (p.exitCode !== undefined) {
      sets.push("exit_code = ?");
      vals.push(p.exitCode);
    }
    if (p.ms !== undefined) {
      sets.push("ms = ?");
      vals.push(p.ms);
    }
    if (p.summary !== undefined) {
      sets.push("summary = ?");
      vals.push(p.summary.slice(0, 4000));
    }
    if (p.meta) {
      sets.push("meta = json_patch(coalesce(meta, '{}'), ?)");
      vals.push(JSON.stringify(p.meta));
    }
    if (!sets.length) return;
    db.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    notify(id);
  } catch (err) {
    console.error("[activity] couldn't update:", (err as Error).message);
  }
}

const refStmt = db.prepare(`SELECT id FROM events WHERE ref = ? ORDER BY id DESC LIMIT 1`);
export function activityByRef(ref: string): number | null {
  const r = refStmt.get(ref) as { id: number } | undefined;
  return r ? r.id : null;
}

/** Top-level events, newest first, with how many child events each one has. */
export function queryActivity(q: ActivityQuery): { events: ActivityEvent[]; more: boolean } {
  const where: string[] = [];
  const vals: SQLInputValue[] = [];
  if (q.parent != null) {
    where.push("e.parent = ?");
    vals.push(q.parent);
  } else {
    where.push("e.parent IS NULL");
  }
  if (q.node) {
    where.push("e.node = ?");
    vals.push(q.node);
  }
  if (q.source) {
    where.push("e.source = ?");
    vals.push(q.source);
  }
  if (q.before) {
    where.push("e.id < ?");
    vals.push(q.before);
  }
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(
      `(e.summary LIKE ? ESCAPE '\\' OR e.detail LIKE ? ESCAPE '\\' OR e.actor LIKE ? ESCAPE '\\' OR e.node LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM events c WHERE c.parent = e.id AND (c.summary LIKE ? ESCAPE '\\' OR c.detail LIKE ? ESCAPE '\\')))`,
    );
    vals.push(like, like, like, like, like, like);
  }
  const limit = Math.max(1, Math.min(500, q.limit ?? 100));
  const order = q.parent != null ? "ASC" : "DESC";
  const rows = db
    .prepare(
      `SELECT e.*, (SELECT count(*) FROM events c WHERE c.parent = e.id) AS children
       FROM events e WHERE ${where.join(" AND ")} ORDER BY e.id ${order} LIMIT ?`,
    )
    .all(...vals, limit + 1) as unknown as Row[];
  return { events: rows.slice(0, limit).map(toEvent), more: rows.length > limit };
}

export function activityNodes(): string[] {
  return (db.prepare(`SELECT DISTINCT node FROM events WHERE node IS NOT NULL ORDER BY node`).all() as { node: string }[]).map((r) => r.node);
}

/* ---------------- terminal transcripts ---------------- */

function transcriptFile(id: number) {
  return path.join(TRANSCRIPT_DIR, `${id}.log`);
}

const transcriptSize = new Map<number, number>();

export function appendTranscript(id: number, data: string) {
  if (id < 0) return;
  const size = transcriptSize.get(id) ?? 0;
  if (size >= MAX_TRANSCRIPT) return;
  try {
    let chunk = data;
    if (size + chunk.length > MAX_TRANSCRIPT) chunk = `${chunk.slice(0, MAX_TRANSCRIPT - size)}\r\n[… transcript limit reached …]\r\n`;
    appendFileSync(transcriptFile(id), chunk, { mode: 0o600 });
    transcriptSize.set(id, size + chunk.length);
  } catch {
    /* ignore */
  }
}

export function endTranscript(id: number) {
  transcriptSize.delete(id);
}

/** The raw terminal output of a session, ANSI codes and all. */
export function readTranscript(id: number): string | null {
  try {
    const f = transcriptFile(id);
    const { size } = statSync(f);
    const all = readFileSync(f, "utf8");
    return size > 2_000_000 ? all.slice(-2_000_000) : all;
  } catch {
    return null;
  }
}
