"use client";

import clsx from "clsx";
import {
  Activity as ActivityIcon,
  ArrowUpRight,
  Bot,
  ChevronRight,
  Cog,
  Download,
  FileText,
  KeyRound,
  Keyboard,
  LogIn,
  Network,
  Package,
  Play,
  Power,
  Radar,
  RefreshCw,
  RotateCcw,
  RotateCw,
  ScrollText,
  Search,
  ShieldCheck,
  Skull,
  Smartphone,
  Sparkles,
  SquareTerminal,
  ToggleRight,
  Trash2,
  UserPlus,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import type { ActivityEvent, ActivitySource } from "@/lib/activity-types";
import { ago, clockTime } from "@/lib/format";
import type { ActionKind, SessionSpec } from "@/lib/types";
import { useFleet } from "./fleet-provider";
import { Markdown } from "./markdown";
import { useTerminals } from "./terminal-provider";
import { TOKYO_NIGHT_XTERM } from "./terminal-view";
import { ACCENT, Badge, Button, Empty, IconButton, Modal, Spinner, Tooltip, type Tone } from "./ui";

const KIND_ICON: Record<string, LucideIcon> = {
  "terminal.shell": SquareTerminal,
  "terminal.update": Download,
  "terminal.reboot": RotateCcw,
  "terminal.shutdown": Power,
  "terminal.unit": Cog,
  "terminal.container": Package,
  "terminal.logs": ScrollText,
  "terminal.exec": Play,
  "terminal.check": Play,
  "terminal.script": FileText,
  "terminal.kill": Skull,
  "terminal.input": Keyboard,
  "ai.prompt": Sparkles,
  "ai.run_command": Bot,
  "ai.read_file": FileText,
  "ai.write_file": FileText,
  "ai.mode": ToggleRight,
  "ai.machine": ToggleRight,
  "ai.stop": X,
  "ai.delete": Trash2,
  "panel.wake": Zap,
  "panel.script": FileText,
  "panel.updates": RefreshCw,
  "panel.probe": Radar,
  "auth.login": LogIn,
  "auth.logout": LogIn,
  "auth.pair": Smartphone,
  "auth.pair-code": Smartphone,
  "auth.revoke": Smartphone,
  "auth.password": KeyRound,
  "auth.setup": UserPlus,
  "auth.totp": ShieldCheck,
  "proxy.credentials": Network,
  "proxy.oauth": LogIn,
  "proxy.config": Network,
  "proxy.config.yaml": Network,
  "proxy.routing": Network,
  "proxy.start": Play,
  "proxy.stop": X,
  "proxy.restart": RefreshCw,
  "proxy.test": Zap,
};

const KIND_TONE: Record<string, Tone> = {
  "terminal.update": "cyan",
  "terminal.reboot": "yellow",
  "terminal.shutdown": "red",
  "terminal.unit": "magenta",
  "terminal.container": "teal",
  "terminal.exec": "magenta",
  "terminal.check": "magenta",
  "terminal.script": "magenta",
  "terminal.kill": "orange",
  "terminal.logs": "neutral",
  "ai.prompt": "magenta",
  "ai.run_command": "magenta",
  "ai.write_file": "orange",
  "panel.wake": "yellow",
};

const KIND_LABEL: Record<string, string> = {
  "terminal.shell": "shell",
  "terminal.check": "command",
  "terminal.script": "saved command",
  "panel.script": "saved command",
  "ai.prompt": "AI",
  "ai.run_command": "AI command",
  "ai.read_file": "AI read",
  "ai.write_file": "AI write",
  "ai.mode": "AI mode",
  "ai.machine": "AI",
  "ai.stop": "AI stop",
  "ai.delete": "AI",
  "panel.wake": "wake",
  "panel.updates": "updates",
  "panel.probe": "check",
  "proxy.credentials": "proxy account",
  "proxy.oauth": "proxy sign-in",
  "proxy.config": "proxy settings",
  "proxy.config.yaml": "proxy config",
  "proxy.routing": "proxy",
  "proxy.start": "proxy",
  "proxy.stop": "proxy",
  "proxy.restart": "proxy",
  "proxy.test": "proxy test",
  "proxy.observability": "proxy logs",
};

const SOURCES: { id: ActivitySource | null; label: string }[] = [
  { id: null, label: "Everything" },
  { id: "terminal", label: "Terminal" },
  { id: "ai", label: "AI" },
  { id: "panel", label: "Buttons" },
  { id: "auth", label: "Sign-ins" },
  { id: "proxy", label: "AI proxy" },
];

function label(e: ActivityEvent) {
  return KIND_LABEL[e.kind] ?? e.kind.split(".").slice(1).join(".");
}

function fmtMs(ms: number | null) {
  if (ms == null) return null;
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function dayLabel(ts: number) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function StatusText({ e, compact }: { e: ActivityEvent; compact?: boolean }) {
  switch (e.status) {
    case "running":
      return <span className="text-green">running</span>;
    case "approval":
      return <span className="text-yellow">needs approval</span>;
    case "pending":
      return <span className="text-fg-4">queued</span>;
    case "denied":
      return <span className="text-orange">{e.meta.note === "Stopped" ? "stopped" : "declined"}</span>;
    case "error":
      return <span className="text-red">{e.exitCode != null ? `exit ${e.exitCode}` : compact ? "failed" : String(e.meta.note ?? "failed")}</span>;
    case "ok":
      return <span className="text-fg-4">{e.source === "auth" ? "ok" : "done"}</span>;
    default:
      return null;
  }
}

function dotClass(e: ActivityEvent) {
  return e.status === "running"
    ? "bg-green animate-pulse-dot"
    : e.status === "approval"
      ? "bg-yellow animate-pulse-dot"
      : e.status === "error"
        ? "bg-red"
        : e.status === "denied"
          ? "bg-orange"
          : "bg-fg-5";
}

/* ---------------- data ---------------- */

interface Filters {
  source: ActivitySource | null;
  node: string | null;
  q: string;
}

function matches(e: ActivityEvent, f: Filters) {
  if (e.parent != null) return false;
  if (f.source && e.source !== f.source) return false;
  if (f.node && e.node !== f.node) return false;
  if (f.q) return false; // search results come from the server only
  return true;
}

async function fetchActivity(params: Record<string, string | number | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, String(v));
  const r = await fetch(`/api/activity?${sp}`, { cache: "no-store" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
  return (await r.json()) as { events: ActivityEvent[]; more: boolean; nodes: string[] };
}

function upsert(list: ActivityEvent[], e: ActivityEvent, newestFirst: boolean) {
  const i = list.findIndex((x) => x.id === e.id);
  if (i >= 0) {
    const next = list.slice();
    // live events don't carry the child count the list query computed
    next[i] = { ...e, children: Math.max(e.children, list[i].children) };
    return next;
  }
  return newestFirst ? [e, ...list] : [...list, e];
}

/* ---------------- view ---------------- */

export function ActivityView() {
  const term = useTerminals();
  const fleet = useFleet();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  const [filters, setFilters] = useState<Filters>({ source: null, node: null, q: "" });
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setFilters((f) => (f.q === query.trim() ? f : { ...f, q: query.trim() })), 250);
    return () => clearTimeout(t);
  }, [query]);

  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [nodes, setNodes] = useState<string[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [children, setChildren] = useState<Record<number, ActivityEvent[]>>({});
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [transcript, setTranscript] = useState<ActivityEvent | null>(null);
  const knownChildren = useRef(new Set<number>());
  const [mountTime] = useState(() => Date.now());
  const mountedAt = useRef(mountTime);
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const load = useCallback(async (f: Filters, before?: number) => {
    setLoading(true);
    try {
      const r = await fetchActivity({ source: f.source ?? undefined, node: f.node ?? undefined, q: f.q, before, limit: 100 });
      setEvents((prev) => (before ? [...prev, ...r.events.filter((e) => !prev.some((p) => p.id === e.id))] : r.events));
      setMore(r.more);
      setNodes(r.nodes);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on filter change
    void load(filters);
  }, [filters, load]);

  const loadChildren = useCallback(async (id: number) => {
    try {
      const r = await fetchActivity({ parent: id, limit: 500 });
      for (const e of r.events) knownChildren.current.add(e.id);
      setChildren((c) => ({ ...c, [id]: r.events }));
    } catch {
      /* ignore */
    }
  }, []);

  // live updates
  useEffect(
    () =>
      term.onActivity((e) => {
        if (e.parent == null) {
          setEvents((list) => (list.some((x) => x.id === e.id) || matches(e, filtersRef.current) ? upsert(list, e, true) : list));
          if (e.node) setNodes((n) => (n.includes(e.node!) ? n : [...n, e.node!].sort()));
        } else {
          const parent = e.parent;
          // Count children that appeared since the page loaded; older ones are already in the count.
          if (!knownChildren.current.has(e.id) && e.at >= mountedAt.current) {
            knownChildren.current.add(e.id);
            setEvents((list) => list.map((x) => (x.id === parent ? { ...x, children: x.children + 1 } : x)));
          }
          setChildren((c) => (c[parent] ? { ...c, [parent]: upsert(c[parent], e, false) } : c));
        }
      }),
    [term],
  );

  const toggle = (e: ActivityEvent) => {
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(e.id)) n.delete(e.id);
      else {
        n.add(e.id);
        if (e.children > 0 || e.source === "terminal" || e.kind === "ai.prompt") void loadChildren(e.id);
      }
      return n;
    });
  };

  const liveByActivity = useMemo(() => new Map(term.sessions.filter((s) => s.activityId != null).map((s) => [s.activityId!, s])), [term.sessions]);

  const groups = useMemo(() => {
    const out: { day: string; items: ActivityEvent[] }[] = [];
    for (const e of events) {
      const day = dayLabel(e.at);
      const last = out[out.length - 1];
      if (last?.day === day) last.items.push(e);
      else out.push({ day, items: [e] });
    }
    return out;
  }, [events]);

  const filtered = filters.source || filters.node || filters.q;

  return (
    <div className="mx-auto max-w-[1440px] px-4 pt-5 pb-8 sm:px-6 sm:py-7 lg:px-8">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4 max-sm:mb-3">
        <div className="max-sm:hidden">
          <h1 className="text-[20px] font-semibold tracking-tight text-fg sm:text-[22px]">Activity</h1>
          <p className="mt-1 text-[13px] text-fg-4">
            A permanent record of everything done to your machines from this panel: shells and what was typed in them, actions, AI
            commands and who approved them, power buttons and sign-ins.
          </p>
        </div>
      </div>

      <div className="mb-3 flex flex-col gap-2.5">
        <div className="relative max-w-md">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-4" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands, prompts, output…"
            className="h-9 w-full rounded-lg bg-hl/40 pr-8 pl-8 text-[13px] text-fg ring-1 ring-line-2 outline-none ring-inset placeholder:text-fg-5 focus:ring-blue/50 max-sm:h-11 max-sm:text-[16px]"
          />
          {query && (
            <button onClick={() => setQuery("")} aria-label="Clear search" className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded text-fg-4 hover:text-fg">
              <X size={13} />
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SOURCES.map((s) => (
            <Chip key={s.label} active={filters.source === s.id} onClick={() => setFilters((f) => ({ ...f, source: s.id }))}>
              {s.label}
            </Chip>
          ))}
        </div>
        {nodes.length > 1 && (
          <div className="flex flex-wrap gap-1.5">
            {[null, ...nodes].map((m) => (
              <Chip
                key={m ?? "all"}
                active={filters.node === m}
                onClick={() => setFilters((f) => ({ ...f, node: m }))}
                className={clsx(m && "font-mono", m && filters.node === m && ACCENT[fleet.accent(m)].text)}
              >
                {m ?? "All machines"}
              </Chip>
            ))}
          </div>
        )}
      </div>

      {error && <div className="mb-3 rounded-lg bg-red/10 px-4 py-2.5 text-[12.5px] text-red ring-1 ring-red/25 ring-inset">Couldn&apos;t load activity: {error}</div>}

      <div className="card overflow-hidden rounded-xl">
        {events.length === 0 ? (
          loading ? (
            <div className="grid place-items-center py-14">
              <Spinner />
            </div>
          ) : (
            <Empty
              icon={ActivityIcon}
              title={filtered ? "Nothing matches" : "Nothing yet"}
              hint={filtered ? "Try another filter or search." : "Open a shell, run an action or ask the AI to do something and it will show up here."}
            />
          )
        ) : (
          groups.map((g) => (
            <div key={g.day}>
              <div className="sticky top-0 z-[1] border-b border-line/60 bg-panel/95 px-4 py-1.5 text-[11px] font-semibold tracking-[0.08em] text-fg-4 uppercase backdrop-blur">
                {g.day}
              </div>
              <ul>
                {g.items.map((e) => (
                  <Row
                    key={e.id}
                    e={e}
                    expanded={open.has(e.id)}
                    onToggle={() => toggle(e)}
                    childEvents={children[e.id]}
                    live={liveByActivity.get(e.id)}
                    onTranscript={() => setTranscript(e)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
        {more && (
          <div className="border-t border-line/60 p-3 text-center">
            <Button variant="ghost" onClick={() => load(filters, events[events.length - 1]?.id)} disabled={loading}>
              {loading ? "Loading…" : "Load older"}
            </Button>
          </div>
        )}
      </div>

      <Modal
        open={transcript != null}
        onClose={() => setTranscript(null)}
        title={transcript ? `${transcript.node} · ${transcript.summary}` : ""}
        description={transcript ? `${new Date(transcript.at).toLocaleString()} · ${transcript.actor}` : undefined}
        icon={SquareTerminal}
        width={980}
      >
        {transcript && <TranscriptView id={transcript.id} />}
        <div className="h-4" />
      </Modal>
    </div>
  );
}

function Chip({ active, onClick, className, children }: { active: boolean; onClick: () => void; className?: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "h-7 cursor-pointer rounded-full px-3 text-[12px] font-medium ring-1 transition-colors ring-inset max-sm:h-9 max-sm:px-3.5 max-sm:text-[13px]",
        active ? "bg-hl text-fg ring-line-3" : "text-fg-4 ring-line-2 hover:text-fg-2",
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ---------------- one row ---------------- */

function Row({
  e,
  expanded,
  onToggle,
  childEvents,
  live,
  onTranscript,
}: {
  e: ActivityEvent;
  expanded: boolean;
  onToggle: () => void;
  childEvents: ActivityEvent[] | undefined;
  live: ReturnType<typeof useTerminals>["sessions"][number] | undefined;
  onTranscript: () => void;
}) {
  const term = useTerminals();
  const fleet = useFleet();
  const a = e.node ? ACCENT[fleet.accent(e.node)] : null;
  const Icon = KIND_ICON[e.kind] ?? ActivityIcon;
  const isSession = e.source === "terminal" && e.kind !== "terminal.input" && e.kind !== "terminal.kill" && e.meta.transcript === true;
  const spec: SessionSpec | null =
    isSession && e.node ? { node: e.node, action: e.kind.slice("terminal.".length) as ActionKind, params: (e.meta.params as SessionSpec["params"]) ?? {} } : null;
  const mono = (e.source === "terminal" && e.kind !== "terminal.shell") || ["ai.run_command", "ai.read_file", "ai.write_file"].includes(e.kind);

  return (
    <li className="border-b border-line/60 last:border-0">
      <div
        role="button"
        tabIndex={0}
        onClick={(ev) => {
          if (!(ev.target as HTMLElement).closest("button")) onToggle();
        }}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onToggle();
          }
        }}
        className="group flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-hl/20 max-sm:min-h-16 max-sm:active:bg-hl/40"
      >
        <ChevronRight size={14} className={clsx("shrink-0 text-fg-5 transition-transform", expanded && "rotate-90")} />
        <Tooltip content={new Date(e.at).toLocaleString()}>
          <div className="w-[52px] shrink-0 font-mono text-[11.5px] text-fg-4 tabular max-sm:hidden">{clockTime(e.at).slice(0, 5)}</div>
        </Tooltip>
        <div className="flex w-[78px] shrink-0 items-center gap-2 max-sm:hidden">
          <span className={clsx("size-2 shrink-0 rounded-full", dotClass(e))} />
          {e.node ? <span className={clsx("truncate font-mono text-[13px] font-semibold", a?.text)}>{e.node}</span> : <span className="text-[12px] text-fg-5">panel</span>}
        </div>
        <div className="w-[104px] shrink-0 max-sm:hidden">
          <Badge tone={KIND_TONE[e.kind] ?? (e.source === "ai" ? "magenta" : e.source === "auth" ? "neutral" : "blue")} icon={Icon}>
            {label(e)}
          </Badge>
        </div>
        <div className="min-w-0 flex-1">
          <div className={clsx("truncate text-[13px] text-fg-2 max-sm:text-[14px]", mono && "font-mono text-[12.5px]")}>
            {e.node && <span className={clsx("font-mono font-semibold sm:hidden", a?.text)}>{e.node} · </span>}
            {e.summary}
          </div>
          <div className="truncate text-[11.5px] text-fg-4">
            <span className="sm:hidden">
              <StatusText e={e} compact /> · {ago(e.at)} ·{" "}
            </span>
            {e.actor}
            {e.children > 0 && (
              <span className="text-fg-5">
                {" "}
                · {e.children} {e.kind === "ai.prompt" ? (e.children === 1 ? "step" : "steps") : e.children === 1 ? "event" : "events"}
              </span>
            )}
          </div>
        </div>
        <div className="hidden w-28 shrink-0 text-right text-[11.5px] sm:block">
          <StatusText e={e} compact />
          <div className="text-[10.5px] text-fg-4">{fmtMs(e.ms) ?? ago(e.at)}</div>
        </div>
        <div className="flex w-[100px] shrink-0 justify-end gap-0.5 max-sm:hidden">
          {live && !live.exited && (
            <IconButton
              icon={ArrowUpRight}
              label="Show in terminal"
              onClick={() => {
                term.setActive(live.id);
                if (term.dock === "closed") term.setDock("open");
              }}
            />
          )}
          {spec && <IconButton icon={RotateCw} label="Run again" onClick={() => term.open(spec)} />}
          {live && !live.exited && <IconButton icon={Trash2} label="End session" tone="danger" onClick={() => term.close(live.id)} />}
        </div>
      </div>

      {expanded && (
        <div className="border-t border-line/40 bg-void/30 px-4 py-3 sm:pl-[44px]">
          <Details e={e} childEvents={childEvents} isSession={isSession} live={live} spec={spec} onTranscript={onTranscript} />
        </div>
      )}
    </li>
  );
}

function Field({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2 text-[12px]">
      <span className="w-24 shrink-0 text-fg-5">{k}</span>
      <span className="min-w-0 break-words text-fg-3">{children}</span>
    </div>
  );
}

function Pre({ children, className }: { children: string; className?: string }) {
  return (
    <pre className={clsx("max-h-80 overflow-auto rounded-lg bg-[#13141c] p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-all text-fg-2 ring-1 ring-line-2 ring-inset", className)}>
      {children}
    </pre>
  );
}

function Details({
  e,
  childEvents,
  isSession,
  live,
  spec,
  onTranscript,
}: {
  e: ActivityEvent;
  childEvents: ActivityEvent[] | undefined;
  isSession: boolean;
  live: ReturnType<typeof useTerminals>["sessions"][number] | undefined;
  spec: SessionSpec | null;
  onTranscript: () => void;
}) {
  const term = useTerminals();
  const m = e.meta;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Field k="When">
          {new Date(e.at).toLocaleString()}
          {e.endedAt && e.endedAt !== e.at ? ` → ${new Date(e.endedAt).toLocaleTimeString()}` : ""}
        </Field>
        <Field k="By">{e.actor}</Field>
        {e.node && <Field k="Machine">{e.node}</Field>}
        {e.status && e.status !== "info" && (
          <Field k="Result">
            <StatusText e={e} />
            {e.ms != null && ` · ${fmtMs(e.ms)}`}
            {e.exitCode != null && e.status !== "error" && ` · exit ${e.exitCode}`}
          </Field>
        )}
        {typeof m.chatTitle === "string" && <Field k="Chat">{m.chatTitle}</Field>}
        {typeof m.mode === "string" && e.source === "ai" && <Field k="Mode">{m.mode === "auto" ? "auto-run (no approval needed)" : "ask before running"}</Field>}
        {typeof m.approvedBy === "string" && <Field k="Approved by">{m.approvedBy}</Field>}
        {typeof m.deniedBy === "string" && <Field k="Declined by">{m.deniedBy}</Field>}
        {typeof m.denyReason === "string" && <Field k="Reason">{m.denyReason}</Field>}
        {typeof m.note === "string" && <Field k="Note">{m.note}</Field>}
        {typeof m.costUsd === "number" && <Field k="Cost">${m.costUsd.toFixed(4)} · {String(m.turns ?? 0)} turns</Field>}
      </div>

      {isSession && e.detail && (
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wide text-fg-4 uppercase">Command</div>
          <Pre>{e.detail}</Pre>
        </div>
      )}
      {e.kind === "ai.prompt" && e.detail && (
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wide text-fg-4 uppercase">Prompt</div>
          <div className="rounded-lg bg-hl/40 px-3 py-2 text-[13px] whitespace-pre-wrap text-fg-2">{e.detail}</div>
        </div>
      )}
      {e.source === "ai" && e.kind !== "ai.prompt" && <AiStepBody e={e} />}
      {!isSession && e.source !== "ai" && e.detail && <Pre>{e.detail}</Pre>}

      {(isSession || e.kind === "ai.prompt") && (
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wide text-fg-4 uppercase">
            {e.kind === "ai.prompt" ? "What the AI did" : "Typed in this session"}
          </div>
          {childEvents == null ? (
            e.children > 0 ? <Spinner size={12} /> : <div className="text-[12px] text-fg-5">Nothing.</div>
          ) : childEvents.length === 0 ? (
            <div className="text-[12px] text-fg-5">{e.kind === "ai.prompt" ? "No commands — it only answered." : "Nothing typed."}</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {childEvents.map((c) => (
                <Child key={c.id} c={c} parentActor={e.actor} />
              ))}
            </ul>
          )}
        </div>
      )}

      {e.kind === "ai.prompt" && typeof m.reply === "string" && m.reply.trim() && (
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wide text-fg-4 uppercase">Reply</div>
          <div className="rounded-lg bg-hl/30 px-3 py-2 text-[13px] text-fg-2">
            <Markdown text={m.reply} />
          </div>
        </div>
      )}
      {Array.isArray(m.errors) && m.errors.length > 0 && <Pre className="text-red">{(m.errors as string[]).join("\n")}</Pre>}

      {(isSession || spec) && (
        <div className="flex flex-wrap gap-2">
          {e.hasTranscript && (
            <Button icon={SquareTerminal} onClick={onTranscript}>
              Show output
            </Button>
          )}
          {live && !live.exited && (
            <Button
              icon={ArrowUpRight}
              onClick={() => {
                term.setActive(live.id);
                if (term.dock === "closed") term.setDock("open");
              }}
            >
              Open in terminal
            </Button>
          )}
          {spec && (
            <Button variant="ghost" icon={RotateCw} onClick={() => term.open(spec)}>
              Run again
            </Button>
          )}
          {live && !live.exited && (
            <Button variant="ghost" icon={Trash2} onClick={() => term.close(live.id)}>
              End session
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function AiStepBody({ e }: { e: ActivityEvent }) {
  const m = e.meta;
  return (
    <>
      {typeof m.script === "string" && <Pre>{m.script}</Pre>}
      {typeof m.content === "string" && (
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wide text-fg-4 uppercase">Written content</div>
          <Pre>{m.content}</Pre>
        </div>
      )}
      {e.detail && (
        <div>
          <div className="mb-1 text-[11px] font-semibold tracking-wide text-fg-4 uppercase">Output</div>
          <Pre>{e.detail}</Pre>
        </div>
      )}
    </>
  );
}

function Child({ c, parentActor }: { c: ActivityEvent; parentActor: string }) {
  const [open, setOpen] = useState(false);
  const Icon = KIND_ICON[c.kind] ?? ActivityIcon;
  const expandable = c.source === "ai" && Boolean(c.detail || c.meta.content || c.meta.script || c.meta.approvedBy || c.meta.deniedBy || c.meta.note);
  const secret = c.meta.secret === true;
  return (
    <li className="rounded-md ring-line-2 ring-inset hover:bg-hl/20">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
        className={clsx("flex w-full items-start gap-2.5 px-2 py-1 text-left", expandable ? "cursor-pointer" : "cursor-default")}
      >
        <span className="w-[52px] shrink-0 pt-px font-mono text-[11px] text-fg-5 tabular">{clockTime(c.at)}</span>
        <Icon size={13} className={clsx("mt-0.5 shrink-0", c.source === "ai" ? "text-magenta" : "text-fg-4")} />
        {c.kind === "ai.write_file" && <span className="shrink-0 pt-px text-[11px] text-orange">write</span>}
        {c.kind === "ai.read_file" && <span className="shrink-0 pt-px text-[11px] text-fg-4">read</span>}
        <span className={clsx("min-w-0 flex-1 font-mono text-[12px] break-all whitespace-pre-wrap", secret ? "text-fg-5 italic" : "text-fg-2", c.kind === "terminal.kill" && "text-orange")}>
          {c.kind === "terminal.input" && !secret && <span className="text-fg-5 select-none">$ </span>}
          {c.summary}
        </span>
        <span className="shrink-0 pt-px text-right text-[11px]">
          {c.status && c.status !== "info" && <StatusText e={c} compact />}
          {c.ms != null && <span className="text-fg-5"> · {fmtMs(c.ms)}</span>}
          {c.actor !== parentActor && c.actor !== "AI" && <span className="text-fg-5"> · {c.actor}</span>}
        </span>
      </button>
      {open && expandable && (
        <div className="flex flex-col gap-2 px-2 pt-1 pb-2 sm:pl-[72px]">
          {typeof c.meta.approvedBy === "string" && <Field k="Approved by">{c.meta.approvedBy}</Field>}
          {typeof c.meta.deniedBy === "string" && <Field k="Declined by">{c.meta.deniedBy}</Field>}
          {typeof c.meta.denyReason === "string" && <Field k="Reason">{c.meta.denyReason}</Field>}
          {typeof c.meta.note === "string" && <Field k="Note">{c.meta.note}</Field>}
          {c.exitCode != null && <Field k="Exit code">{c.exitCode}</Field>}
          <AiStepBody e={c} />
        </div>
      )}
    </li>
  );
}

/* ---------------- transcript ---------------- */

/** Replays a session's recorded output in a read-only terminal. */
function TranscriptView({ id }: { id: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing">("loading");
  useEffect(() => {
    let disposed = false;
    let t: Terminal | null = null;
    (async () => {
      const [{ Terminal }, { FitAddon }, res] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        fetch(`/api/activity/${id}/transcript`, { cache: "no-store" }),
      ]);
      if (disposed || !host.current) return;
      if (!res.ok) {
        setState("missing");
        return;
      }
      const text = await res.text();
      if (disposed || !host.current) return;
      t = new Terminal({
        fontFamily: getComputedStyle(document.body).getPropertyValue("--font-mono") || "monospace",
        fontSize: 12,
        lineHeight: 1.2,
        scrollback: 50_000,
        disableStdin: true,
        cursorBlink: false,
        convertEol: false,
        theme: TOKYO_NIGHT_XTERM,
      });
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(host.current);
      fit.fit();
      t.write(text || "\x1b[2m(no output)\x1b[0m");
      setState("ready");
    })();
    return () => {
      disposed = true;
      t?.dispose();
    };
  }, [id]);
  return (
    <div className="relative">
      {state === "loading" && (
        <div className="absolute inset-0 grid place-items-center">
          <Spinner />
        </div>
      )}
      {state === "missing" ? (
        <div className="py-8 text-center text-[13px] text-fg-4">No output was recorded for this session.</div>
      ) : (
        <div ref={host} className="h-[60vh] overflow-hidden rounded-lg bg-[#13141c] p-2 ring-1 ring-line-2" />
      )}
    </div>
  );
}
