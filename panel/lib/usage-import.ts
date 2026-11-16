/**
 * Imports AI usage from every fleet machine into the proxy usage history
 * (lib/cpa-usage.ts), so the Usage page shows all of it in one place:
 *
 * - Claude Code: `~/.claude/projects/**\/*.jsonl` session logs, one row per API
 *   response with its exact tokens. Claude Code keeps these for 30 days by default.
 * - Codex: `~/.codex/sessions/**\/*.jsonl`, one row per `token_count` event.
 * - Another CLIProxyAPI: `~/.cli-proxy-api/logs/main*.log`. Its request lines give
 *   time, endpoint, client, status and duration, and its routing lines usually the
 *   model and account. CLIProxyAPI never logged token counts, so these rows have none.
 *
 * Each machine is one ssh round-trip (or a local bash for the panel's own machine)
 * whose output is parsed as it streams. Session logs are read only when they changed
 * since the last good import; row ids are stable, so re-reading is harmless.
 * Machines that are off are skipped and caught up on the next run.
 *
 * Only server.ts (and modules it imports) may use this.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { type ImportedRequest, importSince, importStatus, saveImport, storeImported } from "./cpa-usage";
import type { UsageImportStatus } from "./cpa-types";
import { loadFleet } from "./fleet";
import { SSH_BASE_OPTS, sshDest } from "./ssh";
import type { FleetNode } from "./types";

/** Re-read session logs changed this long before the last import, to cover clock skew and files written during it. */
const SLACK_S = 6 * 3600;
const EVERY_MS = 60 * 60_000;
const TIMEOUT_MS = 5 * 60_000;

/**
 * Prints `Z <utc offset>`, `E <claude account>`, then one prefixed line per record:
 * `C` Claude Code assistant message, `F`/`X` Codex file and its lines, `P` CLIProxyAPI log.
 */
const SCRIPT = (since: number) => `
export LC_ALL=C
since=${Math.max(0, Math.floor(since))}
echo "Z $(date +%z)"
echo "E $(grep -o '"emailAddress": *"[^"]*"' ~/.claude.json 2>/dev/null | head -1 | sed 's/.*"\\([^"]*\\)"$/\\1/')"
if [ -d ~/.claude/projects ]; then
  find ~/.claude/projects -name '*.jsonl' -newermt "@$since" -print0 2>/dev/null \\
    | xargs -0 -r grep -h -F '"type":"assistant"' 2>/dev/null | grep -F '"usage"' | sed 's/^/C /'
fi
if [ -d ~/.codex/sessions ]; then
  find ~/.codex/sessions -name '*.jsonl' -newermt "@$since" 2>/dev/null | while IFS= read -r f; do
    echo "F $f"
    grep -E '"type":"(turn_context|event_msg)"' "$f" 2>/dev/null | grep -E '"turn_context"|"token_count"' | sed 's/^/X /'
  done
fi
for f in ~/.cli-proxy-api/logs/main*.log; do
  [ -f "$f" ] && grep -E 'gin_logger|selector\\.go|conductor_execution' "$f" | sed 's/^/P /'
done
true
`;

type Rec = Record<string, unknown>;
const o = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);

/* ---------------- Claude Code ---------------- */

function claudeRow(line: string, machine: string, account: string | null): ImportedRequest | null {
  let d: Rec;
  try {
    d = JSON.parse(line);
  } catch {
    return null; // a line still being written
  }
  if (d.type !== "assistant") return null;
  const m = o(d.message);
  const u = o(m.usage);
  const id = str(m.id);
  const model = str(m.model);
  const at = Date.parse(str(d.timestamp) ?? "");
  if (!id || !model || model === "<synthetic>" || !Number.isFinite(at) || !("output_tokens" in u)) return null;
  const cacheRead = num(u.cache_read_input_tokens);
  const entry = str(d.entrypoint);
  return {
    at,
    requestId: `cc:${id}`,
    machine,
    origin: "claude-code",
    model,
    provider: "claude",
    endpoint: "/v1/messages",
    account,
    clientIp: null,
    userAgent: `claude-code/${str(d.version) ?? "?"}${entry ? ` (${entry})` : ""}`,
    stream: true,
    failed: false,
    status: 200,
    error: null,
    latencyMs: null,
    // like the proxy: input counts everything sent, cached is the part read from cache
    input: num(u.input_tokens) + num(u.cache_creation_input_tokens) + cacheRead,
    output: num(u.output_tokens),
    reasoning: num(o(u.output_tokens_details).thinking_tokens),
    cached: cacheRead,
  };
}

/* ---------------- Codex ---------------- */

class CodexFile {
  model = "unknown";
  readonly session: string;
  constructor(
    readonly machine: string,
    file: string,
  ) {
    this.session = file.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)?.[1] ?? file.split("/").pop() ?? file;
  }
  line(line: string): ImportedRequest | null {
    let d: Rec;
    try {
      d = JSON.parse(line);
    } catch {
      return null;
    }
    const p = o(d.payload);
    if (d.type === "turn_context") {
      this.model = str(p.model) ?? this.model;
      return null;
    }
    if (d.type !== "event_msg" || p.type !== "token_count") return null;
    const u = o(o(p.info).last_token_usage);
    const at = Date.parse(str(d.timestamp) ?? "");
    if (!Number.isFinite(at) || !("output_tokens" in u)) return null;
    return {
      at,
      requestId: `codex:${this.session}:${str(d.timestamp)}`,
      machine: this.machine,
      origin: "codex",
      model: this.model,
      provider: "codex",
      endpoint: "/v1/responses",
      account: null,
      clientIp: null,
      userAgent: "codex",
      stream: true,
      failed: false,
      status: 200,
      error: null,
      latencyMs: null,
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      reasoning: num(u.reasoning_output_tokens),
      cached: num(u.cached_input_tokens),
    };
  }
}

/* ---------------- CLIProxyAPI log ---------------- */

/** Go durations as gin prints them: "0s", "83ms", "1.868s", "1m2.5s", "512µs". */
function goDuration(v: string): number | null {
  let ms = 0;
  let any = false;
  for (const [, x, unit] of v.matchAll(/(\d+(?:\.\d+)?)(h|ms|µs|us|ns|m|s)/g)) {
    any = true;
    const f = Number(x);
    ms += unit === "h" ? f * 3_600_000 : unit === "m" ? f * 60_000 : unit === "s" ? f * 1000 : unit === "ms" ? f : unit === "ns" ? f / 1e6 : f / 1000;
  }
  return any ? Math.round(ms) : null;
}

/** "claude-me@example.com.json" → claude / me@example.com; "codex-5ee8d0f5-me@x.de-free.json" → codex / me@x.de. */
function authFile(file: string): { provider: string | null; account: string } {
  const base = file.replace(/\.json$/, "");
  const provider = base.match(/^([a-z]+)-/)?.[1] ?? null;
  const email = base.replace(/-(free|plus|pro|team|business|enterprise|max)$/i, "").match(/([^-\s]+@[^\s]+)$/)?.[1];
  return { provider, account: email ?? base };
}

function providerOf(model: string): string | null {
  if (/^claude/i.test(model)) return "claude";
  if (/^(gpt|o\d|codex)/i.test(model)) return "codex";
  if (/^grok/i.test(model)) return "xai";
  if (/^gemini/i.test(model)) return "gemini";
  return null;
}

class CpaLog {
  private meta = new Map<string, { model?: string; provider?: string; account?: string; error?: string }>();
  private reqs: { id: string; at: number; status: number; latency: number | null; ip: string; path: string }[] = [];
  constructor(
    readonly machine: string,
    private offset: string,
  ) {}

  private time(ts: string): number {
    const off = /^[+-]\d{4}$/.test(this.offset) ? `${this.offset.slice(0, 3)}:${this.offset.slice(3)}` : "Z";
    return Date.parse(`${ts.replace(" ", "T")}${off}`);
  }

  line(l: string) {
    const head = l.match(/^\[(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\] \[([0-9a-f]{8}|-{8})\] \[\w+\s*\] \[(\w+)\.go:\d+\] (.*)$/);
    if (!head) return;
    const [, ts, rid, file, rest] = head;
    if (file === "gin_logger") {
      const g = rest.match(/^(\d{3}) \|\s*(\S+)\s*\|\s*(\S+)\s*\|\s*([A-Z]+)\s+"([^"]*)"/);
      if (!g) return;
      const [, status, dur, ip, method, rawPath] = g;
      const p = rawPath.split("?")[0];
      // client API calls only: not the management API, health checks or model lists
      if (method !== "POST" || /^\/(v0|v8)\/management|^\/api\/hello|\/models$/.test(p)) return;
      const at = this.time(ts);
      if (!Number.isFinite(at)) return;
      const id = rid.startsWith("-") ? `${ts}|${ip}|${p}` : rid;
      this.reqs.push({ id, at, status: Number(status), latency: goDuration(dur), ip, path: p });
      return;
    }
    if (rid.startsWith("-")) return;
    const m = this.meta.get(rid) ?? {};
    if (file === "selector") {
      const s = rest.match(/auth=(\S+) provider=(\S+) model=(\S+)/);
      if (s) {
        const a = authFile(s[1]);
        Object.assign(m, { model: s[3], account: a.account, provider: a.provider ?? (s[2] !== "mixed" ? s[2] : undefined) });
      }
    } else if (file === "conductor_execution") {
      const c = rest.match(/provider=(\S+) model=(\S+) auth=\S+ auth_file=(\S+) err=(.*)$/);
      if (c) {
        m.model ??= c[2];
        m.provider ??= c[1];
        m.account ??= authFile(c[3]).account;
        m.error = c[4];
      }
    }
    this.meta.set(rid, m);
  }

  rows(): ImportedRequest[] {
    return this.reqs.map((r) => {
      const m = this.meta.get(r.id) ?? {};
      const failed = r.status >= 400;
      const model = m.model ?? "unknown";
      return {
        at: r.at,
        requestId: `${this.machine}:cpa:${r.id}`,
        machine: this.machine,
        origin: "cpa",
        model,
        provider: m.provider ?? providerOf(model),
        endpoint: r.path,
        account: m.account ?? null,
        clientIp: r.ip,
        userAgent: null,
        stream: false,
        failed,
        status: r.status,
        error: failed ? (m.error ?? `HTTP ${r.status}`) : null,
        latencyMs: r.latency,
        input: 0,
        output: 0,
        reasoning: 0,
        cached: 0,
      };
    });
  }
}

/* ---------------- one machine ---------------- */

async function importMachine(node: FleetNode): Promise<UsageImportStatus> {
  const started = Date.now();
  const since = importSince(node.id);
  const status: UsageImportStatus = { machine: node.id, at: started, ok: false, added: {}, error: null };
  const [cmd, args] = node.local
    ? ["bash", ["-s"]]
    : ["ssh", [...SSH_BASE_OPTS, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-T", ...sshDest(node), "bash -s"]];
  const child = spawn(/*turbopackIgnore: true*/ cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
  child.stdin.on("error", () => {});
  child.stdin.end(SCRIPT(since ? since / 1000 - SLACK_S : 0));
  const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });

  const claude = new Map<string, ImportedRequest>(); // by message id: a message spans several lines
  const other: ImportedRequest[] = [];
  let account: string | null = null;
  let offset = "+0000";
  let codex: CodexFile | null = null;
  let cpa: CpaLog | null = null;
  const add = (added: Partial<Record<string, number>>) => {
    for (const [k, v] of Object.entries(added)) status.added[k as keyof typeof status.added] = (status.added[k as keyof typeof status.added] ?? 0) + (v ?? 0);
  };
  const flush = () => {
    add(storeImported([...claude.values(), ...other]));
    claude.clear();
    other.length = 0;
  };

  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      const tag = line.slice(0, 2);
      const rest = line.slice(2);
      if (tag === "C ") {
        const r = claudeRow(rest, node.id, account);
        if (!r) continue;
        const prev = claude.get(r.requestId);
        if (!prev || r.output >= prev.output) claude.set(r.requestId, r);
      } else if (tag === "X ") {
        const r = codex?.line(rest);
        if (r) other.push(r);
      } else if (tag === "F ") {
        codex = new CodexFile(node.id, rest);
      } else if (tag === "P ") {
        (cpa ??= new CpaLog(node.id, offset)).line(rest);
      } else if (tag === "Z ") {
        offset = rest.trim();
      } else if (tag === "E ") {
        account = rest.trim() || null;
      }
      if (claude.size + other.length >= 2000) flush();
    }
    if (cpa) other.push(...cpa.rows());
    flush();
  } catch (err) {
    status.error = (err as Error).message;
  } finally {
    clearTimeout(timer);
  }
  const code = await exited;
  if (!status.error && code !== 0) {
    const msg = stderr
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("Warning: Permanently added"))
      .pop();
    status.error = code == null ? "Timed out" : (msg?.replace(/^ssh: /, "") ?? `Exited with code ${code}`);
  }
  status.ok = !status.error;
  saveImport(status, status.ok ? started : null);
  return status;
}

/* ---------------- runs ---------------- */

let running: Promise<UsageImportStatus[]> | null = null;

/** Imports from every machine the panel can reach (in parallel); returns each machine's result. */
export function importUsage(): Promise<UsageImportStatus[]> {
  running ??= (async () => {
    try {
      const nodes = loadFleet().filter((n) => n.local || n.sshTarget);
      return await Promise.all(
        nodes.map((n) =>
          importMachine(n).catch((err): UsageImportStatus => ({ machine: n.id, at: Date.now(), ok: false, added: {}, error: (err as Error).message })),
        ),
      );
    } finally {
      running = null;
    }
  })();
  return running;
}

export function usageImportState(): { running: boolean; machines: UsageImportStatus[] } {
  return { running: running != null, machines: importStatus() };
}

let started = false;
/** Imports a minute after start, then hourly. */
export function startUsageImporter() {
  if (started) return;
  started = true;
  const run = () => void importUsage().catch((err) => console.error("[usage-import]", err));
  setTimeout(run, 60_000).unref();
  setInterval(run, EVERY_MS).unref();
}
