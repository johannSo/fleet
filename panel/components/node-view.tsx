"use client";

import clsx from "clsx";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Boxes,
  Check,
  ChevronDown,
  CloudDownload,
  Container,
  Copy,
  Cpu,
  ExternalLink,
  FileText,
  Gauge,
  HardDrive,
  Info,
  ListTree,
  MemoryStick,
  MoreHorizontal,
  Network,
  Pencil,
  Play,
  Power,
  Radio,
  RefreshCw,
  RotateCw,
  ScanSearch,
  ScrollText,
  Search,
  Skull,
  Sparkles,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIsMobile } from "./hooks";
import { toast } from "sonner";
import { ago, bytes, duration, explainError, pct, rate } from "@/lib/format";
import type { FleetNode, NodeDetails, ProcessRow, UnitRow } from "@/lib/types";
import { PackageList, UpdateScriptCard, updaterLabel, useActions } from "./actions";
import { AreaChart } from "./charts";
import { useFleet } from "./fleet-provider";
import { Md } from "./md";
import { NodeIcon, kindLabel } from "./node-icon";
import { api } from "./machine-editor";
import { LocalBadge, ReportingBadge, StatusPill, modelOf, osOf } from "./overview";
import { useTerminals } from "./terminal-provider";
import { ACCENT, Badge, Button, Empty, IconButton, Menu, Meter, Spinner, Tooltip, usageColor, useCopy } from "./ui";

type Tab = "overview" | "services" | "processes" | "updates";

export function NodeView({ id }: { id: string }) {
  const fleet = useFleet();
  const node = fleet.nodes.find((n) => n.id === id);
  const [tab, setTab] = useState<Tab>("overview");

  if (!fleet.loaded) {
    return (
      <div className="mx-auto max-w-[1440px] px-4 pt-5 sm:px-6 sm:py-7 lg:px-8">
        <div className="skeleton mb-6 h-28 rounded-xl opacity-50" />
        <div className="skeleton h-80 rounded-xl opacity-40" />
      </div>
    );
  }
  if (!node) {
    return (
      <div className="mx-auto max-w-xl px-6 py-24">
        <Empty
          icon={Search}
          title={`No machine called “${id}”`}
          hint={
            <>
              It isn&apos;t in the inventory.{" "}
              <Link href="/" className="text-blue hover:underline">
                Back to overview
              </Link>
            </>
          }
        />
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-[1440px] px-4 pt-4 pb-10 sm:px-6 sm:pt-7 lg:px-8">
      <Hero node={node} />
      <Callouts node={node} />
      <Tabs node={node} tab={tab} setTab={setTab} />
      <div className="mt-5">
        {tab === "overview" && <OverviewTab node={node} />}
        {tab === "services" && <ServicesTab node={node} />}
        {tab === "processes" && <ProcessesTab node={node} />}
        {tab === "updates" && <UpdatesTab node={node} />}
      </div>
    </div>
  );
}

/* ---------------- hero ---------------- */

function Chip({ label, value, onCopy, copied }: { label: string; value: string; onCopy?: () => void; copied?: boolean }) {
  return (
    <Tooltip content={copied ? "Copied" : `Copy ${value}`}>
      <button
        onClick={onCopy}
        className="group inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-line-2 bg-panel/60 px-2 text-[11.5px] transition-colors hover:border-line-3 hover:bg-hover pointer-coarse:h-9 pointer-coarse:rounded-lg pointer-coarse:px-3 pointer-coarse:text-[13px]"
      >
        <span className="text-fg-4">{label}</span>
        <span className="font-mono text-fg-2">{value}</span>
        {copied ? <Check size={11} className="text-green" /> : <Copy size={11} className="hidden text-fg-4 group-hover:block" />}
      </button>
    </Tooltip>
  );
}

function Hero({ node }: { node: FleetNode }) {
  const fleet = useFleet();
  const actions = useActions();
  const { copy, copied } = useCopy();
  const s = fleet.states[node.id];
  const m = s?.metrics;
  const st = fleet.displayStatus(node.id);
  const online = st === "online";
  const accent = fleet.accent(node.id);
  const a = ACCENT[accent];
  const upd = fleet.updates[node.id];

  return (
    <section className="card relative overflow-hidden rounded-xl">
      <div className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(50% 140% at 0% 0%, ${a.hex}1a, transparent 65%)` }} />
      <div className="relative flex flex-wrap items-center gap-x-6 gap-y-3.5 px-4 py-3.5 sm:gap-y-4 sm:px-5 sm:py-4.5 lg:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <div className="max-sm:hidden">
            <NodeIcon kind={node.kind} accent={accent} size={52} dim={!online && st !== "unknown"} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className={clsx("font-mono text-[24px] leading-none font-semibold tracking-tight", a.text)}>{node.id}</h1>
              <StatusPill status={st} latency={s?.latencyMs ?? null} via={s?.via} />
              {node.local && <LocalBadge />}
              <ReportingBadge node={node} />
              <IconButton icon={Pencil} label="Edit machine" size={26} onClick={() => actions.editMachine(node.id)} />
            </div>
            <p className="mt-1.5 text-[13px] text-fg-3 sm:truncate">
              <span className="max-sm:hidden">
                {kindLabel(node.kind)} <span className="text-fg-5">·</span>{" "}
              </span>
              {modelOf(node)} <span className="text-fg-5">·</span> {osOf(node, m?.osName)}
              {node.location && (
                <span className="max-sm:hidden">
                  {" "}
                  <span className="text-fg-5">·</span> {node.location}
                </span>
              )}
            </p>
            <p className="mt-0.5 text-[13px] text-fg-2 max-sm:hidden">
              <Md text={node.use.charAt(0).toUpperCase() + node.use.slice(1)} />
            </p>
            <div className="rail -mr-4 mt-2.5 flex gap-1.5 overflow-x-auto pr-6 [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)] sm:mr-0 sm:flex-wrap sm:overflow-visible sm:pr-0 sm:[mask-image:none]">
              {node.ips.map((ip) => (
                <Chip key={ip.label + ip.value} label={ip.label} value={ip.value} onCopy={() => copy(ip.value)} copied={copied === ip.value} />
              ))}
              {node.sshCommand && (
                <Chip label="ssh" value={node.sshCommand.replace(/^ssh /, "")} onCopy={() => copy(node.sshCommand!)} copied={copied === node.sshCommand} />
              )}
            </div>
          </div>
        </div>

        <div className="grid w-full grid-cols-4 gap-2 sm:hidden">
          {[
            { label: "Shell", icon: TerminalSquare, onClick: () => actions.shell(node.id), primary: true },
            { label: (upd?.count ?? 0) > 0 ? `Update · ${upd!.count}` : "Update", icon: CloudDownload, onClick: () => actions.update(node.id) },
            { label: "Run", icon: Play, onClick: () => actions.run([node.id]) },
          ].map((b) => (
            <button
              key={b.label}
              disabled={!online}
              onClick={b.onClick}
              className={clsx(
                "flex h-14 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl text-[12.5px] font-medium transition-colors disabled:opacity-40",
                b.primary ? "bg-blue text-[#11131c] active:bg-[#8db0ff]" : "bg-hl/70 text-fg-2 active:bg-line-3",
              )}
            >
              <b.icon size={19} strokeWidth={2} />
              {b.label}
            </button>
          ))}
          <Menu
            items={[
              { label: "Reboot…", icon: RotateCw, tone: "warning", onSelect: () => actions.power(node.id, "reboot") },
              { label: "Shut down…", icon: Power, tone: "danger", onSelect: () => actions.power(node.id, "shutdown") },
            ]}
            trigger={(p) => (
              <button
                {...p}
                disabled={!online}
                className="flex h-14 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl bg-yellow/10 text-[12.5px] font-medium text-yellow ring-1 ring-yellow/25 ring-inset active:bg-yellow/20 disabled:opacity-40"
              >
                <Power size={19} strokeWidth={2} />
                Power
              </button>
            )}
          />
        </div>
        <div className="grid w-full grid-cols-3 gap-2 max-sm:hidden sm:flex sm:w-auto sm:flex-wrap sm:items-center">
          <Button variant="primary" icon={TerminalSquare} disabled={!online} onClick={() => actions.shell(node.id)} className="col-span-3 max-sm:h-11 max-sm:text-[15px]">
            Open shell
          </Button>
          <Button variant="secondary" icon={CloudDownload} disabled={!online} onClick={() => actions.update(node.id)}>
            Update
            {(upd?.count ?? 0) > 0 && <span className="rounded-full bg-blue/15 px-1.5 text-[11px] font-semibold text-blue tabular">{upd!.count}</span>}
          </Button>
          <Button variant="secondary" icon={Play} disabled={!online} onClick={() => actions.run([node.id])}>
            <span className="sm:hidden">Run</span>
            <span className="max-sm:hidden">Run command</span>
          </Button>
          <Link
            href={`/ai?node=${encodeURIComponent(node.id)}`}
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border border-magenta/25 bg-magenta/10 px-3.5 text-[13px] font-medium whitespace-nowrap text-magenta transition-colors hover:border-magenta/40 hover:bg-magenta/18"
          >
            <Sparkles size={15} /> Ask AI
          </Link>
          <div className="flex">
            <Button
              variant="warning"
              icon={RotateCw}
              disabled={!online}
              className="min-w-0 flex-1 rounded-r-none border-r-0 max-sm:px-3.5"
              onClick={() => actions.power(node.id, "reboot")}
            >
              Reboot
            </Button>
            <Menu
              items={[
                { label: "Reboot…", icon: RotateCw, tone: "warning", onSelect: () => actions.power(node.id, "reboot") },
                { label: "Shut down…", icon: Power, tone: "danger", onSelect: () => actions.power(node.id, "shutdown") },
              ]}
              trigger={(p) => (
                <button
                  {...p}
                  disabled={!online}
                  aria-label="More power options"
                  className="inline-flex h-9 cursor-pointer items-center rounded-r-md border border-yellow/25 bg-yellow/10 px-2 text-yellow transition-colors hover:bg-yellow/18 disabled:pointer-events-none disabled:opacity-45 pointer-coarse:h-10 pointer-coarse:w-11 pointer-coarse:justify-center"
                >
                  <ChevronDown size={14} />
                </button>
              )}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function Callouts({ node }: { node: FleetNode }) {
  const fleet = useFleet();
  const actions = useActions();
  const s = fleet.states[node.id];
  const m = s?.metrics;
  const st = fleet.displayStatus(node.id);
  const items: React.ReactNode[] = [];

  if (st === "offline" || st === "powered-off") {
    items.push(
      <Banner
        key="off"
        tone="red"
        icon={Power}
        title={st === "powered-off" ? "Powered off" : explainError(s?.error)}
        action={
          <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => fleet.probe(node.id)}>
            Retry
          </Button>
        }
      >
        <span className="font-mono text-[11.5px]">{s?.error}</span>
        {s?.lastSeen ? ` · last seen ${ago(s.lastSeen)}` : ""}
      </Banner>,
    );
  }
  if (st === "rebooting" || st === "shutting-down") {
    items.push(
      <Banner key="reb" tone="yellow" icon={RotateCw} title={st === "rebooting" ? "Rebooting" : "Shutting down"} spin>
        {s?.status === "offline" ? "Waiting for the machine to come back online…" : "Waiting for the machine to go down…"}
      </Banner>,
    );
  }
  if (m?.rebootRequired && st === "online") {
    items.push(
      <Banner
        key="rr"
        tone="yellow"
        icon={RotateCw}
        title="Reboot required"
        action={
          <Button size="sm" variant="warning" icon={RotateCw} onClick={() => actions.power(node.id, "reboot")}>
            Reboot now
          </Button>
        }
      >
        A newer kernel is installed than the one running (<span className="font-mono">{m.kernel}</span>).
      </Banner>,
    );
  }
  if (m && m.failedUnits.length > 0) {
    items.push(
      <Banner key="fail" tone="red" icon={AlertTriangle} title={`${m.failedUnits.length} failed unit${m.failedUnits.length > 1 ? "s" : ""}`}>
        <span className="font-mono">{m.failedUnits.join(", ")}</span>
      </Banner>,
    );
  }
  if (!items.length) return null;
  return <div className="mt-3 space-y-2">{items}</div>;
}

function Banner({
  tone,
  icon: Icon,
  title,
  children,
  action,
  spin,
}: {
  tone: "red" | "yellow" | "blue";
  icon: typeof Info;
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  spin?: boolean;
}) {
  const cls = {
    red: "border-red/20 bg-red/[0.05] [--c:var(--color-red)]",
    yellow: "border-yellow/20 bg-yellow/[0.05] [--c:var(--color-yellow)]",
    blue: "border-blue/15 bg-blue/[0.04] [--c:var(--color-blue)]",
  }[tone];
  return (
    <div className={clsx("flex items-center gap-3 rounded-lg border px-4 py-2.5", cls)}>
      <Icon size={15} className={clsx("shrink-0 text-(--c)", spin && "animate-spin-slow")} />
      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-fg-3">
        <span className="mr-2 font-semibold text-(--c)">{title}</span>
        {children}
      </div>
      {action}
    </div>
  );
}

function Tabs({ node, tab, setTab }: { node: FleetNode; tab: Tab; setTab: (t: Tab) => void }) {
  const fleet = useFleet();
  const upd = fleet.updates[node.id];
  const failed = fleet.states[node.id]?.metrics?.failedUnits.length ?? 0;
  const tabs: { id: Tab; label: string; short: string; icon: typeof Gauge; badge?: number; tone?: "red" | "blue" }[] = [
    { id: "overview", label: "Overview", short: "Overview", icon: Gauge },
    { id: "services", label: "Services", short: "Services", icon: Boxes, badge: failed || undefined, tone: "red" },
    { id: "processes", label: "Processes", short: "Procs", icon: ListTree },
    { id: "updates", label: "Updates", short: "Updates", icon: CloudDownload, badge: upd && upd.count > 0 ? upd.count : undefined, tone: "blue" },
  ];
  return (
    <div className="sticky top-0 z-20 -mx-4 mt-5 bg-bg/90 px-4 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <div className="rail grid grid-cols-4 items-center border-b border-line sm:flex sm:gap-1 sm:overflow-x-auto" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={clsx(
              "relative -mb-px flex h-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 px-1 text-[13px] font-medium transition-colors sm:gap-2 sm:px-3 pointer-coarse:h-12 pointer-coarse:text-[14px]",
              tab === t.id ? "text-fg" : "text-fg-4 hover:text-fg-2",
            )}
          >
            <t.icon size={14} className={clsx(tab === t.id ? "text-blue" : "", "max-sm:hidden")} />
            <span className="sm:hidden">{t.short}</span>
            <span className="max-sm:hidden">{t.label}</span>
            {t.badge != null && (
              <span className={clsx("rounded-full px-1.5 text-[10.5px] font-semibold tabular", t.tone === "red" ? "bg-red/15 text-red" : "bg-blue/15 text-blue")}>
                {t.badge}
              </span>
            )}
            {tab === t.id && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-blue" />}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------------- overview tab ---------------- */

function Panel({
  title,
  icon: Icon,
  right,
  children,
  className,
  flush,
  phoneHeader = true,
}: {
  phoneHeader?: boolean;
  title: string;
  icon?: typeof Info;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={clsx("card rounded-xl", className)}>
      <div className={clsx("flex min-h-11 flex-wrap items-center gap-2 border-b border-line px-4 py-1.5", !phoneHeader && "max-md:hidden")}>
        {Icon && <Icon size={14} className="text-fg-4" />}
        <h3 className="text-[12.5px] font-semibold text-fg-2">{title}</h3>
        <div className="ml-auto">{right}</div>
      </div>
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}

function Legend({ items }: { items: { label: string; color: string; value: string }[] }) {
  return (
    <div className="flex items-center gap-4">
      {items.map((i) => (
        <span key={i.label} className="flex items-center gap-1.5 text-[11.5px] text-fg-4">
          <span className="size-2 rounded-full" style={{ background: i.color }} />
          {i.label}
          <span className="font-mono text-fg-2 tabular">{i.value}</span>
        </span>
      ))}
    </div>
  );
}

function VitalRow({ label, value, sub, percent, color }: { label: string; value: React.ReactNode; sub?: React.ReactNode; percent?: number | null; color?: string }) {
  return (
    <div className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex items-baseline gap-2 text-[12.5px]">
        <span className="text-fg-3">{label}</span>
        {sub && <span className="truncate text-[11px] text-fg-4">{sub}</span>}
        <span className="ml-auto font-mono text-fg tabular">{value}</span>
      </div>
      {percent !== undefined && <Meter value={percent} color={color} height={4} className="mt-1.5" />}
    </div>
  );
}

function bootedAt(ts: number, now: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  if (new Date(now).toDateString() === d.toDateString()) return `${time} today`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

function OverviewTab({ node }: { node: FleetNode }) {
  const fleet = useFleet();
  const phone = useIsMobile();
  const s = fleet.states[node.id];
  const m = s?.metrics;
  const hist = fleet.history[node.id] ?? [];
  const times = hist.map((h) => h.at);

  if (!m || !s) {
    return (
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Empty icon={Gauge} title="No live data" hint="Metrics appear here once the machine answers over ssh or its agent reports." />
        </div>
        <div className="space-y-4">
          <FleetInfo node={node} />
          <AgentPanel node={node} />
        </div>
      </div>
    );
  }
  const memPct = (m.memUsed / m.memTotal) * 100;
  const swapPct = m.swapTotal ? (m.swapUsed / m.swapTotal) * 100 : null;
  const loadPct = (m.load[0] / m.cpus) * 100;
  const tempColor = m.tempC == null ? undefined : m.tempC > 80 ? "#f7768e" : m.tempC > 65 ? "#e0af68" : "#7dcfff";

  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Panel title="CPU" icon={Cpu} right={<Legend items={[{ label: "usage", color: "#7aa2f7", value: pct(m.cpu, 1) }]} />}>
          <AreaChart series={[{ label: "CPU", color: "#7aa2f7", values: hist.map((h) => h.cpu) }]} times={times} max={100} format={(v) => `${v.toFixed(0)}%`} height={phone ? 120 : 196} />
        </Panel>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Panel title="Memory" icon={MemoryStick} right={<Legend items={[{ label: "used", color: "#bb9af7", value: pct(memPct, 1) }]} />}>
            <AreaChart series={[{ label: "Memory", color: "#bb9af7", values: hist.map((h) => h.mem) }]} times={times} max={100} format={(v) => `${v.toFixed(0)}%`} height={phone ? 100 : 120} />
          </Panel>
          <Panel
            title="Network"
            icon={Network}
            right={
              <Legend
                items={[
                  { label: "in", color: "#73daca", value: rate(m.rx) },
                  { label: "out", color: "#ff9e64", value: rate(m.tx) },
                ]}
              />
            }
          >
            <AreaChart
              series={[
                { label: "In", color: "#73daca", values: hist.map((h) => h.rx) },
                { label: "Out", color: "#ff9e64", values: hist.map((h) => h.tx) },
              ]}
              times={times}
              format={(v) => rate(v)}
              height={phone ? 100 : 120}
            />
          </Panel>
        </div>
        <Panel title="Storage" icon={HardDrive}>
          <div className="space-y-3.5">
            {m.disks.map((d) => {
              const p = (d.used / d.size) * 100;
              return (
                <div key={d.mount}>
                  <div className="mb-1.5 flex items-baseline gap-2 text-[12.5px]">
                    <span className="font-mono font-medium text-fg">{d.mount}</span>
                    <span className="text-[11px] text-fg-4">{d.fstype}</span>
                    <span className="ml-auto font-mono text-fg-3 tabular max-sm:hidden">
                      {bytes(d.used)} <span className="text-fg-5">/</span> {bytes(d.size)} <span className="text-fg-5">·</span> {bytes(d.size - d.used)} free
                    </span>
                    <span className="w-12 text-right font-mono font-semibold tabular max-sm:ml-auto" style={{ color: p >= 80 ? usageColor("disk", p) : undefined }}>
                      {pct(p)}
                    </span>
                  </div>
                  <Meter value={p} height={6} color={usageColor("disk", p)} />
                  <div className="mt-1.5 text-[12px] text-fg-4 tabular sm:hidden">
                    {bytes(d.used)} of {bytes(d.size)} · {bytes(d.size - d.used)} free
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>

      <div className="space-y-4">
        <Panel title="Vitals" icon={Gauge}>
          <div className="divide-y divide-line">
            <VitalRow label="Load" sub={`${m.cpus} cores`} value={m.load.map((l) => l.toFixed(2)).join(" · ")} percent={loadPct} color={usageColor("cpu", loadPct)} />
            <VitalRow label="Memory" sub={`${bytes(m.memUsed)} of ${bytes(m.memTotal, 0)}`} value={pct(memPct, 1)} percent={memPct} color={usageColor("mem", memPct)} />
            {swapPct == null ? (
              <VitalRow label="Swap" value="off" />
            ) : (
              <VitalRow label="Swap" sub={`${bytes(m.swapUsed)} of ${bytes(m.swapTotal, 0)}`} value={pct(swapPct, 1)} percent={swapPct} color={usageColor("swap", swapPct)} />
            )}
            {m.tempC != null && <VitalRow label="Temperature" sub="hottest sensor" value={<span style={{ color: tempColor }}>{m.tempC.toFixed(0)}°C</span>} />}
            <VitalRow label="Uptime" sub={`since ${bootedAt(s.checkedAt - m.uptime * 1000, s.checkedAt)}`} value={duration(m.uptime)} />
            <VitalRow
              label={s.via === "agent" ? "agent round-trip" : "ssh round-trip"}
              value={<span style={{ color: (s.latencyMs ?? 0) > 300 ? "#e0af68" : undefined }}>{node.local ? "local" : `${s.latencyMs ?? "—"} ms`}</span>}
            />
            <VitalRow
              label="Health"
              sub={`${m.failedUnits.length} failed units · ${m.disks.filter((d) => d.used / d.size > 0.85).length} full disks · ${m.rebootRequired ? "reboot pending" : "kernel current"}`}
              value={
                m.failedUnits.length ? (
                  <span className="text-red">{m.failedUnits.length} failed</span>
                ) : m.rebootRequired ? (
                  <span className="text-yellow">reboot pending</span>
                ) : (
                  <span className="text-green">ok</span>
                )
              }
            />
          </div>
        </Panel>
        <Panel title="System" icon={Info}>
          <dl className="space-y-2.5 text-[12.5px]">
            {[
              ["Hostname", m.hostname],
              ["OS", m.osName],
              ["Kernel", m.kernel],
              ["Arch", m.arch],
              ["CPU", m.cpuModel.replace(/\s+/g, " ").replace(/\(R\)|\(TM\)|CPU /g, "")],
              ["Processes", String(m.procs)],
              ["Updater", updaterLabel(node.updateOs, m.pkg) ?? "OS unknown"],
              ["Addresses", m.addrs.map((x) => `${x.addr}  ${x.iface}`).join("\n")],
            ].map(([k, v]) => (
              <div key={k} className="flex gap-3">
                <dt className="w-[76px] shrink-0 text-fg-3">{k}</dt>
                <dd className="min-w-0 flex-1 font-mono text-[12px] break-words whitespace-pre-line text-fg-2">{v || "—"}</dd>
              </div>
            ))}
          </dl>
        </Panel>
        <FleetInfo node={node} />
        <AgentPanel node={node} />
      </div>
    </div>
  );
}

/** Indexed hardware and the operator's notes; shown whether or not the machine is online. */
function FleetInfo({ node }: { node: FleetNode }) {
  const actions = useActions();
  const fleet = useFleet();
  const [busy, setBusy] = useState(false);
  const reindex = async () => {
    setBusy(true);
    try {
      const n = await api<FleetNode>("POST", `/api/machines/${encodeURIComponent(node.id)}/index`);
      fleet.refresh();
      if (n.indexError) toast.error(`Couldn't index ${node.id}`, { description: `${explainError(n.indexError)}\n${n.indexError}` });
      else toast.success(`Indexed ${node.id}`, { description: n.model || undefined });
    } catch (err) {
      toast.error("Couldn't index it", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const hw = node.hardware;
  return (
    <>
      <Panel
        title="Hardware"
        icon={Cpu}
        right={
          <span className="flex items-center gap-1.5 text-[11px] text-fg-4">
            {busy ? "indexing…" : node.indexedAt ? <Tooltip content={new Date(node.indexedAt).toLocaleString()}><span>indexed {ago(node.indexedAt)}</span></Tooltip> : node.imported.length ? "from fleet.toml" : "not indexed"}
            <IconButton icon={busy ? RefreshCw : ScanSearch} label="Re-index now" size={24} onClick={reindex} disabled={busy || (node.unreachable && !fleet.agents[node.id]?.connected)} className={busy ? "animate-spin-slow" : undefined} />
          </span>
        }
      >
        {node.specs.length > 0 ? (
          <dl className="space-y-2.5 text-[12.5px]">
            {node.specs.map((sp) => (
              <div key={sp.label} className="flex gap-3">
                <dt className="w-[76px] shrink-0 text-fg-3">{sp.label}</dt>
                <dd className="min-w-0 flex-1 space-y-1 leading-relaxed break-words text-fg-2">
                  {sp.values.map((v, i) => (
                    <div key={i}>
                      <Md text={v} />
                    </div>
                  ))}
                </dd>
              </div>
            ))}
            {node.mac && (
              <div className="flex gap-3">
                <dt className="w-[76px] shrink-0 text-fg-3">Wake MAC</dt>
                <dd className="min-w-0 flex-1 font-mono text-[12px] text-fg-2">
                  {node.mac} <span className="font-sans text-[11px] text-fg-4">{node.macSource === "detected" ? "detected" : "set by hand"}</span>
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="text-[12.5px] leading-relaxed text-fg-4">
            {node.unreachable ? "Add a host in Edit machine and the panel indexes the hardware over ssh." : "Indexed automatically the next time the panel reaches it."}
          </p>
        )}
        {!hw && node.imported.length > 0 && (
          <p className="mt-3 text-[11.5px] leading-relaxed text-fg-4">Carried over from the old fleet.toml until the first index replaces it.</p>
        )}
        {node.indexError && (
          <p className="mt-3 flex gap-1.5 text-[11.5px] leading-relaxed text-yellow">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>
              Last index failed: {explainError(node.indexError)}. <span className="font-mono text-fg-4">{node.indexError}</span>
            </span>
          </p>
        )}
      </Panel>
      <Panel
        title="Notes"
        icon={FileText}
        right={<IconButton icon={Pencil} label="Edit notes" size={24} onClick={() => actions.editMachine(node.id, "notes")} />}
      >
        {node.notes ? (
          <div className="space-y-2 text-[12.5px] leading-relaxed text-fg-3">
            {node.notes.split(/\n{2,}/).map((para, i) => (
              <p key={i} className="whitespace-pre-line">
                <Md text={para} />
              </p>
            ))}
          </div>
        ) : (
          <button onClick={() => actions.editMachine(node.id, "notes")} className="cursor-pointer text-[12.5px] text-fg-4 hover:text-fg-2">
            No notes yet. Add gotchas, history, how it&apos;s set up…
          </button>
        )}
      </Panel>
    </>
  );
}

/** fleet-agent on this machine: how it reports, and installing, re-keying or removing the agent. */
function AgentPanel({ node }: { node: FleetNode }) {
  const fleet = useFleet();
  const term = useTerminals();
  const { copy, copied } = useCopy();
  const a = fleet.agents[node.id];
  const [cmd, setCmd] = useState<{ command: string; expiresAt: number } | null>(null);
  const [busy, setBusy] = useState(false);

  if (node.local) {
    return (
      <Panel title="Agent" icon={Radio}>
        <p className="text-[12.5px] leading-relaxed text-fg-4">The panel runs on this machine and reads its metrics directly; it needs no agent.</p>
      </Panel>
    );
  }

  const viaSsh = !!node.sshTarget;
  const open = (op: "install" | "token" | "remove") => term.open({ node: node.id, action: "agent", params: { op } });
  const makeCommand = async () => {
    setBusy(true);
    try {
      setCmd(await api<{ command: string; expiresAt: number }>("POST", `/api/agents/${encodeURIComponent(node.id)}/command`));
    } catch (err) {
      toast.error("Couldn't make an install command", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    try {
      await api("DELETE", `/api/agents/${encodeURIComponent(node.id)}`);
      fleet.refresh();
      toast.success(`Revoked ${node.id}'s agent token`, { description: "Uninstall it on the machine itself with ~/.local/bin/fleet-agent uninstall" });
    } catch (err) {
      toast.error("Couldn't revoke the token", { description: (err as Error).message });
    }
  };

  const status = !a?.installed && !a?.connected ? "not installed" : a.connected ? `connected ${ago(a.since)}` : a.since ? `not connected · last seen ${ago(a.since)}` : "never connected";
  const rows: [string, React.ReactNode][] = a?.installed || a?.connected
    ? [
        ["Version", a.version ? <span className="font-mono text-[12px]">{a.version}{a.build && <span className="text-fg-4"> · {a.build.slice(0, 7)}</span>}</span> : "—"],
        ["Arch", a.arch ? <span className="font-mono text-[12px]">{a.arch}</span> : "—"],
      ]
    : [];

  return (
    <Panel
      title="Agent"
      icon={Radio}
      right={<span className={clsx("text-[11px]", a?.connected ? "text-teal" : a?.installed ? "text-yellow" : "text-fg-4")}>{status}</span>}
    >
      {rows.length > 0 && (
        <dl className="mb-3 space-y-2.5 text-[12.5px]">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-3">
              <dt className="w-[76px] shrink-0 text-fg-3">{k}</dt>
              <dd className="min-w-0 flex-1 text-fg-2">{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {a?.outdated && (
        <p className="mb-3 flex gap-1.5 text-[11.5px] leading-relaxed text-yellow">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span>
            {a.updateError ? (
              <>
                Out of date and couldn&apos;t update itself: <span className="font-mono text-fg-4">{a.updateError}</span>. Reinstall to fix it.
              </>
            ) : a.connected ? (
              "Out of date; it updates itself in a moment."
            ) : (
              "Out of date; it updates itself when it next connects."
            )}
          </span>
        </p>
      )}
      <p className="text-[12px] leading-relaxed text-fg-4">
        {a?.installed || a?.connected
          ? a?.connected
            ? "Pushes this machine's metrics to the panel, so the panel doesn't ssh in every few seconds. Terminals, actions and the AI still use ssh."
            : "Not connected: the panel probes over ssh until it's back."
          : "fleet-agent pushes this machine's metrics to the panel instead of the panel polling it over ssh. Report-only: it accepts no commands and listens on no port."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {viaSsh && (
          <Button size="sm" variant="secondary" icon={Radio} onClick={() => open("install")}>
            {a?.installed ? "Reinstall" : "Install agent"}
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={TerminalSquare} loading={busy} onClick={makeCommand}>
          Install command
        </Button>
        {a?.installed && (
          <Menu
            items={[
              ...(viaSsh ? [{ label: "New token", icon: RotateCw, tone: "warning" as const, hint: "Cuts off the old one", onSelect: () => open("token") }] : []),
              viaSsh
                ? { label: "Remove agent", icon: X, tone: "danger" as const, hint: "Stops it and deletes it there", onSelect: () => open("remove") }
                : { label: "Revoke token", icon: X, tone: "danger" as const, hint: "It can no longer report", onSelect: revoke },
            ]}
            trigger={(p) => <IconButton {...p} icon={MoreHorizontal} label="More agent actions" size={30} />}
          />
        )}
      </div>
      {cmd && (
        <div className="mt-3 rounded-lg border border-line-2 bg-void/50 p-2.5">
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 font-mono text-[11.5px] break-all text-fg-2">{cmd.command}</code>
            <IconButton icon={copied === cmd.command ? Check : Copy} label="Copy" size={24} onClick={() => copy(cmd.command)} />
          </div>
          <p className="mt-1.5 text-[11px] text-fg-4">Run it on {node.id} as the user the agent should run as. Works once, until {new Date(cmd.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>
        </div>
      )}
    </Panel>
  );
}

/* ---------------- details (services + processes) ---------------- */

function useDetails(node: FleetNode, intervalMs: number, paused = false) {
  const [data, setData] = useState<NodeDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/nodes/${node.id}/details`, { cache: "no-store" });
      if (res.ok) {
        setData(await res.json());
        setAt(Date.now());
      }
    } finally {
      setLoading(false);
    }
  }, [node.id]);
  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(() => {
      if (!document.hidden && !pausedRef.current) load();
    }, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load, intervalMs]);
  return { data, loading, at, reload: load };
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <th className={clsx("h-9 px-3 text-left text-[11px] font-medium tracking-wide whitespace-nowrap text-fg-4 uppercase", className)}>{children}</th>;
}

function lanIp(node: FleetNode) {
  return node.ips.find((i) => /^(192\.168|10\.|172\.)/.test(i.value))?.value ?? node.ips[0]?.value;
}

/** "0.0.0.0:4433->4433/tcp, [::]:4433->4433/tcp" → [{ port: 4433, pub: true }] */
function parsePorts(ports: string) {
  const out = new Map<number, boolean>();
  for (const m of ports.matchAll(/([\d.:[\]]+):(\d+)->\d+\/tcp/g)) {
    const pub = !/^127\.|^\[::1\]/.test(m[1]);
    out.set(Number(m[2]), (out.get(Number(m[2])) ?? false) || pub);
  }
  return [...out.entries()].map(([port, pub]) => ({ port, pub }));
}

function ServicesTab({ node }: { node: FleetNode }) {
  const { data, reload } = useDetails(node, 15_000);
  const term = useTerminals();
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<"all" | "system" | "user">("all");
  const ip = lanIp(node);

  const units = useMemo(() => {
    const list = (data?.units ?? []).filter(
      (u) => (scope === "all" || u.scope === scope) && (!q || `${u.unit} ${u.description}`.toLowerCase().includes(q.toLowerCase())),
    );
    return list.sort((a, b) => Number(b.active === "failed") - Number(a.active === "failed") || a.unit.localeCompare(b.unit));
  }, [data, q, scope]);

  const unitAction = (u: UnitRow, op: string) => term.open({ node: node.id, action: "unit", params: { unit: u.unit, scope: u.scope, op } });
  const unitLogs = (u: UnitRow) => term.open({ node: node.id, action: "logs", params: { unit: u.unit, scope: u.scope } });

  return (
    <div className="space-y-4">
      <Panel title="Containers" icon={Container} flush right={data?.dockerAccess === "sudo" ? <span className="text-[11px] text-fg-4">via sudo</span> : null}>
        {!data ? (
          <div className="space-y-2 p-4">
            <div className="skeleton h-8 rounded" />
            <div className="skeleton h-8 rounded opacity-60" />
          </div>
        ) : data.dockerAccess === "none" ? (
          <Empty icon={Container} title="Docker isn't installed" />
        ) : data.dockerAccess === "denied" ? (
          <Empty icon={Container} title="Can't reach the Docker daemon" hint="The ssh user isn't in the docker group and passwordless sudo isn't available — or the daemon is stopped." />
        ) : data.containers.length === 0 ? (
          <Empty icon={Container} title="No containers" />
        ) : (
          <>
          <div className="divide-y divide-line/60 md:hidden">
            {data.containers.map((c) => {
              const up = c.state === "running";
              const health = c.status.match(/\((healthy|unhealthy|health: starting)\)/)?.[1];
              return (
                <div key={c.id} className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[14px] font-medium text-fg">{c.name}</span>
                    <Badge tone={up ? "green" : c.state === "exited" ? "red" : "yellow"}>{c.state}</Badge>
                    {health && <Badge tone={health === "healthy" ? "teal" : health === "unhealthy" ? "red" : "yellow"}>{health.replace("health: ", "")}</Badge>}
                  </div>
                  <div className="mt-0.5 truncate font-mono text-[11.5px] text-fg-4">{c.image}</div>
                  <div className="mt-2 flex items-center gap-1.5">
                    {parsePorts(c.ports).map((p) =>
                      p.pub && ip ? (
                        <a key={p.port} href={`http://${ip}:${p.port}`} target="_blank" rel="noopener noreferrer" className="inline-flex h-7 items-center gap-1 rounded-md bg-blue/10 px-2 font-mono text-[12px] text-blue">
                          :{p.port} <ExternalLink size={11} />
                        </a>
                      ) : (
                        <span key={p.port} className="inline-flex h-7 items-center rounded-md bg-hl/70 px-2 font-mono text-[12px] text-fg-3">
                          :{p.port}
                        </span>
                      ),
                    )}
                    <div className="ml-auto flex gap-1">
                      {up ? (
                        <>
                          <IconButton icon={RotateCw} label={`Restart ${c.name}`} onClick={() => term.open({ node: node.id, action: "container", params: { name: c.name, op: "restart" } })} />
                          <IconButton icon={Square} label={`Stop ${c.name}`} tone="danger" onClick={() => term.open({ node: node.id, action: "container", params: { name: c.name, op: "stop" } })} />
                        </>
                      ) : (
                        <IconButton icon={Play} label={`Start ${c.name}`} onClick={() => term.open({ node: node.id, action: "container", params: { name: c.name, op: "start" } })} />
                      )}
                      <IconButton icon={ScrollText} label="Follow logs" onClick={() => term.open({ node: node.id, action: "logs", params: { container: c.name } })} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="overflow-x-auto max-md:hidden">
            <table className="w-full text-[12.5px]">
              <thead className="border-b border-line">
                <tr>
                  <Th className="pl-4">Container</Th>
                  <Th>State</Th>
                  <Th>Ports</Th>
                  <Th>Image</Th>
                  <Th className="pr-4 text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {data.containers.map((c) => {
                  const up = c.state === "running";
                  const health = c.status.match(/\((healthy|unhealthy|health: starting)\)/)?.[1];
                  const ports = parsePorts(c.ports);
                  return (
                    <tr key={c.id} className="border-b border-line/60 last:border-0 hover:bg-hl/25">
                      <td className="py-2 pr-3 pl-4 font-mono font-medium whitespace-nowrap text-fg">{c.name}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="flex items-center gap-1.5">
                          <Badge tone={up ? "green" : c.state === "exited" ? "red" : "yellow"}>{c.state}</Badge>
                          {health && <Badge tone={health === "healthy" ? "teal" : health === "unhealthy" ? "red" : "yellow"}>{health.replace("health: ", "")}</Badge>}
                          <span className="text-[11px] text-fg-4">{c.status.replace(/\s*\(.*\)/, "")}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <div className="flex gap-1">
                          {ports.map((p) =>
                            p.pub && ip ? (
                              <a
                                key={p.port}
                                href={`http://${ip}:${p.port}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex h-5 items-center gap-1 rounded bg-blue/10 px-1.5 font-mono text-[11px] text-blue hover:bg-blue/20"
                              >
                                :{p.port}
                                <ExternalLink size={10} />
                              </a>
                            ) : (
                              <span key={p.port} className="inline-flex h-5 items-center rounded bg-hl/70 px-1.5 font-mono text-[11px] text-fg-3">
                                :{p.port}
                              </span>
                            ),
                          )}
                          {ports.length === 0 && <span className="text-fg-5">—</span>}
                        </div>
                      </td>
                      <td className="w-full max-w-0 truncate px-3 py-2 font-mono text-[11.5px] text-fg-4" title={c.image}>
                        {c.image}
                      </td>
                      <td className="py-1.5 pr-3 pl-3">
                        <div className="flex justify-end gap-0.5">
                          {up ? (
                            <>
                              <IconButton icon={RotateCw} label={`Restart ${c.name}`} onClick={() => term.open({ node: node.id, action: "container", params: { name: c.name, op: "restart" } })} />
                              <IconButton icon={Square} label={`Stop ${c.name}`} tone="danger" onClick={() => term.open({ node: node.id, action: "container", params: { name: c.name, op: "stop" } })} />
                            </>
                          ) : (
                            <IconButton icon={Play} label={`Start ${c.name}`} onClick={() => term.open({ node: node.id, action: "container", params: { name: c.name, op: "start" } })} />
                          )}
                          <IconButton icon={ScrollText} label="Follow logs" onClick={() => term.open({ node: node.id, action: "logs", params: { container: c.name } })} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Panel>

      <Panel
        title={
          data && data.units.some((u) => u.active === "failed")
            ? `systemd services · ${data.units.filter((u) => u.active === "failed").length} failed`
            : "systemd services"
        }
        icon={ListTree}
        flush
        right={
          <div className="flex items-center gap-2">
            <div className="flex rounded-md bg-void/60 p-0.5 ring-1 ring-line-2">
              {(["all", "system", "user"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setScope(s)}
                  className={clsx("h-6 cursor-pointer rounded px-2 text-[11.5px] capitalize", scope === s ? "bg-hl text-fg" : "text-fg-4 hover:text-fg-2")}
                >
                  {s}
                </button>
              ))}
            </div>
            <SearchBox value={q} onChange={setQ} placeholder="Filter units…" />
            <IconButton icon={RefreshCw} label="Refresh" onClick={reload} />
          </div>
        }
      >
        {!data ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="skeleton h-7 rounded" style={{ opacity: 1 - i * 0.2 }} />
            ))}
          </div>
        ) : units.length === 0 ? (
          <Empty icon={ListTree} title={q ? `Nothing matches “${q}”` : "No running services"} />
        ) : (
          <>
          <div className="max-h-[560px] divide-y divide-line/50 overflow-auto overscroll-contain md:hidden">
            {units.map((u) => (
              <div key={`${u.scope}:${u.unit}`} className="flex items-center gap-3 py-2.5 pr-2 pl-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-[13px] text-fg">{u.unit.replace(/\.service$/, "")}</span>
                    {u.scope === "user" && <span className="text-[11px] text-magenta">user</span>}
                  </div>
                  <div className="truncate text-[12px] text-fg-4">{u.description}</div>
                </div>
                <Badge tone={u.active === "failed" ? "red" : u.sub === "running" ? "green" : "neutral"}>{u.active === "failed" ? "failed" : u.sub}</Badge>
                <Menu
                  items={[
                    { label: "Restart", icon: RotateCw, onSelect: () => unitAction(u, "restart") },
                    { label: "Follow logs", icon: ScrollText, onSelect: () => unitLogs(u) },
                    { label: "Status", icon: Info, onSelect: () => unitAction(u, "status") },
                    { label: "Stop", icon: Square, tone: "danger", onSelect: () => unitAction(u, "stop"), separatorBefore: true },
                  ]}
                  trigger={(tp) => (
                    <button {...tp} aria-label={`Actions for ${u.unit}`} className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-fg-3 active:bg-hl">
                      <MoreHorizontal size={18} />
                    </button>
                  )}
                />
              </div>
            ))}
          </div>
          <div className="max-h-[560px] overflow-auto max-md:hidden">
            <table className="w-full text-[12.5px]">
              <thead className="sticky top-0 z-10 border-b border-line bg-panel">
                <tr>
                  <Th className="pl-4">Unit</Th>
                  <Th>Scope</Th>
                  <Th>State</Th>
                  <Th>Description</Th>
                  <Th className="pr-4 text-right">Actions</Th>
                </tr>
              </thead>
              <tbody>
                {units.map((u) => (
                  <tr key={`${u.scope}:${u.unit}`} className="group border-b border-line/50 last:border-0 hover:bg-hl/25">
                    <td className="py-1.5 pr-3 pl-4 font-mono text-[12px] whitespace-nowrap text-fg">{u.unit.replace(/\.service$/, "")}</td>
                    <td className="px-3 py-1.5">
                      <span className={clsx("text-[11.5px]", u.scope === "user" ? "text-magenta" : "text-fg-4")}>{u.scope}</span>
                    </td>
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <Badge tone={u.active === "failed" ? "red" : u.sub === "running" ? "green" : "neutral"}>{u.active === "failed" ? "failed" : u.sub}</Badge>
                    </td>
                    <td className="max-w-[420px] truncate px-3 py-1.5 text-fg-3">{u.description}</td>
                    <td className="py-1 pr-3 pl-3">
                      <div className="flex justify-end gap-0.5">
                        <IconButton icon={RotateCw} label={u.scope === "system" ? "Restart (sudo)" : "Restart"} size={26} onClick={() => unitAction(u, "restart")} />
                        <IconButton icon={Square} label="Stop" tone="danger" size={26} onClick={() => unitAction(u, "stop")} />
                        <IconButton icon={Info} label="Status" size={26} onClick={() => unitAction(u, "status")} />
                        <IconButton icon={ScrollText} label="Follow logs" size={26} onClick={() => unitLogs(u)} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Panel>

      {data && data.listening.length > 0 && (
        <Panel title="Listening ports" icon={Network} right={<span className="text-[11px] text-fg-4">teal: reachable from the network · grey: localhost only</span>}>
          <div className="flex flex-wrap gap-1.5">
            {data.listening.map((l) => {
              const local = /^(127\.|::1)/.test(l.addr);
              return (
                <Tooltip key={`${l.proto}${l.addr}${l.port}${l.process}`} content={`${l.proto.toUpperCase()} ${l.addr}:${l.port}`}>
                  <span
                    className={clsx(
                      "inline-flex h-6 items-center gap-1.5 rounded-md border px-2 font-mono text-[11px]",
                      local ? "border-line-2 text-fg-4" : "border-teal/25 bg-teal/[0.05] text-teal",
                    )}
                  >
                    {l.port}
                    <span className={local ? "text-fg-5" : "text-fg-3"}>{l.process || "?"}</span>
                  </span>
                </Tooltip>
              );
            })}
          </div>
        </Panel>
      )}
    </div>
  );
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <Search size={12} className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-fg-4" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-7 w-44 rounded-md border border-line-2 bg-void/60 pr-6 pl-6.5 text-[12px] text-fg transition-colors placeholder:text-fg-5 focus:border-blue/50 pointer-coarse:h-9 max-sm:w-36"
      />
      {value && (
        <button onClick={() => onChange("")} className="absolute top-1/2 right-1.5 -translate-y-1/2 cursor-pointer text-fg-4 hover:text-fg" aria-label="Clear filter">
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function splitCommand(cmd: string): { prog: string; args: string } {
  const [first, ...rest] = cmd.split(" ");
  const prog = first.split("/").pop() || first;
  return { prog, args: rest.join(" ") };
}

type SortKey = "cpu" | "mem";

function SortTh({ k, sort, setSort, children, className }: { k: SortKey; sort: SortKey; setSort: (k: SortKey) => void; children: React.ReactNode; className?: string }) {
  return (
    <th className={clsx("h-9 px-3 text-left", className)}>
      <button
        onClick={() => setSort(k)}
        className={clsx("inline-flex cursor-pointer items-center gap-1 text-[11px] font-medium tracking-wide uppercase", sort === k ? "text-fg" : "text-fg-4 hover:text-fg-2")}
      >
        {children}
        {sort === k && <ArrowDown size={11} />}
      </button>
    </th>
  );
}

function ProcessesTab({ node }: { node: FleetNode }) {
  // Rows re-sort on every refresh; hold still while the pointer is on the table so you never act on a row that just moved.
  const [hovering, setHovering] = useState(false);
  const { data, at, reload, loading } = useDetails(node, 5000, hovering);
  const term = useTerminals();
  const fleet = useFleet();
  const m = fleet.states[node.id]?.metrics;
  const [sort, setSort] = useState<SortKey>("cpu");
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const kill = (p: ProcessRow, signal: string) => term.open({ node: node.id, action: "kill", params: { pid: String(p.pid), signal } });

  const rows = useMemo(() => {
    const list = (data?.processes ?? []).filter(
      (p) => !p.command.startsWith("[") && (!q || `${p.pid} ${p.user} ${p.command}`.toLowerCase().includes(q.toLowerCase())),
    );
    return list.sort((a, b) => (sort === "cpu" ? b.cpu - a.cpu : b.rss - a.rss));
  }, [data, q, sort]);
  // Bars are relative to the busiest row so small numbers still read.
  const maxCpu = Math.max(1, ...rows.map((r) => r.cpu));
  const maxRss = Math.max(1, ...rows.map((r) => r.rss));

  return (
    <Panel
      title="Processes"
      icon={ListTree}
      flush
      phoneHeader={false}
      right={
        <div className="flex items-center gap-2">
          <span className="hidden items-center gap-1.5 text-[11px] text-fg-4 sm:flex">
            {hovering ? (
              <>
                <span className="size-1.5 rounded-full bg-yellow" /> paused while you point at the list
              </>
            ) : at ? (
              `refreshes every 5s · ${ago(at)}`
            ) : (
              ""
            )}
          </span>
          {loading && <Spinner size={12} className="text-fg-4" />}
          <SearchBox value={q} onChange={setQ} placeholder="Filter processes…" />
          <Button
            size="sm"
            variant="subtle"
            icon={TerminalSquare}
            onClick={() => term.open({ node: node.id, action: "exec", params: { cmd: "htop || top", title: "htop" } })}
          >
            htop
          </Button>
          <IconButton icon={RefreshCw} label="Refresh" onClick={reload} />
        </div>
      }
    >
      {!data ? (
        <div className="space-y-2 p-4">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton h-7 rounded" style={{ opacity: 1 - i * 0.13 }} />
          ))}
        </div>
      ) : data.error ? (
        <Empty icon={AlertTriangle} title="Couldn't load processes" hint={data.error} />
      ) : (
        <>
        <div className="space-y-2.5 border-b border-line p-3 md:hidden">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-4" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter"
                className="h-11 w-full rounded-xl border border-line-2 bg-void/60 pr-3 pl-10 text-fg placeholder:text-fg-5 focus:border-blue/50"
              />
            </div>
            <button
              onClick={() => term.open({ node: node.id, action: "exec", params: { cmd: "htop || top", title: "htop" } })}
              className="flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-hl/70 px-3.5 text-[14px] font-medium text-fg-2 active:bg-line-3"
            >
              <Gauge size={16} /> htop
            </button>
          </div>
          <div className="grid grid-cols-2 rounded-xl bg-void/60 p-1 ring-1 ring-line-2">
            {(["cpu", "mem"] as const).map((k) => (
              <button
                key={k}
                onClick={() => setSort(k)}
                className={clsx("h-8 cursor-pointer rounded-lg text-[13px] font-medium", sort === k ? "bg-hl text-fg" : "text-fg-4")}
              >
                {k === "cpu" ? "CPU" : "Memory"}
              </button>
            ))}
          </div>
        </div>
        <div className="divide-y divide-line/50 md:hidden">
          {(showAll ? rows : rows.slice(0, 25)).map((p) => {
            const { prog, args } = splitCommand(p.command);
            return (
              <div key={p.pid} className="flex items-center gap-3 py-2.5 pr-2 pl-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate font-mono text-[13.5px] font-semibold text-fg">{prog}</span>
                    <span className="shrink-0 font-mono text-[11px] text-fg-4">
                      {p.pid} · {p.user}
                    </span>
                  </div>
                  {args && <div className="truncate font-mono text-[11.5px] text-fg-4">{args}</div>}
                </div>
                <div className="w-[68px] shrink-0 text-right font-mono text-[12px] leading-tight tabular">
                  <div className={sort === "cpu" ? "text-fg" : "text-fg-3"}>{p.cpu.toFixed(1)}%</div>
                  <div className={sort === "mem" ? "text-fg" : "text-fg-3"}>{bytes(p.rss, 0)}</div>
                </div>
                <Menu
                  items={[
                    { label: `Terminate ${prog}`, hint: "SIGTERM", icon: X, onSelect: () => kill(p, "TERM"), tone: "warning" },
                    { label: `Kill ${prog}`, hint: "SIGKILL", icon: Skull, onSelect: () => kill(p, "KILL"), tone: "danger" },
                  ]}
                  trigger={(tp) => (
                    <button {...tp} aria-label={`Actions for process ${p.pid}`} className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-full text-fg-3 active:bg-hl">
                      <MoreHorizontal size={18} />
                    </button>
                  )}
                />
              </div>
            );
          })}
        </div>
        <div className="overflow-x-auto max-md:hidden" onPointerEnter={() => setHovering(true)} onPointerLeave={() => setHovering(false)}>
          <table className="w-full table-fixed text-[12.5px]">
            <thead className="border-b border-line bg-panel">
              <tr>
                <Th className="w-[84px] pl-4">PID</Th>
                <Th className="w-[104px]">User</Th>
                <SortTh k="cpu" sort={sort} setSort={setSort} className="w-[150px]">
                  CPU
                </SortTh>
                <SortTh k="mem" sort={sort} setSort={setSort} className="w-[170px]">
                  Memory
                </SortTh>
                <Th className="w-auto">Command</Th>
                <Th className="w-[52px] pr-4" />
              </tr>
            </thead>
            <tbody>
              {(showAll ? rows : rows.slice(0, 25)).map((p) => {
                const { prog, args } = splitCommand(p.command);
                return (
                  <tr key={p.pid} className="group border-b border-line/50 last:border-0 hover:bg-hl/25">
                    <td className="py-1.5 pr-3 pl-4 font-mono text-[12px] text-fg-4 tabular">{p.pid}</td>
                    <td className="truncate px-3 py-1.5 font-mono text-[12px] text-fg-3">{p.user}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2.5">
                        <span className="w-12 shrink-0 text-right font-mono text-[12px] whitespace-nowrap text-fg tabular">{p.cpu.toFixed(1)}%</span>
                        <Meter value={(p.cpu / maxCpu) * 100} height={4} color="#7aa2f7" className="w-14" />
                      </div>
                    </td>
                    <td className="px-3 py-1.5">
                      <Tooltip content={`${p.mem.toFixed(1)}% of ${bytes(m?.memTotal ?? 0, 0)}`}>
                        <div className="flex items-center gap-2.5">
                          <span className="w-[68px] shrink-0 text-right font-mono text-[12px] whitespace-nowrap text-fg-2 tabular">
                            {bytes(p.rss, p.rss > 1024 ** 3 ? 1 : 0)}
                          </span>
                          <Meter value={(p.rss / maxRss) * 100} height={4} color="#bb9af7" className="w-14" />
                        </div>
                      </Tooltip>
                    </td>
                    <td className="truncate px-3 py-1.5 font-mono text-[11.5px]" title={p.command}>
                      <span className="font-semibold text-fg">{prog}</span> <span className="text-fg-4">{args}</span>
                    </td>
                    <td className="py-1 pr-3">
                      <div className="flex justify-end">
                        <Menu
                          items={[
                            { label: `Terminate ${prog} (${p.pid})`, hint: "SIGTERM", icon: X, onSelect: () => kill(p, "TERM"), tone: "warning" },
                            { label: `Kill ${prog} (${p.pid})`, hint: "SIGKILL", icon: Skull, onSelect: () => kill(p, "KILL"), tone: "danger" },
                          ]}
                          trigger={(tp) => (
                            <button
                              {...tp}
                              aria-label={`Actions for process ${p.pid}`}
                              className={clsx(
                                "grid size-6 cursor-pointer place-items-center rounded-md text-fg-4 transition group-hover:text-fg hover:bg-hover",
                                tp["aria-expanded"] && "bg-hover text-fg",
                              )}
                            >
                              <MoreHorizontal size={15} />
                            </button>
                          )}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && <Empty icon={Search} title={`No process matches “${q}”`} />}
          {rows.length > 25 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="w-full cursor-pointer border-t border-line py-2.5 text-[12px] text-fg-3 hover:bg-hl/25 hover:text-fg"
            >
              {showAll ? "Show top 25" : `Show all ${rows.length} processes`}
            </button>
          )}
        </div>
        {rows.length > 25 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="w-full cursor-pointer border-t border-line py-3 text-[13px] text-blue md:hidden"
          >
            {showAll ? "Show top 25" : `Show all ${rows.length} processes`}
          </button>
        )}
        </>
      )}
    </Panel>
  );
}

function UpdatesTab({ node }: { node: FleetNode }) {
  const fleet = useFleet();
  const actions = useActions();
  const info = fleet.updates[node.id];
  const loading = !!fleet.updatesLoading[node.id] || (!info && !!fleet.updatesLoading.__all);
  const m = fleet.states[node.id]?.metrics;
  const online = fleet.displayStatus(node.id) === "online";
  const count = info?.count ?? 0;

  return (
    <Panel title="Updates" icon={CloudDownload} right={info && <span className="text-[11px] text-fg-4">checked {ago(info.checkedAt)}</span>}>
      <div className="flex flex-wrap items-center gap-5">
        <div className="flex items-center gap-3.5">
          <div
            className={clsx(
              "grid size-11 place-items-center rounded-xl ring-1 ring-inset",
              !info ? "bg-hl/50 text-fg-4 ring-line-2" : count > 0 ? "bg-blue/10 text-blue ring-blue/25" : "bg-green/10 text-green ring-green/25",
            )}
          >
            {!info ? <Spinner size={18} /> : count > 0 ? <ArrowUp size={20} /> : <Check size={20} />}
          </div>
          <div>
            <div className="text-[15px] font-semibold text-fg">
              {!info ? "Checking for updates…" : info.error ? "Couldn't check" : count > 0 ? `${count} package${count === 1 ? "" : "s"} can be upgraded` : "Up to date"}
            </div>
            <div className="mt-0.5 text-[12px] text-fg-4">
              Updater <span className="font-mono text-fg-3">{updaterLabel(node.updateOs, m?.pkg) ?? "unknown OS (Update will ask)"}</span>
              {m?.rebootRequired && <span className="text-yellow"> · reboot pending from a previous update</span>}
            </div>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {count > 0 ? (
            <>
              <Button variant="ghost" icon={RefreshCw} loading={loading} onClick={() => fleet.refreshUpdates(node.id, true)}>
                Re-check
              </Button>
              <Button variant="primary" icon={Play} disabled={!online} onClick={() => actions.update(node.id)}>
                Install {count} update{count === 1 ? "" : "s"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" icon={Play} disabled={!online} onClick={() => actions.update(node.id)}>
                {node.updateScript ? "Run update" : "Run updater anyway"}
              </Button>
              <Button variant="secondary" icon={RefreshCw} loading={loading} onClick={() => fleet.refreshUpdates(node.id, true)}>
                Check now
              </Button>
            </>
          )}
        </div>
      </div>
      {info?.error && (
        <div className="mt-4">
          <Empty icon={AlertTriangle} title="The update check failed" hint={info.error} />
        </div>
      )}
      {count > 0 && (
        <div className="mt-4">
          <PackageList info={info} loading={loading} max={1000} />
        </div>
      )}
      <div className="mt-2">
        <UpdateScriptCard node={node} onEdit={() => actions.editMachine(node.id, "update")} />
      </div>
    </Panel>
  );
}
