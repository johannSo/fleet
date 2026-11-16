"use client";

import clsx from "clsx";
import { ChevronDown, ChevronRight, CircleAlert, Copy, Database, Download, FileText, Radio, RefreshCw, Search, Waves } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { TrafficPage, TrafficRow, TrafficStatus } from "@/lib/cpa-types";
import { ago, bytes, clockTime } from "@/lib/format";
import { answerOf, attemptParts, headerBlock, promptOf, splitSections, type LogSection } from "@/lib/proxy-log";
import { useIsMobile } from "../hooks";
import { PROXY_CHANGED_EVENT } from "../terminal-provider";
import { Badge, Button, Empty, Modal, Spinner } from "../ui";
import { ErrorCard } from "./accounts";
import { mgmt, ms, proxyApi, tokens, useProxyData } from "./api";
import { ProviderMark, Section, Toggle } from "./bits";

const keyOf = (r: TrafficRow) => `${r.machine}/${r.file}`;

function fmtTime(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today ? clockTime(at) : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clockTime(at)}`;
}

function statusTone(s: number) {
  if (!s) return "neutral" as const;
  if (s >= 500) return "red" as const;
  if (s >= 400) return s === 499 ? ("yellow" as const) : ("red" as const);
  return "green" as const;
}

export function TrafficView() {
  const status = useProxyData(() => proxyApi.get<TrafficStatus>("/traffic/status"), [], 15_000);
  const models = useProxyData(() => proxyApi.get<{ models: string[] }>("/traffic/models").then((r) => r.models), []);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [model, setModel] = useState("");
  const [failed, setFailed] = useState(false);
  const [live, setLive] = useState(true);
  const [rows, setRows] = useState<TrafficRow[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const mobile = useIsMobile();
  const seq = useRef(0);

  // Debounced search.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 350);
    return () => clearTimeout(t);
  }, [q]);

  const params = useMemo(() => ({ q: query || undefined, model: model || undefined, failed: failed ? 1 : undefined }), [query, model, failed]);

  const loadFirst = useCallback(async () => {
    const n = ++seq.current;
    setLoading(true);
    try {
      const p = await proxyApi.get<TrafficPage>("/traffic", { ...params, limit: 60 });
      if (n !== seq.current) return;
      setRows(p.rows);
      setMore(p.more);
      setError(null);
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- (re)load when the filters change
    void loadFirst();
  }, [loadFirst]);

  const loadOlder = useCallback(async () => {
    const last = rows.at(-1);
    if (!last || loading) return;
    const n = seq.current;
    setLoading(true);
    try {
      const p = await proxyApi.get<TrafficPage>("/traffic", { ...params, limit: 60, before: last.at, beforeFile: last.file });
      if (n !== seq.current) return;
      setRows((prev) => {
        const seen = new Set(prev.map(keyOf));
        return [...prev, ...p.rows.filter((r) => !seen.has(keyOf(r)))];
      });
      setMore(p.more);
    } catch (e) {
      toast.error("Couldn't load older requests", { description: (e as Error).message });
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [rows, params, loading]);

  // Live: new requests are shipped within a few seconds; the server pings us after each batch.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  });
  const loadNewer = useCallback(async () => {
    const newest = rowsRef.current[0];
    if (!newest) return void loadFirst();
    try {
      const p = await proxyApi.get<TrafficPage>("/traffic", { ...params, limit: 200, after: newest.at - 1 });
      setRows((prev) => {
        const seen = new Set(prev.map(keyOf));
        const fresh = p.rows.filter((r) => !seen.has(keyOf(r)));
        return fresh.length ? [...fresh, ...prev] : prev;
      });
    } catch {
      /* next ping */
    }
  }, [params, loadFirst]);
  useEffect(() => {
    if (!live) return;
    const on = () => void loadNewer();
    window.addEventListener(PROXY_CHANGED_EVENT, on);
    const t = setInterval(() => document.visibilityState === "visible" && on(), 10_000);
    return () => {
      window.removeEventListener(PROXY_CHANGED_EVENT, on);
      clearInterval(t);
    };
  }, [live, loadNewer]);

  // Infinite scroll.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !more) return;
    const io = new IntersectionObserver((e) => e[0]?.isIntersecting && void loadOlder(), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [more, loadOlder]);

  // On a wide screen the newest request is open until another one (still in the list) is picked.
  const picked = rows.find((r) => keyOf(r) === sel) ?? null;
  const selected = picked ?? (!mobile ? (rows[0] ?? null) : null);
  const selKey = selected ? keyOf(selected) : null;

  // j/k or arrows move through the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey) return;
      const d = e.key === "j" || e.key === "ArrowDown" ? 1 : e.key === "k" || e.key === "ArrowUp" ? -1 : 0;
      if (!d || !rows.length) return;
      e.preventDefault();
      const i = rows.findIndex((r) => keyOf(r) === selKey);
      const next = rows[Math.min(rows.length - 1, Math.max(0, i + d))];
      setSel(keyOf(next));
      document.getElementById(`tr-${keyOf(next)}`)?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, selKey]);

  return (
    <>
      <StatusStrip s={status.data} error={status.error} onChanged={status.reload} />
      <Section
        title="Traffic"
        hint="Every request through the proxy, as it went in and came out. Stored in ClickHouse."
        right={
          <>
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-4" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search prompts, answers, headers"
                className="h-7.5 w-64 max-w-[60vw] rounded-md border border-line-2 bg-panel/80 pr-2 pl-8 text-[12.5px] text-fg placeholder:text-fg-5 focus:border-blue/60 pointer-coarse:h-9"
              />
            </div>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-label="Model"
              className="h-7.5 max-w-44 rounded-md border border-line-2 bg-panel/80 px-2 text-[12.5px] text-fg-2 pointer-coarse:h-9"
            >
              <option value="">All models</option>
              {(models.data ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-3">
              <Toggle label="Failed only" checked={failed} onChange={setFailed} />
              Failed
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-3">
              <Toggle label="Live" checked={live} onChange={setLive} />
              Live
            </label>
            <Button
              size="sm"
              variant="ghost"
              icon={RefreshCw}
              onClick={async () => {
                await proxyApi.post("/traffic/capture", {}).catch(() => {});
                await loadFirst();
                status.reload();
              }}
            >
              Refresh
            </Button>
          </>
        }
      >
        {error && !rows.length ? (
          <ErrorCard message={error} onRetry={loadFirst} />
        ) : !rows.length && loading ? (
          <div className="card skeleton h-64 rounded-xl opacity-50" />
        ) : !rows.length ? (
          <div className="card rounded-xl">
            <Empty icon={Waves} title={query || model || failed ? "Nothing matches" : "No requests yet"} hint={query || model || failed ? "Try a different search or filter." : "Send something through the proxy and it shows up here within a few seconds."} />
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-[minmax(320px,420px)_minmax(0,1fr)]">
            <div className="card overflow-hidden rounded-xl lg:h-[calc(100dvh-300px)] lg:min-h-[420px] lg:overflow-y-auto">
              {rows.map((r) => (
                <RowItem key={keyOf(r)} r={r} active={keyOf(r) === selKey} onClick={() => setSel(keyOf(r))} />
              ))}
              <div ref={sentinel} className="flex h-12 items-center justify-center text-[12px] text-fg-5">
                {loading ? <Spinner /> : more ? "" : `${rows.length.toLocaleString()} request${rows.length === 1 ? "" : "s"}`}
              </div>
            </div>
            {!mobile && (
              <div className="card h-[calc(100dvh-300px)] min-h-[420px] overflow-hidden rounded-xl">
                {selected ? <RawViewer r={selected} /> : <Empty icon={FileText} title="Pick a request" />}
              </div>
            )}
          </div>
        )}
      </Section>
      {mobile && (
        <Modal open={!!picked} onClose={() => setSel(null)} width={760} title={selected?.model || "Request"} description={selected ? fmtTime(selected.at) : undefined} icon={FileText}>
          {selected && (
            <div className="-mx-1 h-[70dvh]">
              <RawViewer r={selected} />
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

function StatusStrip({ s, error, onChanged }: { s: TrafficStatus | null; error: string | null; onChanged: () => void }) {
  const [turningOn, setTurningOn] = useState(false);
  if (!s) return error ? <div className="mb-4"><ErrorCard message={error} onRetry={onChanged} /></div> : <div className="card skeleton mb-4 h-12 rounded-xl opacity-50" />;
  const items: React.ReactNode[] = [];
  if (!s.db.configured) {
    items.push(<span key="nc">ClickHouse isn&apos;t set up. Run <code className="font-mono text-fg-2">clickhouse/install.sh</code> from the fleet repo.</span>);
  } else if (!s.db.reachable) {
    items.push(<span key="nr" className="text-red">Can&apos;t reach ClickHouse on {s.db.machine}: {s.db.error}</span>);
  } else {
    items.push(
      <span key="db">
        ClickHouse {s.db.version} on <span className="text-fg-2">{s.db.machine}</span>
      </span>,
      <span key="rows">
        <span className="text-fg-2 tabular">{(s.rows ?? 0).toLocaleString()}</span> requests
      </span>,
      <span key="disk">
        <span className="text-fg-2 tabular">{bytes(s.diskBytes)}</span> on disk{s.rawBytes ? ` (${bytes(s.rawBytes)} raw)` : ""}
      </span>,
    );
  }
  if (s.capture.lastAt) items.push(<span key="last">last shipped {ago(s.capture.lastAt)}</span>);
  if (s.capture.pending) items.push(<span key="p" className="text-yellow">{s.capture.pending} waiting</span>);
  return (
    <div className="card mb-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-xl px-4 py-2.5 text-[12.5px] text-fg-4">
      <Database size={14} className={s.db.reachable ? "text-green" : "text-fg-4"} />
      {items}
      {s.capture.lastError && <span className="text-red">Last ship failed: {s.capture.lastError}</span>}
      {s.requestLog === false && (
        <span className="ml-auto flex items-center gap-2 text-yellow">
          <CircleAlert size={13} /> Request logs are off, so nothing new is recorded.
          <Button
            size="sm"
            variant="secondary"
            loading={turningOn}
            onClick={async () => {
              setTurningOn(true);
              try {
                await mgmt.put("/config/observability/logs/request-log", true);
                toast.success("Request logs on");
                onChanged();
              } catch (e) {
                toast.error("Couldn't turn them on", { description: (e as Error).message });
              } finally {
                setTurningOn(false);
              }
            }}
          >
            Turn on
          </Button>
        </span>
      )}
      {s.requestLog && (
        <span className="ml-auto flex items-center gap-1.5 text-green">
          <Radio size={13} /> Recording
        </span>
      )}
    </div>
  );
}

function RowItem({ r, active, onClick }: { r: TrafficRow; active: boolean; onClick: () => void }) {
  const failed = r.status >= 400 || r.status === 0;
  return (
    <button
      id={`tr-${keyOf(r)}`}
      onClick={onClick}
      className={clsx(
        "block w-full cursor-pointer border-b border-line px-3.5 py-2.5 text-left transition-colors last:border-b-0",
        active ? "bg-hl" : "hover:bg-hover/60",
      )}
    >
      <div className="flex items-center gap-2 text-[11.5px] text-fg-4">
        <ProviderMark provider={r.provider || null} size={16} />
        <span className="min-w-0 flex-1 truncate font-mono text-fg-2">{r.model || r.url}</span>
        {failed && <Badge tone={statusTone(r.status)}>{r.status || "?"}</Badge>}
        <span className="shrink-0 tabular">{fmtTime(r.at)}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-[12.5px] break-words text-fg">{r.prompt || <span className="text-fg-5">{r.url}</span>}</div>
      {r.answer && <div className={clsx("mt-0.5 line-clamp-2 text-[12px] break-words", failed ? "text-red/90" : "text-fg-3")}>→ {r.answer}</div>}
      <div className="mt-1 flex gap-3 text-[11px] text-fg-5 tabular">
        {(r.input > 0 || r.output > 0) && (
          <span>
            {tokens(r.input)} in · {tokens(r.output)} out
          </span>
        )}
        <span>{ms(r.end - r.at)}</span>
        <span>{bytes(r.bytes)}</span>
        {r.attempts > 1 && <span className="text-yellow">{r.attempts} attempts</span>}
      </div>
    </button>
  );
}

/* ---------------- raw log reader ---------------- */

const SHOW_CHARS = 150_000;

function pretty(text: string): string {
  const t = text.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return text;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return text;
  }
}

function RawViewer({ r }: { r: TrafficRow }) {
  const [raw, setRaw] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"sections" | "raw">("sections");
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let off = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a different request was picked
    setRaw(null);
    setErr(null);
    proxyApi
      .text(`/traffic/raw?machine=${encodeURIComponent(r.machine)}&file=${encodeURIComponent(r.file)}`)
      .then((t) => !off && setRaw(t))
      .catch((e) => !off && setErr((e as Error).message));
    box.current?.scrollTo({ top: 0 });
    return () => {
      off = true;
    };
  }, [r.machine, r.file]);

  const sections = useMemo(() => (raw ? splitSections(raw) : []), [raw]);
  const convo = useMemo(() => {
    if (!raw) return null;
    const body = sections.find((s) => s.name === "REQUEST BODY")?.body ?? "";
    const resp = sections.find((s) => s.name === "RESPONSE");
    const respBody = resp ? headerBlock(resp.body.split("\n").slice(1).join("\n")).rest : "";
    const lastUp = sections.filter((s) => s.name.startsWith("API RESPONSE")).at(-1);
    const ans = answerOf(respBody || (lastUp ? attemptParts(lastUp.body).body : ""));
    return { prompt: promptOf(body), answer: ans.text };
  }, [raw, sections]);

  const copy = () => raw && navigator.clipboard.writeText(raw).then(() => toast.success("Copied the raw log"));
  const download = () => {
    if (!raw) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([raw], { type: "text/plain" }));
    a.download = r.file;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
        <div className="hidden min-w-0 flex-1 sm:block">
          <div className="truncate font-mono text-[12px] text-fg-2">{r.file}</div>
          <div className="truncate text-[11px] text-fg-4">
            {r.machine} · {r.account || r.provider || "no upstream"} · {r.key || "no key"} · {r.userAgent || "?"}
          </div>
        </div>
        <div className="flex rounded-md bg-void/60 p-0.5 max-sm:mr-auto">
          {(["sections", "raw"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={clsx("h-6.5 cursor-pointer rounded px-2.5 text-[12px] font-medium", mode === m ? "bg-hl text-fg" : "text-fg-4 hover:text-fg-2")}
            >
              {m === "sections" ? "Sections" : "Raw"}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" icon={Copy} onClick={copy} disabled={!raw}>
          Copy
        </Button>
        <Button size="sm" variant="ghost" icon={Download} onClick={download} disabled={!raw}>
          Save
        </Button>
      </div>
      <div ref={box} className="min-h-0 flex-1 overflow-auto p-3.5">
        {err ? (
          <div className="text-[12.5px] text-red">{err}</div>
        ) : raw == null ? (
          <Spinner />
        ) : mode === "raw" ? (
          <BigPre text={raw} />
        ) : (
          <>
            {convo && (convo.prompt || convo.answer) && (
              <div className="mb-4 grid gap-2">
                {convo.prompt && <Bubble label="Prompt" text={convo.prompt} tone="blue" />}
                {convo.answer && <Bubble label="Answer" text={convo.answer} tone={r.status >= 400 ? "red" : "green"} />}
              </div>
            )}
            {sections.map((s, i) => (
              <SectionBlock key={`${s.name}-${i}`} s={s} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function Bubble({ label, text, tone }: { label: string; text: string; tone: "blue" | "green" | "red" }) {
  const [all, setAll] = useState(false);
  const long = text.length > 1500;
  return (
    <div className={clsx("rounded-lg border p-3", tone === "blue" ? "border-blue/25 bg-blue/[0.05]" : tone === "green" ? "border-green/25 bg-green/[0.05]" : "border-red/25 bg-red/[0.05]")}>
      <div className={clsx("mb-1 text-[10.5px] font-semibold tracking-[0.08em] uppercase", tone === "blue" ? "text-blue" : tone === "green" ? "text-green" : "text-red")}>{label}</div>
      <div className="text-[12.5px] leading-relaxed break-words whitespace-pre-wrap text-fg-2">{long && !all ? `${text.slice(0, 1500)}…` : text}</div>
      {long && (
        <button onClick={() => setAll((v) => !v)} className="mt-1 cursor-pointer text-[11.5px] text-fg-4 hover:text-fg-2">
          {all ? "Show less" : `Show all (${text.length.toLocaleString()} characters)`}
        </button>
      )}
    </div>
  );
}

function sectionTone(name: string) {
  if (name === "RESPONSE") return "text-green";
  if (name.startsWith("API ERROR")) return "text-red";
  if (name.startsWith("API RESPONSE")) return "text-cyan";
  if (name.startsWith("API REQUEST")) return "text-magenta";
  if (name === "REQUEST BODY") return "text-blue";
  return "text-fg-3";
}

function SectionBlock({ s }: { s: LogSection }) {
  const big = s.body.length > 40_000;
  const [open, setOpen] = useState(s.name === "RESPONSE" || s.name.startsWith("API ERROR") || (s.name === "REQUEST BODY" && !big));
  const body = useMemo(() => {
    if (!open) return "";
    if (s.name === "REQUEST BODY") return pretty(s.body);
    if (s.name.startsWith("API REQUEST") || s.name.startsWith("API RESPONSE")) {
      const i = s.body.indexOf("\nBody:\n");
      return i >= 0 ? `${s.body.slice(0, i + 7)}${pretty(s.body.slice(i + 7))}` : s.body;
    }
    if (s.name === "RESPONSE") {
      const lines = s.body.split("\n");
      const { headers, rest } = headerBlock(lines.slice(1).join("\n"));
      return `${lines[0]}\n${headers.map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${pretty(rest)}`;
    }
    return s.body;
  }, [open, s]);
  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-line-2">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full cursor-pointer items-center gap-2 bg-void/40 px-3 py-1.5 text-left hover:bg-hover/50">
        {open ? <ChevronDown size={13} className="text-fg-4" /> : <ChevronRight size={13} className="text-fg-4" />}
        <span className={clsx("font-mono text-[11.5px] font-semibold", sectionTone(s.name))}>{s.name}</span>
        <span className="ml-auto text-[11px] text-fg-5 tabular">{bytes(s.body.length)}</span>
      </button>
      {open && <BigPre text={body} className="border-t border-line-2 p-3" />}
    </div>
  );
}

/** A <pre> that renders the first chunk of huge text until asked for the rest. */
function BigPre({ text, className }: { text: string; className?: string }) {
  const [all, setAll] = useState(false);
  const cut = !all && text.length > SHOW_CHARS;
  return (
    <div className={className}>
      <pre className="font-mono text-[11.5px] leading-[1.55] break-all whitespace-pre-wrap text-fg-3">{cut ? text.slice(0, SHOW_CHARS) : text}</pre>
      {cut && (
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => setAll(true)}>
          Show the remaining {bytes(text.length - SHOW_CHARS)}
        </Button>
      )}
    </div>
  );
}
