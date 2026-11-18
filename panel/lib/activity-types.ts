/* Shared between the activity log on the server (lib/audit.ts) and the Activity page. */

/** terminal: actions in the terminal dock; ai: the AI chat (removed; kept for old entries); panel: buttons like Wake; auth: sign-ins and devices; proxy: the AI proxy's accounts, keys and settings. */
export type ActivitySource = "terminal" | "ai" | "panel" | "auth" | "proxy";

/** ok/error: finished. denied: the user declined it. approval: waiting for the user. */
export type ActivityStatus = "ok" | "error" | "running" | "pending" | "approval" | "denied" | "info";

export interface ActivityEvent {
  id: number;
  at: number;
  source: ActivitySource;
  /** e.g. terminal.update, terminal.input, ai.run_command, ai.prompt, panel.wake, auth.login */
  kind: string;
  /** Who did it: a device name and IP, "this machine", or "AI" for the agent. */
  actor: string;
  node: string | null;
  /** One line: the command, the prompt, what happened. */
  summary: string;
  /** Longer text: the full script, output, file contents. */
  detail: string | null;
  status: ActivityStatus | null;
  exitCode: number | null;
  ms: number | null;
  /** The session or chat this event belongs to. */
  parent: number | null;
  ref: string | null;
  meta: Record<string, unknown>;
  endedAt: number | null;
  /** Number of events under this one (typed lines, AI commands…). */
  children: number;
  hasTranscript: boolean;
}

export interface ActivityQuery {
  node?: string;
  source?: ActivitySource;
  q?: string;
  /** Older than this id, for paging. */
  before?: number;
  parent?: number;
  limit?: number;
}
