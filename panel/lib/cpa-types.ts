/* Shared between the AI proxy server side (lib/cpa*.ts) and the Proxy pages. */

export type UsageRange = "24h" | "7d" | "30d" | "all";

/**
 * Where a usage row came from. `fleet`: this panel's own proxy (live). `cpa`: another
 * CLIProxyAPI's log on a fleet machine (requests and results, no token counts).
 * `claude-code` / `codex`: those CLIs' session logs on a fleet machine (exact tokens;
 * these requests mostly went straight to Anthropic/OpenAI, not through a proxy).
 */
export type UsageOrigin = "fleet" | "cpa" | "claude-code" | "codex";
/** Usage page filter: everything, only proxied requests (fleet + cpa), or one CLI. */
export type UsageSource = "all" | "proxy" | "claude-code" | "codex";

export const ORIGIN_LABELS: Record<UsageOrigin, string> = {
  fleet: "Fleet proxy",
  cpa: "CLIProxyAPI log",
  "claude-code": "Claude Code",
  codex: "Codex",
};

/** One machine's last usage import. */
export interface UsageImportStatus {
  machine: string;
  at: number;
  ok: boolean;
  /** Rows added or updated in that run, per origin. */
  added: Partial<Record<UsageOrigin, number>>;
  error: string | null;
}

export interface UsageGroup {
  name: string;
  requests: number;
  errors: number;
  input: number;
  output: number;
}

export interface UsageReport {
  range: UsageRange;
  source: UsageSource;
  /** Bucket width, ms. */
  bucket: number;
  totals: { requests: number; errors: number; input: number; output: number; cached: number; reasoning: number; avgMs: number; avgTtft: number };
  series: { t: number; requests: number; errors: number; input: number; output: number }[];
  byModel: UsageGroup[];
  byProvider: UsageGroup[];
  byAccount: UsageGroup[];
  byKey: UsageGroup[];
  /** "desktop · Claude Code", "laptop · Fleet proxy", … */
  byMachine: UsageGroup[];
}

export interface ProxyRequest {
  id: number;
  at: number;
  requestId: string | null;
  model: string;
  alias: string | null;
  provider: string | null;
  endpoint: string | null;
  account: string | null;
  key: string | null;
  clientIp: string | null;
  userAgent: string | null;
  stream: boolean;
  failed: boolean;
  status: number | null;
  error: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
  input: number;
  output: number;
  reasoning: number;
  cached: number;
  effort: string | null;
  /** Fleet machine the request was made on (or served by, for proxies). */
  machine: string | null;
  origin: UsageOrigin;
}

export interface ProxyStatus {
  service: { installed: boolean; active: string; sub: string; pid: number | null; since: number | null; memory: number | null };
  reachable: boolean;
  version: string | null;
  latest: string | null;
  port: number;
  /** Base URLs clients can use, best first. */
  urls: string[];
  error: string | null;
}

/** One entry of GET /v8/management/credentials (fields CPA may or may not send). */
export interface Credential {
  id?: string;
  name: string;
  type?: string;
  provider?: string;
  email?: string;
  label?: string;
  account?: string;
  account_type?: string;
  project_id?: string;
  auth_index?: string | number;
  status?: string;
  status_message?: string;
  disabled?: boolean;
  unavailable?: boolean;
  runtime_only?: boolean;
  priority?: number;
  weight?: number;
  note?: string;
  prefix?: string;
  modtime?: string;
  last_refresh?: string;
  next_retry_after?: string;
  access_token_expires_at?: string;
  next_refresh_after?: string;
  requires_sign_in?: boolean;
  renewal_state?: string;
  recovery_stage?: string;
  next_action?: string;
  recovery_hint?: string;
  refresh_error?: { code?: string; message?: string; http_status?: number };
  success?: number;
  failed?: number;
  recent_requests?: { time?: string; success?: number; failed?: number }[];
  cooldowns?: { scope?: string; model?: string; model_key?: string; reason?: string; retry_at?: string; remaining_seconds?: number; http_status?: number }[];
  plan_type?: string;
  [key: string]: unknown;
}

/** OAuth logins the Management API can start. `webui` = CPA catches the redirect itself on this machine. */
export const OAUTH_PROVIDERS: { id: string; label: string; vendor: string; hint: string; webui: boolean; device?: boolean }[] = [
  { id: "claude", label: "Claude", vendor: "Anthropic", hint: "Claude Pro or Max subscription", webui: true },
  { id: "codex", label: "Codex", vendor: "OpenAI", hint: "ChatGPT Plus, Pro, Business", webui: true },
  { id: "antigravity", label: "Antigravity", vendor: "Google", hint: "Gemini and Claude through a Google account", webui: true },
  { id: "xai", label: "Grok", vendor: "xAI", hint: "SuperGrok / X Premium", webui: true },
  { id: "kimi", label: "Kimi", vendor: "Moonshot", hint: "kimi.com account", webui: false, device: true },
  { id: "kimi-ai", label: "Kimi (global)", vendor: "Moonshot", hint: "kimi.ai account", webui: false, device: true },
  { id: "devin", label: "Devin", vendor: "Cognition", hint: "Devin / Windsurf account", webui: true },
  { id: "meta", label: "Meta AI", vendor: "Meta", hint: "Meta account", webui: false },
];

/** Upstream API-key groups in config (api-keys.<provider>). */
export const KEY_PROVIDERS: { id: string; label: string; baseUrl: string; hint: string }[] = [
  { id: "claude", label: "Anthropic API", baseUrl: "https://api.anthropic.com", hint: "sk-ant-… keys, or any Anthropic-compatible endpoint" },
  { id: "codex", label: "OpenAI (Responses)", baseUrl: "https://api.openai.com/v1", hint: "OpenAI keys used for Codex-style models" },
  { id: "gemini", label: "Gemini API", baseUrl: "https://generativelanguage.googleapis.com", hint: "AI Studio keys (AIza…)" },
  { id: "openai-compatibility", label: "OpenAI-compatible", baseUrl: "https://openrouter.ai/api/v1", hint: "OpenRouter, a local llama.cpp/Ollama, any /chat/completions" },
  { id: "xai", label: "xAI API", baseUrl: "https://api.x.ai/v1", hint: "xai-… keys" },
  { id: "vertex", label: "Vertex AI", baseUrl: "", hint: "Google Cloud Vertex keys" },
];

/** How a client key is shown and grouped in usage: never the whole key. */
export const keyPreview = (key: string) => (key.length > 12 ? `${key.slice(0, 8)}…${key.slice(-4)}` : "••••");

/* ---------------- Traffic: full requests in ClickHouse (lib/proxy-capture.ts) ---------------- */

/** One proxied request as the Traffic list shows it: previews only; the raw log is fetched on demand. */
export interface TrafficRow {
  at: number;
  end: number;
  machine: string;
  file: string;
  requestId: string;
  url: string;
  status: number;
  model: string;
  stream: boolean;
  provider: string;
  account: string;
  attempts: number;
  userAgent: string;
  key: string;
  input: number;
  output: number;
  prompt: string;
  answer: string;
  bytes: number;
}

export interface TrafficPage {
  rows: TrafficRow[];
  more: boolean;
}

export interface TrafficStatus {
  db: { configured: boolean; machine: string | null; reachable: boolean; version: string | null; error: string | null };
  capture: { enabled: boolean; dir: string; pending: number; captured: number; lastAt: number | null; lastError: string | null };
  requestLog: boolean | null;
  rows: number | null;
  rawBytes: number | null;
  diskBytes: number | null;
}
