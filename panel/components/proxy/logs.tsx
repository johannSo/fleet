"use client";

import clsx from "clsx";
import { Download, FileWarning, Pause, Play, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { bytes } from "@/lib/format";
import { Button, Empty, HoldButton, Modal } from "../ui";
import { mgmt, proxyApi, useProxyData } from "./api";
import { ErrorCard } from "./accounts";
import { Section, Toggle } from "./bits";

interface LogsResponse {
  lines: string[];
  "line-count": number;
  "latest-timestamp": number;
  "next-cursor": string;
  "cursor-reset"?: boolean;
}

const MAX_LINES = 5000;
/** The panel's own polling of the Management API and model list, from this machine. */
const PANEL_TRAFFIC = /127\.0\.0\.1\s+\|\s+\w+\s+"\/(v8|v0)\/management\/|127\.0\.0\.1\s+\|\s+GET\s+"\/v1\/models"/;

function levelClass(line: string): string {
  if (/\[(error|fatal|panic)\s*\]/i.test(line) || /\|\s+5\d\d\s+\|/.test(line)) return "text-red";
  if (/\[warn(ing)?\s*\]/i.test(line) || /\|\s+4\d\d\s+\|/.test(line)) return "text-yellow";
  if (/\[debug\s*\]/i.test(line)) return "text-fg-5";
  return "text-fg-3";
}

export function LogsView() {
  const [tab, setTab] = useState<"proxy" | "errors" | "service">("proxy");
  return (
    <>
      <div className="mb-4 flex gap-1">
        {(
          [
            ["proxy", "Proxy log"],
            ["errors", "Failed request files"],
            ["service", "Service output"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} className={clsx("h-7.5 cursor-pointer rounded-md px-3 text-[12.5px] font-medium transition-colors pointer-coarse:h-9", tab === id ? "bg-hl text-fg" : "text-fg-4 hover:bg-hover hover:text-fg-2")}>
            {label}
          </button>
        ))}
      </div>
      {tab === "proxy" ? <ProxyLog /> : tab === "errors" ? <ErrorFiles /> : <ServiceOutput />}
    </>
  );
}

function ProxyLog() {
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const [hidePanel, setHidePanel] = useState(true);
  const [clearing, setClearing] = useState(false);
  const cursor = useRef<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const fetchMore = useCallback(async (reset = false) => {
    try {
      const r = await mgmt.get<LogsResponse>("/observability/logs", reset || !cursor.current ? { limit: 1000 } : { cursor: cursor.current });
      cursor.current = r["next-cursor"] || cursor.current;
      setLines((prev) => {
        const next = reset || r["cursor-reset"] ? r.lines : [...prev, ...r.lines];
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void fetchMore(true);
  }, [fetchMore]);

  useEffect(() => {
    if (!follow) return;
    const t = setInterval(() => document.visibilityState === "visible" && void fetchMore(), 2500);
    return () => clearInterval(t);
  }, [follow, fetchMore]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return lines.filter((l) => (!hidePanel || !PANEL_TRAFFIC.test(l)) && (!q || l.toLowerCase().includes(q)));
  }, [lines, filter, hidePanel]);

  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown]);

  return (
    <Section
      title="Proxy log"
      hint="CLIProxyAPI's own log: requests, sign-ins, token renewals, errors."
      right={
        <>
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-4" />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter lines" className="h-7.5 w-48 rounded-md border border-line-2 bg-panel/80 pr-2 pl-8 text-[12.5px] text-fg placeholder:text-fg-5 focus:border-blue/60 pointer-coarse:h-9" />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-fg-3">
            <Toggle label="Hide the panel's own calls" checked={hidePanel} onChange={setHidePanel} />
            Hide panel calls
          </label>
          <Button size="sm" variant="secondary" icon={follow ? Pause : Play} onClick={() => setFollow((f) => !f)}>
            {follow ? "Pause" : "Follow"}
          </Button>
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setClearing(true)}>
            Clear
          </Button>
        </>
      }
    >
      {error && !lines.length ? (
        <ErrorCard message={error.includes("logging to file disabled") ? "File logging is off. Turn it on in Settings → Logs." : error} onRetry={() => fetchMore(true)} />
      ) : (
        <div
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          className="card h-[calc(100dvh-330px)] min-h-[320px] overflow-auto rounded-xl bg-void/70 p-3 font-mono text-[11.5px] leading-[1.6]"
        >
          {shown.length === 0 ? (
            <div className="p-4 text-fg-4">{filter ? "No matching lines." : "Nothing logged yet."}</div>
          ) : (
            shown.map((l, i) => (
              <div key={i} className={clsx("break-all whitespace-pre-wrap", levelClass(l))}>
                {l}
              </div>
            ))
          )}
        </div>
      )}
      <Modal
        open={clearing}
        onClose={() => setClearing(false)}
        tone="red"
        title="Clear the proxy log?"
        description="Deletes CLIProxyAPI's log files. The panel's own usage history is kept."
        footer={
          <HoldButton
            onConfirm={async () => {
              setClearing(false);
              try {
                await mgmt.del("/observability/logs");
                cursor.current = null;
                setLines([]);
                toast.success("Log cleared");
              } catch (err) {
                toast.error("Couldn't clear it", { description: (err as Error).message });
              }
            }}
          >
            Hold to clear
          </HoldButton>
        }
      />
    </Section>
  );
}

function ErrorFiles() {
  const files = useProxyData(() => mgmt.get<{ files: { name: string; size: number; modified: number }[] }>("/observability/logs/errors").then((r) => r.files ?? []), []);
  return (
    <Section title="Failed request files" hint="When request logging is off, CLIProxyAPI still saves the full request and response of each failure, newest first.">
      {files.error && !files.data ? (
        <ErrorCard message={files.error} onRetry={files.reload} />
      ) : !files.data ? (
        <div className="card skeleton h-24 rounded-xl opacity-50" />
      ) : files.data.length === 0 ? (
        <div className="card rounded-xl">
          <Empty icon={FileWarning} title="No failures saved" />
        </div>
      ) : (
        <div className="card divide-y divide-line overflow-hidden rounded-xl">
          {files.data.map((f) => (
            <a key={f.name} href={`/api/proxy/m/observability/logs/errors/${encodeURIComponent(f.name)}`} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px] hover:bg-hover/60">
              <FileWarning size={14} className="text-red" />
              <span className="min-w-0 flex-1 truncate font-mono text-fg-2">{f.name}</span>
              <span className="text-fg-4 tabular">{new Date(f.modified * 1000).toLocaleString()}</span>
              <span className="w-16 text-right text-fg-4 tabular">{bytes(f.size)}</span>
              <Download size={14} className="text-fg-4" />
            </a>
          ))}
        </div>
      )}
    </Section>
  );
}

function ServiceOutput() {
  const out = useProxyData(() => proxyApi.text("/journal?lines=500"), [], 5000);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [out.data]);
  return (
    <Section title="Service output" hint="The systemd journal of fleet-proxy.service. If the proxy won't start, the reason is here.">
      <pre ref={box} className="card h-[calc(100dvh-330px)] min-h-[320px] overflow-auto rounded-xl bg-void/70 p-3 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap text-fg-3">
        {out.data ?? "Loading…"}
      </pre>
    </Section>
  );
}
