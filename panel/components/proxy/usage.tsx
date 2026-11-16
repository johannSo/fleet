"use client";

import clsx from "clsx";
import { Activity, ArrowDownToLine, ArrowUpFromLine, CircleAlert, Clock, RefreshCw, Search, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ORIGIN_LABELS, type ProxyRequest, type UsageGroup, type UsageImportStatus, type UsageRange, type UsageReport, type UsageSource } from "@/lib/cpa-types";
import { ago, clockTime } from "@/lib/format";
import { PROXY_CHANGED_EVENT } from "../terminal-provider";
import { Badge, Button, Empty, Modal, Spinner } from "../ui";
import { ms, proxyApi, tokens, useNow, useProxyData } from "./api";
import { ErrorCard } from "./accounts";
import { ProviderMark, Section, Stat, providerStyle } from "./bits";

/* ---------------- chart ---------------- */

export interface BarSeries {
  key: string;
  label: string;
  color: string;
}

/** Stacked bars over time buckets, with a hover readout. */
export function BarChart({
  data,
  series,
  bucket,
  height = 150,
  format = (v: number) => v.toLocaleString(),
}: {
  data: ({ t: number } & Record<string, number>)[];
  series: BarSeries[];
  bucket: number;
  height?: number;
  format?: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = data.map((d) => series.reduce((a, s) => a + (d[s.key] ?? 0), 0));
  const raw = Math.max(1, ...totals);
  const p = 10 ** Math.floor(Math.log10(raw));
  const n = raw / p;
  const top = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  const label = (t: number) => {
    const d = new Date(t);
    return bucket >= 86_400_000 ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) : bucket >= 6 * 3_600_000 ? `${d.toLocaleDateString(undefined, { weekday: "short" })} ${String(d.getHours()).padStart(2, "0")}h` : `${String(d.getHours()).padStart(2, "0")}:00`;
  };
  const h = hover != null ? data[hover] : null;
  return (
    <div className="relative">
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col justify-between text-[10.5px] text-fg-5 tabular" style={{ height }}>
        <div className="border-t border-dashed border-line-2 pt-0.5">{format(top)}</div>
        <div className="border-t border-dashed border-line-2 pt-0.5">{format(top / 2)}</div>
        <div className="border-t border-line-2" />
      </div>
      <div className="relative flex items-end gap-[3px] pl-10" style={{ height }} onMouseLeave={() => setHover(null)}>
        {data.map((d, i) => (
          <div key={d.t} className="flex h-full min-w-0 flex-1 cursor-default flex-col-reverse" onMouseEnter={() => setHover(i)}>
            {series.map((s) => {
              const v = d[s.key] ?? 0;
              return v > 0 ? <div key={s.key} style={{ height: `${(v / top) * 100}%`, background: s.color, opacity: hover == null || hover === i ? 1 : 0.45 }} className="w-full first:rounded-b-[2px] last:rounded-t-[2px]" /> : null;
            })}
            {totals[i] === 0 && <div className="h-px w-full bg-line-2" />}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex justify-between pl-10 text-[10.5px] text-fg-5 tabular">
        <span>{data[0] ? label(data[0].t) : ""}</span>
        <span>{data[Math.floor(data.length / 2)] ? label(data[Math.floor(data.length / 2)].t) : ""}</span>
        <span>{data.at(-1) ? label(data.at(-1)!.t) : ""}</span>
      </div>
      {totals.every((t) => t === 0) && (
        <div className="pointer-events-none absolute inset-x-0 top-0 grid place-items-center pl-10 text-[12px] text-fg-5" style={{ height }}>
          Nothing in this period
        </div>
      )}
      {h && (
        <div className="pointer-events-none absolute top-0 right-0 rounded-md border border-line-3/60 bg-[#0f1017] px-2.5 py-1.5 text-[11.5px] shadow-xl shadow-black/40">
          <div className="mb-0.5 text-fg-4">{label(h.t)}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-1.5 tabular">
              <span className="size-2 rounded-[2px]" style={{ background: s.color }} />
              <span className="text-fg-3">{s.label}</span>
              <span className="ml-auto pl-3 font-medium text-fg">{format(h[s.key] ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- page ---------------- */

const RANGES: { id: UsageRange; label: string }[] = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

const SOURCES: { id: UsageSource; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "proxy", label: "Proxies" },
  { id: "claude-code", label: "Claude Code" },
  { id: "codex", label: "Codex" },
];

export function RangeSwitch({ value, onChange }: { value: UsageRange; onChange: (r: UsageRange) => void }) {
  return <Segmented options={RANGES} value={value} onChange={onChange} />;
}

function Segmented<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-md border border-line-2 bg-panel/80 p-0.5">
      {options.map((r) => (
        <button
          key={r.id}
          onClick={() => onChange(r.id)}
          className={clsx("h-6.5 cursor-pointer rounded-[5px] px-2.5 text-[12px] font-medium transition-colors pointer-coarse:h-8", value === r.id ? "bg-hl text-fg" : "text-fg-4 hover:text-fg-2")}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

export function UsageKpis({ report }: { report: UsageReport | null }) {
  const t = report?.totals;
  const rate = t && t.requests ? ((t.requests - t.errors) / t.requests) * 100 : null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat icon={Activity} iconClass="text-blue" label="Requests" value={t ? t.requests.toLocaleString() : "–"} sub={rate == null ? "none yet" : `${rate.toFixed(rate === 100 ? 0 : 1)}% succeeded`} />
      <Stat icon={ArrowUpFromLine} iconClass="text-magenta" label="Input tokens" value={tokens(t?.input)} sub={t?.cached ? `${tokens(t.cached)} from cache` : "–"} />
      <Stat icon={ArrowDownToLine} iconClass="text-teal" label="Output tokens" value={tokens(t?.output)} sub={t?.reasoning ? `${tokens(t.reasoning)} thinking` : "–"} />
      <Stat icon={Clock} iconClass="text-yellow" label="Avg. response" value={ms(t?.avgMs)} sub={t?.avgTtft ? `first token after ${ms(t.avgTtft)}` : "–"} />
    </div>
  );
}

export function UsageView() {
  const [range, setRange] = useState<UsageRange>("24h");
  const [source, setSource] = useState<UsageSource>("all");
  const report = useProxyData(() => proxyApi.get<UsageReport>("/usage", { range, source }), [range, source]);
  const r = report.data;
  const reqData = useMemo(() => (r?.series ?? []).map((b) => ({ t: b.t, ok: b.requests - b.errors, failed: b.errors })), [r]);
  const tokData = useMemo(() => (r?.series ?? []).map((b) => ({ t: b.t, input: b.input, output: b.output })), [r]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented options={SOURCES} value={source} onChange={setSource} />
        <RangeSwitch value={range} onChange={setRange} />
      </div>
      <ImportBar onDone={report.reload} />
      {report.error && !r ? <ErrorCard message={report.error} onRetry={report.reload} /> : <UsageKpis report={r} />}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div className="card rounded-xl p-4">
          <div className="mb-3 flex items-center justify-between text-[12.5px]">
            <span className="font-medium text-fg-2">Requests</span>
            <Legend items={[{ label: "succeeded", color: "#7aa2f7" }, { label: "failed", color: "#f7768e" }]} />
          </div>
          {r ? (
            <BarChart data={reqData} bucket={r.bucket} series={[{ key: "ok", label: "Succeeded", color: "#7aa2f7" }, { key: "failed", label: "Failed", color: "#f7768e" }]} />
          ) : (
            <div className="skeleton h-[170px] rounded-md opacity-40" />
          )}
        </div>
        <div className="card rounded-xl p-4">
          <div className="mb-3 flex items-center justify-between text-[12.5px]">
            <span className="font-medium text-fg-2">Tokens</span>
            <Legend items={[{ label: "input", color: "#bb9af7" }, { label: "output", color: "#73daca" }]} />
          </div>
          {r ? (
            <BarChart data={tokData} bucket={r.bucket} format={tokens} series={[{ key: "input", label: "Input", color: "#bb9af7" }, { key: "output", label: "Output", color: "#73daca" }]} />
          ) : (
            <div className="skeleton h-[170px] rounded-md opacity-40" />
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Breakdown title="Machines" rows={r?.byMachine} />
        <Breakdown title="Models" rows={r?.byModel} mono />
        <Breakdown title="Providers" rows={r?.byProvider} provider />
        <Breakdown title="Accounts" rows={r?.byAccount} />
        {source !== "claude-code" && source !== "codex" && <Breakdown title="API keys" rows={r?.byKey} mono />}
      </div>

      <RequestLog source={source} />
    </>
  );
}

/**
 * Usage from every machine: Claude Code and Codex session logs, and any other CLIProxyAPI's
 * log. The server imports hourly; this shows when each machine was last read and runs it now.
 */
function ImportBar({ onDone }: { onDone: () => void }) {
  const state = useProxyData(() => proxyApi.get<{ running: boolean; machines: UsageImportStatus[] }>("/usage/import"), [], 60_000);
  const [busy, setBusy] = useState(false);
  const now = useNow();
  const machines = state.data?.machines ?? [];
  const ok = machines.filter((m) => m.ok);
  const failed = machines.filter((m) => !m.ok);
  const last = Math.max(0, ...machines.map((m) => m.at));
  const run = async () => {
    setBusy(true);
    try {
      const r = await proxyApi.post<{ machines: UsageImportStatus[] }>("/usage/import", {});
      const added = r.machines.reduce((a, m) => a + Object.values(m.added).reduce((x, y) => x + (y ?? 0), 0), 0);
      const off = r.machines.filter((m) => !m.ok).map((m) => m.machine);
      toast.success(added ? `Imported ${added.toLocaleString()} new requests` : "Already up to date", { description: off.length ? `Couldn't reach ${off.join(", ")}` : undefined });
      state.reload();
      onDone();
    } catch (err) {
      toast.error("Import failed", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line-2 bg-panel/60 px-3.5 py-2 text-[12px] text-fg-4">
      <span className="min-w-0 flex-1">
        Requests through the proxies, plus Claude Code and Codex usage from each machine’s session logs. Requests from another machine’s CLIProxyAPI log have no token counts.
        {machines.length > 0 && (
          <>
            {" "}
            {ok.length > 0 && (
              <>
                Read from <span className="text-fg-3">{ok.map((m) => m.machine).join(", ")}</span> {ago(last, now)}.
              </>
            )}
            {failed.map((m) => (
              <span key={m.machine} className="text-yellow" title={m.error ?? undefined}>
                {" "}
                {m.machine} wasn’t reachable{m.error ? ` (${m.error})` : ""}; it’s caught up when it’s back.
              </span>
            ))}
          </>
        )}
      </span>
      <Button size="sm" variant="ghost" icon={RefreshCw} loading={busy || state.data?.running} onClick={run}>
        Import now
      </Button>
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <span className="flex items-center gap-3 text-[11.5px] text-fg-4">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5">
          <span className="size-2 rounded-[2px]" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </span>
  );
}

function Breakdown({ title, rows, mono, provider }: { title: string; rows?: UsageGroup[]; mono?: boolean; provider?: boolean }) {
  const max = Math.max(1, ...(rows ?? []).map((r) => r.input + r.output));
  return (
    <div className="card rounded-xl p-4">
      <div className="mb-3 text-[12.5px] font-medium text-fg-2">{title}</div>
      {!rows ? (
        <div className="skeleton h-24 rounded-md opacity-40" />
      ) : rows.length === 0 ? (
        <div className="py-4 text-[12px] text-fg-4">Nothing yet.</div>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((g) => (
            <li key={g.name}>
              <div className="mb-1 flex items-center gap-2 text-[12px]">
                {provider && <ProviderMark provider={g.name} size={16} />}
                <span className={clsx("min-w-0 flex-1 truncate text-fg-2", mono && "font-mono text-[11.5px]")}>{provider ? providerStyle(g.name).label || g.name : g.name}</span>
                <span className="shrink-0 text-fg-4 tabular">
                  {g.requests.toLocaleString()}
                  {g.errors > 0 && <span className="text-red"> · {g.errors}✕</span>}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-hl/80">
                <div className="h-full rounded-full bg-blue/70" style={{ width: `${((g.input + g.output) / max) * 100}%` }} />
              </div>
              <div className="mt-0.5 text-right text-[10.5px] text-fg-5 tabular">{tokens(g.input + g.output)} tokens</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------- request log ---------------- */

export function RequestLog({ limit = 60, compact, source = "all" }: { limit?: number; compact?: boolean; source?: UsageSource }) {
  const [failedOnly, setFailedOnly] = useState(false);
  const [query, setQuery] = useState("");
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<ProxyRequest[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ProxyRequest | null>(null);
  const filters = useRef({ failedOnly, q, source });
  useEffect(() => {
    filters.current = { failedOnly, q, source };
  }, [failedOnly, q, source]);

  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(
    async (after?: ProxyRequest) => {
      const before = after?.at;
      try {
        const r = await proxyApi.get<{ requests: ProxyRequest[]; more: boolean }>("/requests", {
          limit,
          before,
          beforeId: after?.id,
          failed: filters.current.failedOnly ? 1 : undefined,
          q: filters.current.q || undefined,
          source: filters.current.source,
        });
        setRows((prev) => (before ? [...prev, ...r.requests] : r.requests));
        if (!before || r.requests.length) setMore(r.more);
        setError(null);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [limit],
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- filters changed
    setLoading(true);
    void load();
  }, [failedOnly, q, source, load]);

  // new requests arrive with proxy change notifications; refresh the first page
  useEffect(() => {
    const on = () => void load();
    window.addEventListener(PROXY_CHANGED_EVENT, on);
    return () => window.removeEventListener(PROXY_CHANGED_EVENT, on);
  }, [load]);

  return (
    <Section
      title={compact ? "Latest requests" : "Requests"}
      className="mt-8"
      right={
        !compact && (
          <>
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-4" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Model, account, machine, error…"
                className="h-7.5 w-56 rounded-md border border-line-2 bg-panel/80 pr-2 pl-8 text-[12.5px] text-fg placeholder:text-fg-5 focus:border-blue/60 pointer-coarse:h-9"
              />
            </div>
            <Button size="sm" variant={failedOnly ? "danger" : "ghost"} icon={CircleAlert} onClick={() => setFailedOnly((f) => !f)}>
              Failed only
            </Button>
          </>
        )
      }
    >
      {error && !rows.length ? (
        <ErrorCard message={error} onRetry={() => load()} />
      ) : loading && !rows.length ? (
        <div className="card skeleton h-40 rounded-xl opacity-50" />
      ) : !rows.length ? (
        <div className="card rounded-xl">
          <Empty icon={Zap} title={failedOnly || q ? "No matching requests" : "No requests yet"} hint={failedOnly || q ? undefined : "Point a client at the proxy and they show up here as they happen."} />
        </div>
      ) : (
        <div className="card overflow-hidden rounded-xl">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[12.5px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] font-semibold tracking-[0.06em] text-fg-4 uppercase">
                  <th className="px-4 py-2 font-semibold">Time</th>
                  <th className="px-2 py-2 font-semibold">Model</th>
                  <th className="px-2 py-2 font-semibold">Account</th>
                  <th className="px-2 py-2 font-semibold">Source</th>
                  <th className="px-2 py-2 text-right font-semibold">In</th>
                  <th className="px-2 py-2 text-right font-semibold">Out</th>
                  <th className="px-2 py-2 text-right font-semibold">Time taken</th>
                  <th className="px-4 py-2 text-right font-semibold">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => setOpen(r)} className="cursor-pointer transition-colors hover:bg-hover/60">
                    <td className="px-4 py-2 whitespace-nowrap text-fg-4 tabular">{fmtTime(r.at)}</td>
                    <td className="max-w-[260px] px-2 py-2">
                      <div className="flex items-center gap-2">
                        <ProviderMark provider={r.provider} size={16} />
                        <span className="truncate font-mono text-[12px] text-fg-2">{r.alias && r.alias !== r.model ? `${r.alias} → ${r.model}` : r.model}</span>
                      </div>
                    </td>
                    <td className="max-w-[200px] truncate px-2 py-2 text-fg-3">{r.account ?? "–"}</td>
                    <td className="px-2 py-2 whitespace-nowrap text-fg-4">{sourceLabel(r)}</td>
                    <td className="px-2 py-2 text-right text-fg-3 tabular">{r.origin === "cpa" ? "–" : tokens(r.input)}</td>
                    <td className="px-2 py-2 text-right text-fg-3 tabular">{r.origin === "cpa" ? "–" : tokens(r.output)}</td>
                    <td className="px-2 py-2 text-right whitespace-nowrap text-fg-3 tabular">{ms(r.latencyMs)}</td>
                    <td className="px-4 py-2 text-right">{r.failed ? <Badge tone="red">{r.status ?? "failed"}</Badge> : <span className="text-[12px] text-green">ok</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {more && !compact && (
            <div className="border-t border-line p-2 text-center">
              <Button size="sm" variant="ghost" onClick={() => load(rows.at(-1))}>
                Load older
              </Button>
            </div>
          )}
        </div>
      )}
      <RequestDetail r={open} onClose={() => setOpen(null)} />
    </Section>
  );
}

function sourceLabel(r: ProxyRequest): string {
  return `${r.machine ?? "?"} · ${ORIGIN_LABELS[r.origin] ?? r.origin}`;
}

function fmtTime(at: number): string {
  const d = new Date(at);
  const today = new Date().toDateString() === d.toDateString();
  return today ? clockTime(at) : `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${clockTime(at)}`;
}

function RequestDetail({ r, onClose }: { r: ProxyRequest | null; onClose: () => void }) {
  const [log, setLog] = useState<string | null>(null);
  const [loadingLog, setLoadingLog] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a different request was opened
    setLog(null);
  }, [r]);
  if (!r) return <Modal open={false} onClose={onClose} title="" />;
  const rows: [string, React.ReactNode][] = [
    ["When", new Date(r.at).toLocaleString()],
    ["Model", <span key="m" className="font-mono">{r.model}{r.alias && r.alias !== r.model ? ` (asked for ${r.alias})` : ""}</span>],
    ["Source", sourceLabel(r)],
    ["Provider", r.provider ?? "–"],
    ["Account", r.account ?? "–"],
    ["API key", <span key="k" className="font-mono">{r.key ?? "–"}</span>],
    ["Endpoint", <span key="e" className="font-mono">{r.endpoint ?? "–"}</span>],
    ["Client", `${r.clientIp ?? "?"}${r.userAgent ? ` · ${r.userAgent}` : ""}`],
    ["Streaming", r.origin === "cpa" ? "–" : r.stream ? "yes" : "no"],
    ["Tokens", r.origin === "cpa" ? "not recorded (CLIProxyAPI's log has no token counts)" : `${r.input.toLocaleString()} in${r.cached ? ` (${r.cached.toLocaleString()} cached)` : ""} · ${r.output.toLocaleString()} out${r.reasoning ? ` (${r.reasoning.toLocaleString()} thinking)` : ""}`],
    ["Time taken", `${ms(r.latencyMs)}${r.ttftMs ? ` · first token ${ms(r.ttftMs)}` : ""}`],
  ];
  if (r.effort) rows.push(["Effort", r.effort]);
  if (r.requestId) rows.push(["Request id", <span key="i" className="font-mono">{r.requestId}</span>]);
  const fetchLog = async () => {
    if (!r.requestId) return;
    setLoadingLog(true);
    try {
      const res = await fetch(`/api/proxy/m/observability/logs/requests/${encodeURIComponent(r.requestId)}`);
      setLog(res.ok ? await res.text() : "No request log was kept for this request. Turn on Settings → Logs → Request logs to keep full request and response bodies.");
    } finally {
      setLoadingLog(false);
    }
  };
  return (
    <Modal open onClose={onClose} width={640} icon={r.failed ? CircleAlert : Zap} tone={r.failed ? "red" : "blue"} title={r.failed ? `Failed${r.status ? ` · HTTP ${r.status}` : ""}` : "Request"} description={r.model}>
      <dl className="grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 pb-3 text-[12.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-4">{k}</dt>
            <dd className="break-words text-fg-2">{v}</dd>
          </div>
        ))}
      </dl>
      {r.error && <pre className="mb-3 max-h-60 overflow-auto rounded-lg border border-red/25 bg-red/[0.05] p-3 font-mono text-[11.5px] whitespace-pre-wrap text-red">{r.error}</pre>}
      {r.requestId && r.origin === "fleet" && (
        <div className="pb-3">
          {log == null ? (
            <Button size="sm" variant="ghost" loading={loadingLog} onClick={fetchLog}>
              Show full request log
            </Button>
          ) : (
            <pre className="max-h-80 overflow-auto rounded-lg border border-line-2 bg-void/60 p-3 font-mono text-[11px] whitespace-pre-wrap text-fg-3">{log}</pre>
          )}
        </div>
      )}
      {loadingLog && <Spinner />}
    </Modal>
  );
}
