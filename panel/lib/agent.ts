/**
 * AI chat: Claude (through the Claude Agent SDK and this machine's Claude Code
 * login, or the panel's own AI proxy with FLEET_AI_VIA_PROXY=1) acting on fleet
 * machines over ssh.
 *
 * Claude Code's own tools are switched off; the model only gets the three tools
 * below, which run on a fleet machine through the same multiplexed ssh the rest
 * of the panel uses. In "ask" mode every command and file write waits for the
 * user to approve it in the browser.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSdkMcpServer, query, tool, type CanUseTool, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AiMode, Chat, ChatEvent, ChatSummary, AiServerMsg, ToolName } from "./ai-types";
import type { ActivityStatus } from "./activity-types";
import { logActivity, updateActivity } from "./audit";
import { PROXY_CONFIG, baseUrl } from "./cpa";
import { getNode, loadFleet } from "./fleet";
import { inventoryMarkdown } from "./skill";
import { STATE_DIR } from "./net";
import { SSH_BASE_OPTS, shq, sshDest } from "./ssh";
import type { FleetNode } from "./types";

export const AI_MODEL = process.env.FLEET_AI_MODEL || "claude-opus-5-5";
const AI_EFFORT = (process.env.FLEET_AI_EFFORT || "medium") as "low" | "medium" | "high" | "xhigh" | "max";

/**
 * With FLEET_AI_VIA_PROXY=1 the chat goes through the panel's AI proxy (its first client
 * key) instead of a Claude Code login on this machine: it then uses the proxy's accounts,
 * and every turn lands in the Traffic log.
 */
function aiProxyEnv(): Record<string, string> {
  if (process.env.FLEET_AI_VIA_PROXY !== "1") return {};
  let key: string | undefined;
  try {
    const text = readFileSync(PROXY_CONFIG, "utf8");
    key = (text.match(/^access:[ \t]*\n[ \t]+api-keys:[ \t]*\n[ \t]+-[ \t]*"?([^"\s]+)/m) ?? text.match(/^api-keys:[ \t]*\n[ \t]+-[ \t]*"?([^"\s]+)/m))?.[1];
  } catch {
    /* no proxy */
  }
  if (!key) throw new Error("FLEET_AI_VIA_PROXY is set, but the AI proxy has no client key (Proxy → API keys)");
  return { ANTHROPIC_BASE_URL: baseUrl(), ANTHROPIC_AUTH_TOKEN: key };
}

const CHATS_FILE = path.join(STATE_DIR, "ai-chats.json");
/** Working directory for the agent process; Claude Code keeps its session transcripts per directory. */
const AI_CWD = path.join(STATE_DIR, "ai");
const MAX_CHATS = 60;
/** What a tool event keeps for the UI. */
const MAX_EVENT_OUTPUT = 64_000;
/** What the model gets back from one tool call. */
const MAX_MODEL_OUTPUT = 30_000;
const MAX_READ_BYTES = 256_000;
const MCP_PREFIX = "mcp__fleet__";

/* ---------------- state ---------------- */

interface StoredChat extends Chat {
  /** Claude Code session id, for resuming the conversation on the next turn. */
  sessionId: string | null;
}

interface Live {
  /** Hard stop: kills the Claude Code process. */
  abort: AbortController;
  /** Kills commands that are running on machines. */
  tools: AbortController;
  query: Query | null;
  /** Ends the prompt stream, which lets the Claude Code process exit. */
  end: () => void;
  approvals: Map<string, (r: { allow: boolean; note?: string }) => void>;
  /** tool+target → tool_use ids waiting for their handler, so the handler can find its event. */
  pendingIds: Map<string, string[]>;
  stopped: boolean;
}

const chats = new Map<string, StoredChat>();
const live = new Map<string, Live>();
let broadcast: (msg: AiServerMsg) => void = () => {};

export function setBroadcast(fn: (msg: AiServerMsg) => void) {
  broadcast = fn;
}

function load() {
  try {
    const raw = JSON.parse(readFileSync(CHATS_FILE, "utf8")) as StoredChat[];
    for (const c of raw) {
      // Anything in flight died with the previous server process.
      if (c.status !== "idle") {
        c.status = "idle";
        for (const e of c.events)
          if (e.k === "tool" && (e.status === "queued" || e.status === "approval" || e.status === "running")) {
            e.status = "error";
            e.note = "Interrupted: the panel restarted";
          }
      }
      chats.set(c.id, c);
    }
  } catch {
    /* first run */
  }
}
load();

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
      const list = [...chats.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS);
      const tmp = `${CHATS_FILE}.tmp`;
      writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 });
      renameSync(tmp, CHATS_FILE);
    } catch (err) {
      console.error("[ai] couldn't save chats:", (err as Error).message);
    }
  }, 800);
}

function summary(c: StoredChat): ChatSummary {
  return { id: c.id, title: c.title, node: c.node, mode: c.mode, status: c.status, createdAt: c.createdAt, updatedAt: c.updatedAt };
}

export function listChats(): ChatSummary[] {
  return [...chats.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(summary);
}

export function getChat(id: string): Chat | null {
  const c = chats.get(id);
  if (!c) return null;
  const { sessionId: _sessionId, ...rest } = c;
  void _sessionId;
  return rest;
}

function touch(c: StoredChat) {
  c.updatedAt = Date.now();
  save();
  broadcast({ t: "chats", list: listChats() });
}

function setStatus(c: StoredChat) {
  const l = live.get(c.id);
  const next = !l ? "idle" : l.approvals.size > 0 ? "approval" : "running";
  if (c.status !== next) {
    c.status = next;
    touch(c);
  }
}

/* ---------------- activity log ---------------- */

/** chat id → activity row of the prompt being worked on; the AI's commands are logged under it. */
const turnAudit = new Map<string, number>();
/** tool_use id → its activity row and the last status written there. */
const toolAudit = new Map<string, { id: number; status: string; approvedBy?: string }>();

const TOOL_STATUS: Record<string, ActivityStatus> = {
  queued: "pending",
  approval: "approval",
  running: "running",
  done: "ok",
  error: "error",
  denied: "denied",
};

function auditTool(c: StoredChat, ev: Extract<ChatEvent, { k: "tool" }>) {
  const status = TOOL_STATUS[ev.status] ?? "info";
  const known = toolAudit.get(ev.id);
  if (!known) {
    const id = logActivity({
      source: "ai",
      kind: `ai.${ev.tool}`,
      actor: "AI",
      node: ev.machine,
      summary: ev.summary,
      detail: ev.output || null,
      status,
      exitCode: ev.exitCode,
      ms: ev.ms,
      parent: turnAudit.get(c.id) ?? null,
      ref: ev.id,
      meta: {
        chat: c.id,
        chatTitle: c.title,
        mode: c.mode,
        ...(ev.summary.length > 4000 ? { script: ev.summary.slice(0, 64_000) } : {}),
        ...(ev.content != null ? { content: ev.content } : {}),
        ...(ev.note ? { note: ev.note } : {}),
      },
    });
    toolAudit.set(ev.id, { id, status });
    return;
  }
  // Streaming output only reaches the log when the command finishes.
  if (known.status === status) return;
  known.status = status;
  updateActivity(known.id, {
    status,
    detail: ev.output || null,
    exitCode: ev.exitCode,
    ms: ev.ms,
    meta: ev.note ? { note: ev.note } : undefined,
  });
  if (status !== "running" && status !== "pending" && status !== "approval") toolAudit.delete(ev.id);
}

function emit(c: StoredChat, event: ChatEvent) {
  if (event.k === "tool") auditTool(c, event);
  const i = c.events.findIndex((e) => e.id === event.id);
  if (i >= 0) c.events[i] = event;
  else c.events.push(event);
  save();
  broadcast({ t: "event", chat: c.id, event });
}

/* ---------------- running things on machines ---------------- */

interface RunResult {
  output: string;
  code: number | null;
  ms: number;
  timedOut: boolean;
}

/** Runs a bash script on a machine, streaming combined stdout+stderr to onOutput. */
function runOn(
  node: FleetNode,
  script: string,
  { timeoutMs, signal, onOutput }: { timeoutMs: number; signal?: AbortSignal; onOutput?: (all: string) => void },
): Promise<RunResult> {
  const start = performance.now();
  let file: string;
  let args: string[];
  if (node.local) {
    file = "bash";
    args = ["-l", "-s"];
  } else if (node.sshTarget) {
    file = "ssh";
    args = [...SSH_BASE_OPTS, "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "LogLevel=ERROR", "-T", ...sshDest(node), "bash -l -s"];
  } else {
    return Promise.resolve({ output: `${node.id} has no connection set up in the inventory, so it can't be reached.`, code: 255, ms: 0, timedOut: false });
  }

  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], cwd: os.homedir(), env: { ...process.env, TERM: "dumb", NO_COLOR: "1" } });
    let output = "";
    let dropped = 0;
    let timedOut = false;
    const add = (d: Buffer) => {
      output += d.toString();
      // keep the tail: that's where errors and summaries end up
      if (output.length > 1_000_000) {
        dropped += output.length - 800_000;
        output = output.slice(-800_000);
      }
      onOutput?.(output);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const kill = () => child.kill("SIGKILL");
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    const done = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", kill);
      if (dropped) output = `[… ${dropped} earlier characters dropped …]\n${output}`;
      resolve({ output, code, ms: Math.round(performance.now() - start), timedOut });
    };
    child.on("error", (err) => {
      output += String(err);
      done(null);
    });
    child.on("close", done);
    child.stdin.on("error", () => {});
    child.stdin.end(script);
  });
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${text.slice(0, head)}\n\n[… ${text.length - max} characters omitted …]\n\n${text.slice(-tail)}`;
}

/* ---------------- the agent ---------------- */

function targetKey(toolName: string, input: Record<string, unknown>): string {
  return `${toolName}|${String(input.machine ?? "")}|${String(input.command ?? input.path ?? "")}`;
}

function describe(toolName: ToolName, input: Record<string, unknown>): string {
  return String(toolName === "run_command" ? (input.command ?? "") : (input.path ?? ""));
}

function systemPrompt(c: StoredChat): string {
  const nodes = loadFleet();
  const panel = nodes.find((n) => n.local);
  const def = getNode(c.node);
  const fleetMd = inventoryMarkdown(nodes).trim();
  return `You are the AI assistant built into the user's "fleet" control panel, a web app running on ${panel ? `the machine "${panel.id}"` : "one of their machines"}. You do things on the user's computers with tools that run over SSH. The user is chatting with you from the panel, often on a phone.

Default machine for this chat: ${c.node}${def ? ` (${[def.kind, def.model, def.os].filter(Boolean).join("; ")})` : ""}. Every tool takes an optional \`machine\`; leave it out to use the default. Use other machines when the user asks for it or the task clearly involves them.

This is the user's inventory, with each machine's hardware (indexed automatically), addresses, services and notes:
<fleet>
${fleetMd}
</fleet>

How the tools behave:
- run_command runs a bash script as the user's own account, non-interactively: no TTY and empty stdin. Each call is a fresh login shell, so \`cd\` and variables don't carry over between calls.
- Each command has a timeout (default 120 s, at most 900 s). Don't start anything that runs forever in the foreground; use systemd, \`nohup … &\` or \`timeout\` for that.
- sudo only works without a password prompt. Use \`sudo -n\`; if it says a password is required, stop and tell the user, and give them the exact command to run in the panel's terminal.
- Prefer non-interactive flags (\`--noconfirm\`, \`-y\`, \`--no-pager\`, \`systemctl … --no-pager\`, \`journalctl -n 100 --no-pager\`).
- Depending on the chat's mode, the user may have to approve each command and file write before it runs. A denied call comes back with the user's reason; follow it rather than retrying the same thing.
- Output is truncated in the middle when it is very long, so filter it (\`grep\`, \`tail\`, \`head\`, \`--lines\`) when you can.

Working style:
- Look before you change things. Check the current state, make small reversible changes, and verify the result.
- Before anything destructive or disruptive (deleting data, rebooting, stopping a service the user relies on, large upgrades), say what you are about to do in one line first.
- When you're done, reply briefly in Markdown: what you found or changed, and anything the user still needs to do. Keep it short; the chat is often read on a phone.`;
}

function fleetServer(c: StoredChat, l: Live) {
  const ids = loadFleet().map((n) => n.id) as [string, ...string[]];
  const machine = z.enum(ids).optional().describe(`Which machine to act on. Defaults to the chat's machine.`);

  const findEvent = (toolName: ToolName, input: Record<string, unknown>) => {
    const key = targetKey(toolName, input);
    const id = l.pendingIds.get(key)?.shift();
    const ev = id ? c.events.find((e) => e.id === id) : undefined;
    return ev?.k === "tool" ? ev : null;
  };

  const resolveNode = (m: string | undefined) => {
    const node = getNode(m ?? c.node);
    if (!node) throw new Error(`Unknown machine "${m}"`);
    return node;
  };

  /** Runs a script for a tool call, keeping its event in the UI up to date. */
  const exec = async (toolName: ToolName, input: Record<string, unknown>, script: string, timeoutMs: number) => {
    const node = resolveNode(input.machine as string | undefined);
    const found = findEvent(toolName, input);
    const ev: Extract<ChatEvent, { k: "tool" }> = found ?? {
      k: "tool",
      id: randomUUID(),
      at: Date.now(),
      tool: toolName,
      machine: node.id,
      summary: describe(toolName, input),
      status: "running",
      output: "",
      exitCode: null,
      ms: null,
    };
    ev.status = "running";
    emit(c, { ...ev });
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const r = await runOn(node, script, {
      timeoutMs,
      signal: l.tools.signal,
      onOutput: (all) => {
        if (toolName !== "run_command") return;
        ev.output = all.slice(-MAX_EVENT_OUTPUT);
        const now = Date.now();
        if (now - last > 250) {
          last = now;
          emit(c, { ...ev });
        } else if (!timer) {
          timer = setTimeout(() => {
            timer = null;
            last = Date.now();
            if (ev.status === "running") emit(c, { ...ev });
          }, 250);
        }
      },
    });
    if (timer) clearTimeout(timer);
    ev.output = r.output.slice(-MAX_EVENT_OUTPUT);
    ev.exitCode = r.code;
    ev.ms = r.ms;
    ev.status = r.code === 0 ? "done" : "error";
    if (r.timedOut) ev.note = `Timed out after ${Math.round(timeoutMs / 1000)} s`;
    else if (l.stopped) ev.note = "Stopped";
    emit(c, { ...ev });
    return { r, node };
  };

  return createSdkMcpServer({
    name: "fleet",
    version: "1.0.0",
    alwaysLoad: true,
    // generous: run_command enforces its own timeout
    timeout: 960_000,
    tools: [
      tool(
        "run_command",
        "Run a bash script on a fleet machine over SSH and return its combined stdout and stderr plus the exit code. Non-interactive: no TTY, empty stdin, fresh login shell each call.",
        {
          command: z.string().min(1).max(20_000).describe("The bash script to run"),
          machine,
          timeout_seconds: z.number().int().min(1).max(900).optional().describe("Kill the command after this many seconds (default 120)"),
        },
        async (args) => {
          const { r, node } = await exec("run_command", args, args.command, (args.timeout_seconds ?? 120) * 1000);
          const status = r.timedOut
            ? `timed out after ${args.timeout_seconds ?? 120} s`
            : l.stopped
              ? "stopped by the user"
              : `exit code ${r.code}`;
          return {
            content: [{ type: "text", text: `[${node.id}] ${status}, ${(r.ms / 1000).toFixed(1)} s\n${clip(r.output, MAX_MODEL_OUTPUT) || "(no output)"}` }],
            isError: r.code !== 0,
          };
        },
      ),
      tool(
        "read_file",
        `Read a text file on a fleet machine (up to ${MAX_READ_BYTES / 1000} kB). Use \`~/\` for the home directory.`,
        { path: z.string().min(1).max(4096), machine },
        async (args) => {
          const p = args.path.startsWith("~/") ? `"$HOME"/${shq(args.path.slice(2))}` : shq(args.path);
          const script = `f=${p}; if [ ! -e "$f" ]; then echo "No such file: $f" >&2; exit 2; fi; if [ -d "$f" ]; then ls -la "$f"; exit 0; fi; if [ -r "$f" ]; then head -c ${MAX_READ_BYTES} "$f"; else sudo -n head -c ${MAX_READ_BYTES} "$f"; fi`;
          const { r } = await exec("read_file", args, script, 30_000);
          return { content: [{ type: "text", text: clip(r.output, MAX_READ_BYTES) || "(empty file)" }], isError: r.code !== 0 };
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "write_file",
        "Create or overwrite a text file on a fleet machine with the given content. Parent directories are created. Use `~/` for the home directory. For system files you can't write as the user, it tries passwordless sudo.",
        { path: z.string().min(1).max(4096), content: z.string().max(2_000_000), machine },
        async (args) => {
          const p = args.path.startsWith("~/") ? `"$HOME"/${shq(args.path.slice(2))}` : shq(args.path);
          const b64 = Buffer.from(args.content, "utf8").toString("base64");
          const script = [
            `f=${p}`,
            `data=$(cat <<'B64'\n${b64.replace(/(.{76})/g, "$1\n")}\nB64\n)`,
            `mkdir -p "$(dirname "$f")" 2>/dev/null`,
            `if { [ -e "$f" ] && [ -w "$f" ]; } || { [ ! -e "$f" ] && [ -w "$(dirname "$f")" ]; }; then printf '%s' "$data" | base64 -d > "$f"`,
            `else sudo -n mkdir -p "$(dirname "$f")" && printf '%s' "$data" | base64 -d | sudo -n tee "$f" >/dev/null; fi`,
            `rc=$?; [ $rc -eq 0 ] && echo "Wrote $(wc -c < "$f") bytes to $f"; exit $rc`,
          ].join("\n");
          const { r } = await exec("write_file", args, script, 60_000);
          return { content: [{ type: "text", text: r.output || `exit code ${r.code}` }], isError: r.code !== 0 };
        },
      ),
    ],
  });
}

function permission(c: StoredChat, l: Live): CanUseTool {
  return async (name, input, { toolUseID, signal }) => {
    if (!name.startsWith(MCP_PREFIX)) return { behavior: "deny", message: "Only the fleet tools are available." };
    const toolName = name.slice(MCP_PREFIX.length) as ToolName;
    let ev = c.events.find((e) => e.id === toolUseID);
    if (!ev || ev.k !== "tool") {
      ev = toolEvent(c, toolUseID, toolName, input);
      emit(c, ev);
    }
    const tev = ev;
    const key = targetKey(toolName, input);
    const queue = () => {
      const q = l.pendingIds.get(key) ?? [];
      q.push(toolUseID);
      l.pendingIds.set(key, q);
    };

    if (toolName === "read_file" || c.mode === "auto") {
      queue();
      return { behavior: "allow", updatedInput: input };
    }

    tev.status = "approval";
    emit(c, { ...tev });
    const answer = await new Promise<{ allow: boolean; note?: string }>((resolve) => {
      l.approvals.set(toolUseID, resolve);
      setStatus(c);
      signal.addEventListener("abort", () => resolve({ allow: false, note: "Stopped" }), { once: true });
    });
    l.approvals.delete(toolUseID);
    setStatus(c);
    if (answer.allow) {
      tev.status = "queued";
      emit(c, { ...tev });
      queue();
      return { behavior: "allow", updatedInput: input };
    }
    tev.status = "denied";
    tev.note = answer.note;
    emit(c, { ...tev });
    return {
      behavior: "deny",
      message: answer.note ? `The user declined this: ${answer.note}` : "The user declined this. Ask them how they'd like to proceed instead of retrying it.",
      interrupt: l.stopped,
    };
  };
}

function toolEvent(c: StoredChat, id: string, toolName: ToolName, input: Record<string, unknown>): Extract<ChatEvent, { k: "tool" }> {
  return {
    k: "tool",
    id,
    at: Date.now(),
    tool: toolName,
    machine: typeof input.machine === "string" ? input.machine : c.node,
    summary: describe(toolName, input),
    content: toolName === "write_file" && typeof input.content === "string" ? input.content.slice(0, MAX_EVENT_OUTPUT) : undefined,
    status: "queued",
    output: "",
    exitCode: null,
    ms: null,
  };
}

async function runTurn(c: StoredChat, text: string) {
  let end = () => {};
  const ended = new Promise<void>((resolve) => (end = resolve));
  const l: Live = {
    abort: new AbortController(),
    tools: new AbortController(),
    query: null,
    end,
    approvals: new Map(),
    pendingIds: new Map(),
    stopped: false,
  };
  live.set(c.id, l);
  setStatus(c);
  mkdirSync(AI_CWD, { recursive: true, mode: 0o700 });

  const streamed = new Set<string>();
  let msgId = "";
  const textEvents = new Map<string, Extract<ChatEvent, { k: "text" }>>();
  const started = Date.now();
  let done: Extract<ChatEvent, { k: "done" }> | null = null;

  try {
    // Streaming input (rather than a plain string) is what makes interrupt() available for Stop.
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
      await ended;
    }
    const q = query({
      prompt: prompt(),
      options: {
        model: AI_MODEL,
        effort: AI_EFFORT,
        // no built-in Claude Code tools, no user/project settings, hooks or CLAUDE.md
        tools: [],
        settingSources: [],
        mcpServers: { fleet: fleetServer(c, l) },
        strictMcpConfig: true,
        permissionMode: "default",
        canUseTool: permission(c, l),
        systemPrompt: systemPrompt(c),
        resume: c.sessionId ?? undefined,
        includePartialMessages: true,
        cwd: AI_CWD,
        abortController: l.abort,
        env: { ...process.env, ...aiProxyEnv(), CLAUDE_AGENT_SDK_CLIENT_APP: "fleet-control-panel/0.1" },
      },
    });
    l.query = q;

    for await (const m of q as AsyncIterable<SDKMessage>) {
      if ("session_id" in m && typeof m.session_id === "string" && m.session_id && c.sessionId !== m.session_id) {
        c.sessionId = m.session_id;
        save();
      }
      switch (m.type) {
        case "stream_event": {
          // after Stop, drop whatever the model still says
          if (m.parent_tool_use_id || l.stopped) break;
          const ev = m.event;
          if (ev.type === "message_start") msgId = ev.message.id;
          else if (ev.type === "content_block_start" && ev.content_block.type === "text") {
            const e = { k: "text" as const, id: `${msgId}:${ev.index}`, at: Date.now(), text: "" };
            textEvents.set(e.id, e);
            streamed.add(msgId);
            emit(c, { ...e });
          } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            const e = textEvents.get(`${msgId}:${ev.index}`);
            if (e) {
              e.text += ev.delta.text;
              const stored = c.events.find((x) => x.id === e.id);
              if (stored && stored.k === "text") stored.text = e.text;
              save();
              broadcast({ t: "delta", chat: c.id, id: e.id, text: ev.delta.text });
            }
          }
          break;
        }
        case "assistant": {
          if (m.parent_tool_use_id || l.stopped) break;
          const mid = m.message.id;
          m.message.content.forEach((block, i) => {
            if (block.type === "text" && !streamed.has(mid) && block.text.trim()) {
              emit(c, { k: "text", id: `${mid}:${i}`, at: Date.now(), text: block.text });
            } else if (block.type === "tool_use" && block.name.startsWith(MCP_PREFIX)) {
              if (!c.events.some((e) => e.id === block.id)) {
                emit(c, toolEvent(c, block.id, block.name.slice(MCP_PREFIX.length) as ToolName, block.input as Record<string, unknown>));
              }
            }
          });
          if (m.error) emit(c, { k: "error", id: randomUUID(), at: Date.now(), text: assistantError(m.error) });
          break;
        }
        case "result": {
          if (m.subtype !== "success") {
            const errs = "errors" in m && Array.isArray(m.errors) ? m.errors.join("\n") : "";
            if (!l.stopped) emit(c, { k: "error", id: randomUUID(), at: Date.now(), text: errs || `Stopped: ${m.subtype.replace(/_/g, " ")}` });
          }
          done = {
            k: "done",
            id: randomUUID(),
            at: Date.now(),
            costUsd: m.total_cost_usd ?? 0,
            ms: m.duration_ms ?? Date.now() - started,
            turns: m.num_turns ?? 0,
            stopped: l.stopped || undefined,
          };
          break;
        }
      }
      // The turn is over; don't wait for the Claude Code process to shut down.
      if (done) break;
    }
  } catch (err) {
    if (!l.stopped) emit(c, { k: "error", id: randomUUID(), at: Date.now(), text: friendlyError(err as Error) });
  } finally {
    l.end();
    for (const resolve of l.approvals.values()) resolve({ allow: false, note: "Stopped" });
    for (const e of c.events)
      if (e.k === "tool" && (e.status === "queued" || e.status === "approval" || e.status === "running")) {
        emit(c, { ...e, status: "denied", note: l.stopped ? "Stopped" : "Didn't run" });
      }
    live.delete(c.id);
    setStatus(c);
    if (!done && l.stopped) done = { k: "done", id: randomUUID(), at: Date.now(), costUsd: 0, ms: Date.now() - started, turns: 0, stopped: true };
    if (done) emit(c, done);
    touch(c);
    const auditId = turnAudit.get(c.id);
    if (auditId != null) {
      turnAudit.delete(c.id);
      const lastUser = c.events.map((e) => e.k).lastIndexOf("user");
      const after = c.events.slice(lastUser + 1);
      const reply = after.flatMap((e) => (e.k === "text" ? [e.text] : [])).join("\n\n");
      const errors = after.flatMap((e) => (e.k === "error" ? [e.text] : []));
      updateActivity(auditId, {
        status: l.stopped ? "denied" : errors.length ? "error" : "ok",
        ms: Date.now() - started,
        meta: {
          reply: reply.slice(-20_000),
          ...(errors.length ? { errors } : {}),
          ...(l.stopped ? { note: "Stopped" } : {}),
          ...(done ? { costUsd: done.costUsd, turns: done.turns } : {}),
        },
      });
    }
  }
}

function assistantError(e: unknown): string {
  const s = String(e);
  if (s === "authentication_failed") return "Claude Code isn't signed in on the panel's machine. Run `claude` there and use /login.";
  if (s === "rate_limit") return "Rate limited. Try again in a bit.";
  if (s === "billing_error") return "Billing problem with the Claude account on the panel's machine.";
  return `Claude returned an error: ${s.replace(/_/g, " ")}`;
}

function friendlyError(err: Error): string {
  const msg = err.message || String(err);
  if (/ENOENT|not found|spawn/i.test(msg) && /claude/i.test(msg)) return `Couldn't start Claude Code: ${msg}`;
  if (/login|auth|credential|401/i.test(msg)) return `Claude Code isn't signed in on the panel's machine (${msg}). Run \`claude\` there and use /login.`;
  return msg;
}

/* ---------------- commands from the browser ---------------- */

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "New chat";
}

export function createChat(node: string, mode: AiMode, text: string, actor = "unknown"): string {
  if (!getNode(node)) throw new Error(`Unknown machine "${node}"`);
  const now = Date.now();
  const c: StoredChat = {
    id: randomUUID(),
    title: titleFrom(text),
    node,
    mode: mode === "auto" ? "auto" : "ask",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    events: [],
    sessionId: null,
  };
  chats.set(c.id, c);
  // prune the oldest idle chats
  const extra = [...chats.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(MAX_CHATS);
  for (const old of extra) if (!live.has(old.id)) chats.delete(old.id);
  touch(c);
  sendMessage(c.id, text, actor);
  return c.id;
}

export function sendMessage(id: string, text: string, actor = "unknown") {
  const c = chats.get(id);
  if (!c) throw new Error("No such chat");
  const t = text.trim();
  if (!t) return;
  if (t.length > 50_000) throw new Error("Message too long");
  if (live.has(id)) throw new Error("Still working on the last message. Stop it first, or wait.");
  emit(c, { k: "user", id: randomUUID(), at: Date.now(), text: t });
  turnAudit.set(
    id,
    logActivity({
      source: "ai",
      kind: "ai.prompt",
      actor,
      node: c.node,
      summary: t.split("\n")[0].slice(0, 300),
      detail: t,
      status: "running",
      ref: c.id,
      meta: { chat: c.id, chatTitle: c.title, mode: c.mode },
    }),
  );
  touch(c);
  void runTurn(c, t);
}

export function answerApproval(id: string, toolId: string, allow: boolean, note?: string, always?: boolean, actor = "unknown") {
  const c = chats.get(id);
  const l = live.get(id);
  if (!c || !l) return;
  const t = toolAudit.get(toolId);
  if (t && l.approvals.has(toolId))
    updateActivity(t.id, { meta: allow ? { approvedBy: actor } : { deniedBy: actor, ...(note?.trim() ? { denyReason: note.trim().slice(0, 2000) } : {}) } });
  if (allow && always && c.mode !== "auto") {
    c.mode = "auto";
    logActivity({ source: "ai", kind: "ai.mode", actor, node: c.node, summary: `Switched chat "${c.title}" to auto-run (commands run without asking)`, status: "info", parent: turnAudit.get(c.id) ?? null, meta: { chat: c.id } });
    for (const tid of l.approvals.keys()) {
      const other = toolAudit.get(tid);
      if (tid !== toolId && other) updateActivity(other.id, { meta: { approvedBy: `${actor} (approve all)` } });
    }
    touch(c);
    // approve everything else that is waiting, too
    for (const [tid, resolve] of l.approvals) if (tid !== toolId) resolve({ allow: true });
  }
  l.approvals.get(toolId)?.({ allow, note: note?.trim().slice(0, 2000) || undefined });
}

export function stopChat(id: string, actor?: string) {
  const l = live.get(id);
  if (!l || l.stopped) return;
  const c = chats.get(id);
  if (actor && c)
    logActivity({ source: "ai", kind: "ai.stop", actor, node: c.node, summary: "Stopped the AI", status: "info", parent: turnAudit.get(id) ?? null, meta: { chat: id } });
  l.stopped = true;
  for (const resolve of l.approvals.values()) resolve({ allow: false, note: "Stopped" });
  l.tools.abort();
  // Interrupt like Esc in Claude Code, so the transcript records it; kill the process if that hangs.
  const hard = () => {
    if (live.get(id) === l) l.abort.abort();
  };
  if (l.query) l.query.interrupt().catch(hard);
  setTimeout(hard, l.query ? 5000 : 0);
}

export function updateChat(id: string, patch: { mode?: AiMode; node?: string }, actor = "unknown") {
  const c = chats.get(id);
  if (!c) return;
  if ((patch.mode === "ask" || patch.mode === "auto") && patch.mode !== c.mode) {
    c.mode = patch.mode;
    logActivity({
      source: "ai",
      kind: "ai.mode",
      actor,
      node: c.node,
      summary: patch.mode === "auto" ? `Switched chat "${c.title}" to auto-run (commands run without asking)` : `Switched chat "${c.title}" to ask before running`,
      status: "info",
      meta: { chat: c.id },
    });
  }
  if (patch.node && getNode(patch.node) && patch.node !== c.node) {
    logActivity({ source: "ai", kind: "ai.machine", actor, node: patch.node, summary: `Pointed chat "${c.title}" at ${patch.node} (was ${c.node})`, status: "info", meta: { chat: c.id } });
    c.node = patch.node;
  }
  touch(c);
  broadcast({ t: "chat", chat: getChat(id)! });
}

export function deleteChat(id: string, actor = "unknown") {
  const c = chats.get(id);
  if (c) logActivity({ source: "ai", kind: "ai.delete", actor, node: c.node, summary: `Deleted chat "${c.title}"`, status: "info", meta: { chat: id } });
  stopChat(id);
  chats.delete(id);
  save();
  broadcast({ t: "chats", list: listChats() });
}
