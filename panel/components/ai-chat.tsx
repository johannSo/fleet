"use client";

import clsx from "clsx";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FilePen,
  FileText,
  MessageSquarePlus,
  MoreHorizontal,
  ShieldCheck,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import type { AiClientMsg, AiMode, AiServerMsg, Chat, ChatEvent, ChatSummary } from "@/lib/ai-types";
import { ago } from "@/lib/format";
import { useFleet } from "./fleet-provider";
import { Markdown } from "./markdown";
import { useTerminals } from "./terminal-provider";
import { ACCENT, Button, IconButton, Menu, Spinner, StatusDot, Tooltip } from "./ui";

type ToolEvent = Extract<ChatEvent, { k: "tool" }>;

/* ---------------- connection ---------------- */

function useAi(activeId: string | null) {
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [chat, setChat] = useState<Chat | null>(null);
  const [connected, setConnected] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const queue = useRef<AiClientMsg[]>([]);
  const pending = useRef(new Map<string, (id: string | null) => void>());
  const active = useRef(activeId);

  const send = useCallback((msg: AiClientMsg) => {
    const s = ws.current;
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(msg));
    else queue.current.push(msg);
  }, []);

  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;
    const connect = () => {
      const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/ai`);
      ws.current = sock;
      sock.onopen = () => {
        retry = 0;
        setConnected(true);
        if (active.current) sock.send(JSON.stringify({ t: "open", chat: active.current } satisfies AiClientMsg));
        for (const m of queue.current.splice(0)) sock.send(JSON.stringify(m));
      };
      sock.onmessage = (ev) => {
        const msg: AiServerMsg = JSON.parse(ev.data);
        switch (msg.t) {
          case "hello":
            setModel(msg.model);
            break;
          case "chats":
            setChats(msg.list);
            break;
          case "chat":
            if (msg.chat.id === active.current) setChat(msg.chat);
            break;
          case "created":
            pending.current.get(msg.nonce)?.(msg.chat);
            pending.current.delete(msg.nonce);
            break;
          case "event":
            if (msg.chat !== active.current) break;
            setChat((c) => {
              if (!c || c.id !== msg.chat) return c;
              const i = c.events.findIndex((e) => e.id === msg.event.id);
              const events = i >= 0 ? c.events.map((e, j) => (j === i ? msg.event : e)) : [...c.events, msg.event];
              return { ...c, events };
            });
            break;
          case "delta":
            if (msg.chat !== active.current) break;
            setChat((c) => {
              if (!c || c.id !== msg.chat) return c;
              return { ...c, events: c.events.map((e) => (e.id === msg.id && e.k === "text" ? { ...e, text: e.text + msg.text } : e)) };
            });
            break;
          case "error":
            toast.error(msg.message);
            for (const [nonce, resolve] of pending.current) {
              resolve(null);
              pending.current.delete(nonce);
            }
            break;
        }
      };
      sock.onclose = () => {
        setConnected(false);
        if (stopped) return;
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, 300 * 2 ** retry);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws.current?.close();
    };
  }, []);

  useEffect(() => {
    active.current = activeId;
    if (activeId) send({ t: "open", chat: activeId });
  }, [activeId, send]);

  const create = useCallback(
    (node: string, mode: AiMode, text: string) =>
      new Promise<string | null>((resolve) => {
        const nonce = Math.random().toString(36).slice(2);
        pending.current.set(nonce, resolve);
        send({ t: "new", node, mode, text, nonce });
      }),
    [send],
  );

  // the list carries the freshest status/mode/node; the open chat carries the events
  const summary = chats.find((c) => c.id === activeId);
  const opened = chat?.id === activeId ? chat : null;
  const current = opened && summary ? { ...opened, ...summary } : opened;
  return { chats, chat: current, connected, model, send, create };
}

const subscribeTick = (cb: () => void) => {
  const t = setInterval(cb, 1000);
  return () => clearInterval(t);
};
function useNow(): number {
  return useSyncExternalStore(
    subscribeTick,
    () => Math.floor(Date.now() / 1000) * 1000,
    () => 0,
  );
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/* ---------------- page ---------------- */

export function AiView() {
  return (
    <Suspense fallback={null}>
      <AiInner />
    </Suspense>
  );
}

function AiInner() {
  const params = useSearchParams();
  const router = useRouter();
  const activeId = params.get("c");
  const ai = useAi(activeId);
  const open = (id: string | null) => router.push(id ? `/ai?c=${id}` : "/ai");

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-[264px] shrink-0 flex-col border-r border-line bg-panel/40 lg:flex">
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <span className="px-1 text-[10.5px] font-semibold tracking-[0.09em] text-fg-4 uppercase">Chats</span>
          <Button size="xs" variant="subtle" icon={MessageSquarePlus} onClick={() => open(null)}>
            New
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {ai.chats.length === 0 && <p className="px-2 py-3 text-[12.5px] text-fg-5">No chats yet.</p>}
          {ai.chats.map((c) => (
            <ChatRow key={c.id} c={c} active={c.id === activeId} onClick={() => open(c.id)} />
          ))}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {activeId ? (
          <Conversation key={activeId} ai={ai} onBack={() => open(null)} />
        ) : (
          <StartScreen ai={ai} onOpen={(id) => open(id)} defaultNode={params.get("node")} />
        )}
      </div>
    </div>
  );
}

function ChatRow({ c, active, onClick, big }: { c: ChatSummary; active?: boolean; onClick: () => void; big?: boolean }) {
  const fleet = useFleet();
  const now = useNow();
  const a = ACCENT[fleet.accent(c.node)];
  return (
    <button
      onClick={onClick}
      className={clsx(
        "flex w-full cursor-pointer items-center gap-2.5 text-left transition-colors",
        big ? "min-h-14 rounded-xl px-3 py-2.5 active:bg-hl" : "rounded-md px-2.5 py-2",
        active ? "bg-hl" : "hover:bg-hover",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className={clsx("truncate font-medium text-fg-2", big ? "text-[14.5px]" : "text-[13px]", active && "text-fg")}>{c.title}</div>
        <div className={clsx("flex items-center gap-1.5 text-fg-4", big ? "text-[12.5px]" : "text-[11px]")}>
          <span className={clsx("font-mono", a?.text)}>{c.node}</span>
          <span>·</span>
          <span suppressHydrationWarning>{now ? ago(c.updatedAt, now) : ""}</span>
        </div>
      </div>
      {c.status === "running" && <Spinner size={13} className="text-blue" />}
      {c.status === "approval" && (
        <Tooltip content="Waiting for your approval" side="right">
          <span className="size-2 shrink-0 animate-pulse-dot rounded-full bg-yellow text-yellow" />
        </Tooltip>
      )}
      {big && <ChevronRight size={16} className="text-fg-5" />}
    </button>
  );
}

/* ---------------- machine + mode pickers ---------------- */

function MachinePicker({ value, onChange, disabled }: { value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const fleet = useFleet();
  const a = ACCENT[fleet.accent(value)];
  return (
    <Menu
      align="start"
      items={fleet.nodes.map((n) => ({
        label: n.id,
        hint: n.local ? "this machine" : fleet.displayStatus(n.id) === "online" ? n.kind.replace("-", " ") : fleet.displayStatus(n.id).replace("-", " "),
        disabled: n.unreachable,
        onSelect: () => onChange(n.id),
      }))}
      trigger={(p) => (
        <button
          {...p}
          disabled={disabled}
          className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-line-2 bg-raised px-2.5 text-[12.5px] transition-colors hover:border-line-3 hover:bg-hover disabled:pointer-events-none disabled:opacity-50 pointer-coarse:h-9"
        >
          <StatusDot status={fleet.displayStatus(value)} size={6} />
          <span className={clsx("font-mono font-semibold", a?.text)}>{value}</span>
          <ChevronDown size={13} className="text-fg-4" />
        </button>
      )}
    />
  );
}

function ModeToggle({ value, onChange }: { value: AiMode; onChange: (m: AiMode) => void }) {
  const opts: { v: AiMode; label: string; icon: typeof Zap; tip: string }[] = [
    { v: "ask", label: "Ask first", icon: ShieldCheck, tip: "Claude asks before every command and file write" },
    { v: "auto", label: "Auto", icon: Zap, tip: "Commands and file writes run without asking" },
  ];
  return (
    <div className="inline-flex h-8 rounded-md border border-line-2 bg-void/40 p-0.5 pointer-coarse:h-9" role="radiogroup" aria-label="Approval mode">
      {opts.map((o) => (
        <Tooltip key={o.v} content={o.tip} side="bottom">
          <button
            role="radio"
            aria-checked={value === o.v}
            onClick={() => onChange(o.v)}
            className={clsx(
              "inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] px-2.5 text-[12px] font-medium transition-colors",
              value === o.v ? (o.v === "auto" ? "bg-orange/15 text-orange" : "bg-hl text-fg") : "text-fg-4 hover:text-fg-2",
            )}
          >
            <o.icon size={13} />
            {o.label}
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

/* ---------------- composer ---------------- */

function Composer({
  onSend,
  onStop,
  running,
  disabled,
  placeholder,
  autoFocus,
  initial,
}: {
  onSend: (text: string) => void;
  onStop?: () => void;
  running?: boolean;
  disabled?: boolean;
  placeholder: string;
  autoFocus?: boolean;
  initial?: string;
}) {
  const [text, setText] = useState(initial ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [text]);
  const submit = () => {
    const t = text.trim();
    if (!t || running || disabled) return;
    onSend(t);
    setText("");
  };
  return (
    <div className="card flex items-end gap-2 rounded-2xl p-2 pl-3.5 focus-within:border-line-3">
      <textarea
        ref={ref}
        value={text}
        autoFocus={autoFocus}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          const touch = window.matchMedia("(pointer: coarse)").matches;
          if (e.key === "Enter" && !e.shiftKey && !touch && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        className="max-h-[220px] min-h-[36px] flex-1 resize-none bg-transparent py-2 text-[14px] leading-[1.45] text-fg placeholder:text-fg-5"
      />
      {running ? (
        <Tooltip content="Stop">
          <button
            onClick={onStop}
            aria-label="Stop"
            className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-xl bg-red/15 text-red ring-1 ring-red/30 ring-inset transition-colors hover:bg-red/25"
          >
            <Square size={14} fill="currentColor" />
          </button>
        </Tooltip>
      ) : (
        <button
          onClick={submit}
          aria-label="Send"
          disabled={!text.trim() || disabled}
          className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-xl bg-blue text-[#11131c] transition-colors hover:bg-[#8db0ff] disabled:cursor-not-allowed disabled:bg-hl disabled:text-fg-5"
        >
          <ArrowUp size={18} strokeWidth={2.4} />
        </button>
      )}
    </div>
  );
}

/* ---------------- start screen ---------------- */

const SUGGESTIONS = [
  "What's using the most disk space?",
  "Are any services failing? Find out why.",
  "What's eating memory right now?",
  "Show me recent errors in the system journal",
  "Install the pending updates",
  "Clean up old Docker images and package caches",
];

function StartScreen({ ai, onOpen, defaultNode }: { ai: ReturnType<typeof useAi>; onOpen: (id: string) => void; defaultNode: string | null }) {
  const fleet = useFleet();
  const [picked, setNode] = useState<string | null>(null);
  const [mode, setModeState] = useState<AiMode>(() => (typeof window !== "undefined" && readStored("fleet.ai.mode") === "auto" ? "auto" : "ask"));
  // picking a suggestion remounts the composer with that text
  const [draft, setDraft] = useState<{ text: string; n: number }>({ text: "", n: 0 });
  const [busy, setBusy] = useState(false);

  // explicit pick → ?node= → last used → first remote machine that is online → anything
  const node = useMemo(() => {
    const ids = fleet.nodes.map((n) => n.id);
    const stored = typeof window !== "undefined" ? readStored("fleet.ai.node") : null;
    const candidates = [picked, defaultNode, stored].filter((x): x is string => !!x && ids.includes(x));
    if (candidates[0]) return candidates[0];
    const online = fleet.nodes.find((n) => !n.local && fleet.states[n.id]?.status === "online");
    return online?.id ?? ids[0] ?? null;
  }, [picked, defaultNode, fleet.nodes, fleet.states]);

  const setMode = (m: AiMode) => {
    setModeState(m);
    store("fleet.ai.mode", m);
  };
  const start = async (text: string) => {
    if (!node) return;
    store("fleet.ai.node", node);
    setBusy(true);
    const id = await ai.create(node, mode, text);
    setBusy(false);
    if (id) onOpen(id);
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col px-4 pt-[min(14vh,120px)] pb-10 max-md:pt-8">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-xl bg-gradient-to-br from-blue/20 to-magenta/20 ring-1 ring-magenta/25 ring-inset">
            <Sparkles size={21} className="text-magenta" />
          </span>
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight text-fg">What should Claude do?</h1>
            <p className="text-[13px] text-fg-4">It works on your machines over ssh{ai.model ? ` · ${modelLabel(ai.model)}` : ""}</p>
          </div>
        </div>

        <div className="mb-2.5 flex flex-wrap items-center gap-2">
          {node ? <MachinePicker value={node} onChange={setNode} /> : <div className="skeleton h-8 w-24 rounded-md" />}
          <ModeToggle value={mode} onChange={setMode} />
        </div>
        <Composer
          key={draft.n}
          autoFocus
          initial={draft.text}
          disabled={!node || busy || !ai.connected}
          placeholder={node ? `Ask Claude to do something on ${node}…` : "Loading machines…"}
          onSend={start}
        />
        {mode === "auto" && (
          <p className="mt-2 flex items-center gap-1.5 px-1 text-[12px] text-orange/90">
            <Zap size={12} /> Auto mode: commands run without asking you first.
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setDraft((d) => ({ text: s, n: d.n + 1 }))}
              className="cursor-pointer rounded-full border border-line-2 bg-panel/60 px-3 py-1.5 text-[12.5px] text-fg-3 transition-colors hover:border-line-3 hover:text-fg-2 active:bg-hl"
            >
              {s}
            </button>
          ))}
        </div>

        {ai.chats.length > 0 && (
          <div className="mt-10 lg:hidden">
            <div className="px-1 pb-2 text-[10.5px] font-semibold tracking-[0.09em] text-fg-4 uppercase">Recent chats</div>
            <div className="card space-y-0.5 rounded-2xl p-1.5">
              {ai.chats.slice(0, 20).map((c) => (
                <ChatRow key={c.id} c={c} big onClick={() => onOpen(c.id)} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function modelLabel(id: string): string {
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/);
  if (!m) return id;
  return `Claude ${m[1].charAt(0).toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

/* ---------------- conversation ---------------- */

function Conversation({ ai, onBack }: { ai: ReturnType<typeof useAi>; onBack: () => void }) {
  const chat = ai.chat;
  const fleet = useFleet();
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const running = chat?.status === "running" || chat?.status === "approval";

  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat?.events]);

  if (!chat)
    return (
      <div className="grid flex-1 place-items-center text-fg-4">
        <Spinner size={18} />
      </div>
    );

  const last = chat.events[chat.events.length - 1];
  const waiting = chat.events.some((e) => e.k === "tool" && e.status === "approval");
  const showWorking = running && !waiting && !(last?.k === "tool" && last.status === "running") && !(last?.k === "text");

  return (
    <>
      <header className="flex shrink-0 items-center gap-2 border-b border-line bg-bg/70 px-3 py-2 backdrop-blur md:px-5">
        <button onClick={onBack} aria-label="All chats" className="grid size-9 place-items-center rounded-full text-fg-3 hover:bg-hover active:bg-hl lg:hidden">
          <ChevronLeft size={20} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-fg">{chat.title}</div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="max-sm:hidden">
            <ModeToggle value={chat.mode} onChange={(m) => ai.send({ t: "update", chat: chat.id, mode: m })} />
          </div>
          <MachinePicker value={chat.node} onChange={(n) => ai.send({ t: "update", chat: chat.id, node: n })} />
          <Menu
            items={[
              {
                label: chat.mode === "auto" ? "Ask before running" : "Run without asking",
                icon: chat.mode === "auto" ? ShieldCheck : Zap,
                onSelect: () => ai.send({ t: "update", chat: chat.id, mode: chat.mode === "auto" ? "ask" : "auto" }),
              },
              { label: "New chat", icon: MessageSquarePlus, onSelect: onBack },
              {
                label: "Delete chat",
                icon: Trash2,
                tone: "danger",
                separatorBefore: true,
                onSelect: () => {
                  ai.send({ t: "delete", chat: chat.id });
                  onBack();
                },
              },
            ]}
            trigger={(p) => <IconButton {...p} icon={MoreHorizontal} label="Chat options" size={32} />}
          />
        </div>
      </header>

      <div ref={scroller} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 md:px-6">
          {chat.events.map((e) => (
            <EventView key={e.id} e={e} chat={chat} ai={ai} />
          ))}
          {showWorking && (
            <div className="flex items-center gap-2 text-[13px] text-fg-4">
              <span className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span key={i} className="size-1.5 animate-pulse rounded-full bg-magenta/70" style={{ animationDelay: `${i * 0.2}s` }} />
                ))}
              </span>
              Working…
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 px-3 pt-1 pb-3 md:px-6">
        <div className="mx-auto max-w-3xl">
          {chat.mode === "auto" && (
            <div className="mb-1.5 flex items-center gap-1.5 px-1 text-[11.5px] text-orange/90">
              <Zap size={11} /> Auto mode: commands run without asking
              <button onClick={() => ai.send({ t: "update", chat: chat.id, mode: "ask" })} className="cursor-pointer text-fg-4 underline decoration-dotted underline-offset-2 hover:text-fg-2">
                ask first instead
              </button>
            </div>
          )}
          <Composer
            running={running}
            disabled={!ai.connected}
            onStop={() => ai.send({ t: "stop", chat: chat.id })}
            onSend={(text) => {
              stick.current = true;
              ai.send({ t: "send", chat: chat.id, text });
            }}
            placeholder={running ? "Claude is working…" : `Reply, or ask for something else on ${chat.node}…`}
          />
          {!ai.connected && <p className="mt-1.5 px-1 text-[11.5px] text-yellow">Reconnecting…</p>}
          {fleet.displayStatus(chat.node) === "offline" && (
            <p className="mt-1.5 px-1 text-[11.5px] text-yellow">{chat.node} looks offline right now.</p>
          )}
        </div>
      </div>
    </>
  );
}

function EventView({ e, chat, ai }: { e: ChatEvent; chat: Chat; ai: ReturnType<typeof useAi> }) {
  switch (e.k) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-sel/80 px-3.5 py-2 text-[14px] leading-[1.5] whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
            {e.text}
          </div>
        </div>
      );
    case "text":
      return e.text.trim() ? <Markdown text={e.text} /> : null;
    case "tool":
      return <ToolCard e={e} chat={chat} ai={ai} />;
    case "error":
      return (
        <div className="flex items-start gap-2 rounded-xl border border-red/25 bg-red/[0.07] px-3.5 py-2.5 text-[13px] text-red">
          <CircleAlert size={15} className="mt-0.5 shrink-0" />
          <Markdown text={e.text} className="!text-[13px] text-red" />
        </div>
      );
    case "done":
      return (
        <div className="flex items-center gap-2 text-[11px] text-fg-5 tabular">
          <span className="h-px flex-1 bg-line" />
          {e.stopped ? "Stopped" : "Done"} · {(e.ms / 1000).toFixed(e.ms < 10_000 ? 1 : 0)} s{e.costUsd > 0 ? ` · $${e.costUsd.toFixed(e.costUsd < 0.1 ? 3 : 2)}` : ""}
          <span className="h-px flex-1 bg-line" />
        </div>
      );
  }
}

const TOOL_ICON = { run_command: SquareTerminal, read_file: FileText, write_file: FilePen } as const;

function ToolCard({ e, chat, ai }: { e: ToolEvent; chat: Chat; ai: ReturnType<typeof useAi> }) {
  const fleet = useFleet();
  const term = useTerminals();
  const now = useNow();
  const [open, setOpen] = useState<boolean | null>(null);
  const out = useRef<HTMLPreElement>(null);
  const Icon = TOOL_ICON[e.tool];
  const a = ACCENT[fleet.accent(e.machine)];
  const approval = e.status === "approval";
  const live = e.status === "running" || approval;
  const expanded = open ?? (live || e.status === "error");
  const firstLine = e.summary.split("\n")[0];
  const multiline = e.summary.includes("\n") || e.summary.length > 90;
  const title = e.tool === "run_command" ? firstLine : `${e.tool === "read_file" ? "Read" : "Write"} ${e.summary}`;

  useLayoutEffect(() => {
    if (e.status === "running" && out.current) out.current.scrollTop = out.current.scrollHeight;
  }, [e.output, e.status]);

  const answer = (allow: boolean, extra?: { always?: boolean; note?: string }) =>
    ai.send({ t: "approve", chat: chat.id, tool: e.id, allow, ...extra });

  const runInTerminal = async () => {
    await term.open({ node: e.machine, action: "exec", params: { cmd: e.summary, title: "from Claude" } });
    answer(false, { note: "I'm running this myself in an interactive terminal, so you won't see the output. Wait for me to tell you how it went." });
  };

  const statusEl = (() => {
    switch (e.status) {
      case "queued":
        return <Spinner size={12} className="text-fg-4" />;
      case "approval":
        return <span className="rounded-full bg-yellow/12 px-2 py-0.5 text-[11px] font-semibold text-yellow">Needs approval</span>;
      case "running":
        return (
          <span className="flex items-center gap-1.5 text-[11px] text-blue tabular">
            <Spinner size={12} />
            {now ? `${Math.max(0, Math.round((now - e.at) / 1000))}s` : ""}
          </span>
        );
      case "done":
        return (
          <span className="flex items-center gap-1 text-[11px] text-fg-4 tabular">
            <Check size={12} className="text-green" />
            {e.ms != null ? `${(e.ms / 1000).toFixed(1)}s` : ""}
          </span>
        );
      case "error":
        return (
          <span className="flex items-center gap-1 text-[11px] text-red tabular">
            <X size={12} />
            {e.note ?? (e.exitCode != null ? `exit ${e.exitCode}` : "failed")}
          </span>
        );
      case "denied":
        return <span className="text-[11px] text-fg-4">{e.note === "Stopped" ? "Stopped" : "Not run"}</span>;
    }
  })();

  return (
    <div
      className={clsx(
        "overflow-hidden rounded-xl border bg-panel/70 transition-colors",
        approval ? "border-yellow/40 shadow-[0_0_0_3px_rgba(224,175,104,0.08)]" : e.status === "error" ? "border-red/25" : "border-line-2",
      )}
    >
      <button onClick={() => setOpen(!expanded)} className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left hover:bg-hover/50">
        <Icon size={14} className={clsx("shrink-0", approval ? "text-yellow" : "text-fg-4")} />
        <span className={clsx("shrink-0 font-mono text-[11.5px] font-semibold", a?.text)}>{e.machine}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg-2">
          {title}
          {multiline && e.tool === "run_command" && <span className="text-fg-5"> …</span>}
        </span>
        <span className="shrink-0">{statusEl}</span>
        <ChevronRight size={14} className={clsx("shrink-0 text-fg-5 transition-transform", expanded && "rotate-90")} />
      </button>

      {expanded && (
        <div className="border-t border-line">
          {(approval || multiline) && e.tool === "run_command" && (
            <pre className="max-h-72 overflow-auto bg-void/50 px-3.5 py-2.5 font-mono text-[12.5px] leading-[1.55] whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">
              <span className="text-fg-5 select-none">$ </span>
              {e.summary}
            </pre>
          )}
          {e.tool === "write_file" && e.content != null && (approval || !e.output) && (
            <pre className="max-h-72 overflow-auto bg-void/50 px-3.5 py-2.5 font-mono text-[12px] leading-[1.55] whitespace-pre text-fg-2">{e.content}</pre>
          )}
          {e.output && (
            <pre
              ref={out}
              className="max-h-80 overflow-auto bg-void/30 px-3.5 py-2.5 font-mono text-[12px] leading-[1.55] whitespace-pre-wrap text-fg-3 [overflow-wrap:anywhere]"
            >
              {e.output}
            </pre>
          )}
          {e.status === "denied" && e.note && e.note !== "Stopped" && <p className="px-3.5 py-2 text-[12px] text-fg-4">{e.note}</p>}
          {approval && (
            <div className="flex flex-wrap items-center gap-2 border-t border-line bg-yellow/[0.04] px-3 py-2.5">
              <Button size="sm" variant="primary" icon={Check} onClick={() => answer(true)}>
                {e.tool === "write_file" ? "Write file" : "Run"}
              </Button>
              <Button size="sm" variant="secondary" icon={X} onClick={() => answer(false)}>
                Deny
              </Button>
              {e.tool === "run_command" && (
                <Tooltip content="Open it in a terminal tab, where you can type a sudo password">
                  <Button size="sm" variant="ghost" icon={SquareTerminal} onClick={runInTerminal}>
                    <span className="max-sm:hidden">Run it myself in a terminal</span>
                    <span className="sm:hidden">In terminal</span>
                  </Button>
                </Tooltip>
              )}
              <Tooltip content="Approve this and everything else in this chat">
                <button
                  onClick={() => answer(true, { always: true })}
                  className="ml-auto cursor-pointer text-[12px] text-fg-4 underline decoration-dotted underline-offset-2 hover:text-orange"
                >
                  Allow all in this chat
                </button>
              </Tooltip>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
