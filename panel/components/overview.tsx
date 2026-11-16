"use client";

import clsx from "clsx";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Clock,
  CloudDownload,
  Copy,
  Cpu,
  Gauge,
  HardDrive,
  MemoryStick,
  MoreHorizontal,
  Plus,
  Power,
  RefreshCw,
  RotateCw,
  Server,
  SquareTerminal,
  TerminalSquare,
  Thermometer,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ago, bytes, clockTime, duration, explainError, pct, rate } from "@/lib/format";
import type { FleetNode } from "@/lib/types";
import { useActions } from "./actions";
import { Sparkline } from "./charts";
import { useFleet } from "./fleet-provider";
import { NodeIcon } from "./node-icon";
import { ACCENT, Badge, Button, Menu, Meter, Spinner, StatusDot, Tooltip, usageColor, useCopy } from "./ui";

/** The machine's model (indexed), or its type ("Raspberry pi") before the first index. */
export function modelOf(node: FleetNode): string {
  const m = node.model || node.kind.replace("-", " ");
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/** "Raspberry Pi 5 Model B, 8 GB" → "Raspberry Pi 5 Model B"; "Lenovo ThinkPad X1 Carbon 6th gen, 20KH" → "ThinkPad X1 Carbon 6th gen" */
export function shortModel(node: FleetNode): string {
  return modelOf(node).split(",")[0].replace(/^(Lenovo|Dell|HP|Apple|ASUS|Acer)\s+/i, "");
}

export function osOf(node: FleetNode, osName?: string): string {
  return (osName || node.os).split(/[,(]/)[0].trim();
}

export function LocalBadge() {
  return (
    <Tooltip content="The control panel runs on this machine">
      <span className="relative z-10 inline-flex h-[18px] items-center rounded-full bg-cyan/10 px-1.5 text-[10px] font-semibold tracking-[0.04em] text-cyan ring-1 ring-cyan/20 ring-inset">
        this machine
      </span>
    </Tooltip>
  );
}

/** How a machine reports: through its fleet-agent, or probed over ssh. Hidden while it's unreachable. */
export function ReportingBadge({ node }: { node: FleetNode }) {
  const fleet = useFleet();
  const s = fleet.states[node.id];
  const a = fleet.agents[node.id];
  if (node.local || s?.status !== "online") return null;
  if (a?.connected && s.via === "agent") {
    const tip = [
      `Reports through fleet-agent ${a.version ?? ""}${a.build ? ` (build ${a.build.slice(0, 7)})` : ""}, connected ${ago(a.since)}`,
      a.outdated ? (a.updateError ? `Out of date and couldn't update itself: ${a.updateError}` : "Out of date: updating itself") : null,
    ]
      .filter(Boolean)
      .join("\n");
    return (
      <Tooltip content={<span className="whitespace-pre-line">{tip}</span>}>
        <span
          className={clsx(
            "relative z-10 inline-flex h-[18px] items-center gap-1 rounded-full px-1.5 text-[10px] font-semibold tracking-[0.04em] ring-1 ring-inset",
            a.outdated && a.updateError ? "bg-yellow/10 text-yellow ring-yellow/20" : "bg-teal/10 text-teal ring-teal/20",
          )}
        >
          agent{a.version ? <span className="font-mono font-normal opacity-80">{a.version}</span> : null}
        </span>
      </Tooltip>
    );
  }
  const tip = a?.installed
    ? a.since
      ? `Agent not connected for ${ago(a.since).replace(/ ago$/, "")}, probing over ssh`
      : "Agent installed but never connected, probing over ssh"
    : "No agent installed, probing over ssh";
  return (
    <Tooltip content={tip}>
      <span className={clsx("relative z-10 inline-flex h-[18px] items-center rounded-full px-1.5 text-[10px] font-semibold tracking-[0.04em] ring-1 ring-inset", a?.installed ? "bg-yellow/10 text-yellow ring-yellow/20" : "bg-hl/50 text-fg-3 ring-line-2")}>
        ssh
      </span>
    </Tooltip>
  );
}

function latencyColor(ms: number | null) {
  if (ms == null) return undefined;
  return ms > 600 ? "#f7768e" : ms > 300 ? "#e0af68" : undefined;
}

export function Overview() {
  const fleet = useFleet();
  const actions = useActions();
  const pending = Object.values(fleet.updates).reduce((a, u) => a + (u?.count ?? 0), 0);
  const online = fleet.nodes.filter((n) => fleet.states[n.id]?.status === "online");
  const isDown = (n: FleetNode) => ["offline", "powered-off"].includes(fleet.displayStatus(n.id));
  const cards = fleet.nodes.filter((n) => !isDown(n));
  const down = fleet.nodes.filter(isDown);

  return (
    <div className="mx-auto max-w-[1440px] px-4 pt-5 pb-8 sm:px-6 sm:py-7 lg:px-8">
      <MobileSummary />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 max-sm:hidden">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-fg sm:text-[22px]">Overview</h1>
          <p className="mt-1 text-[13px] text-fg-4">
            {fleet.loaded ? (
              <>
                {fleet.nodes.length} machine{fleet.nodes.length === 1 ? "" : "s"}
                <span className="text-fg-5"> · </span>
                <span className={online.length === fleet.nodes.length ? "text-green" : "text-fg-3"}>{online.length} online</span>
                {down.length > 0 && (
                  <>
                    <span className="text-fg-5"> · </span>
                    {down.length} unreachable
                  </>
                )}
              </>
            ) : (
              "Connecting to your machines…"
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" icon={Plus} onClick={actions.addMachine}>
            Add machine
          </Button>
          <Button variant="secondary" icon={CloudDownload} onClick={() => actions.update([])}>
            Update machines
            {pending > 0 && <span className="ml-0.5 rounded-full bg-blue/15 px-1.5 text-[11px] font-semibold text-blue tabular">{pending}</span>}
          </Button>
        </div>
      </div>

      {fleet.loaded && fleet.nodes.length === 0 && (
        <div className="card mx-auto mt-10 max-w-xl rounded-2xl px-6 py-10 text-center">
          <div className="mx-auto mb-4 grid size-12 place-items-center rounded-xl bg-blue/10 text-blue ring-1 ring-blue/25">
            <Server size={22} />
          </div>
          <h2 className="text-[16px] font-semibold text-fg">No machines yet</h2>
          <p className="mx-auto mt-1.5 max-w-sm text-[13px] leading-relaxed text-fg-3">
            Add one with its address and ssh user. The panel indexes its hardware, addresses and what runs on it by itself.
          </p>
          <Button variant="primary" icon={Plus} className="mt-5" onClick={actions.addMachine}>
            Add your first machine
          </Button>
        </div>
      )}

      <div className="max-sm:hidden">
        <Kpis />
      </div>

      <div className="mt-5 grid max-sm:mt-0 grid-cols-1 gap-3 sm:mt-6 sm:gap-4 xl:grid-cols-2">
        {!fleet.loaded && [0, 1, 2, 3].map((i) => <div key={i} className="card skeleton h-[268px] rounded-xl opacity-50" />)}
        {cards.map((n, i) => (
          <NodeCard key={n.id} node={n} index={i} />
        ))}
      </div>

      {down.length > 0 && (
        <section id="unreachable" className="mt-8 max-sm:mt-6">
          <div className="mb-3 flex items-center gap-2 max-sm:mb-2">
            <h2 className="text-[11px] font-semibold tracking-[0.09em] text-fg-4 uppercase">Offline</h2>
            <span className="rounded-full bg-red/10 px-1.5 text-[10.5px] font-semibold text-red tabular">{down.length}</span>
          </div>
          <div className="card divide-y divide-line overflow-hidden rounded-xl">
            {down.map((n) => (
              <OfflineRow key={n.id} node={n} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* ---------------- phone summary ---------------- */

function MobileSummary() {
  const fleet = useFleet();
  const actions = useActions();
  const ms = fleet.nodes.map((n) => fleet.states[n.id]?.metrics).filter((m): m is NonNullable<typeof m> => !!m);
  const online = fleet.nodes.filter((n) => fleet.states[n.id]?.status === "online").length;
  const cpuVals = ms.map((m) => m.cpu).filter((v): v is number => v != null);
  const cpu = cpuVals.length ? cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length : null;
  const memUsed = ms.reduce((a, m) => a + m.memUsed, 0);
  const memTotal = ms.reduce((a, m) => a + m.memTotal, 0);
  const withUpdates = fleet.nodes.filter((n) => (fleet.updates[n.id]?.count ?? 0) > 0);
  const pending = withUpdates.reduce((a, n) => a + (fleet.updates[n.id]?.count ?? 0), 0);
  const cells = [
    { label: "online", value: fleet.loaded ? `${online}/${fleet.nodes.length}` : "–", color: online === fleet.nodes.length ? "#9ece6a" : undefined },
    { label: "avg CPU", value: pct(cpu), color: undefined },
    { label: "memory", value: memTotal ? pct((memUsed / memTotal) * 100) : "–", color: undefined },
  ];
  return (
    <div className="mb-3 space-y-2 sm:hidden">
      <div className="card grid grid-cols-3 divide-x divide-line rounded-2xl py-2.5">
        {cells.map((c) => (
          <div key={c.label} className="text-center">
            <div className="figure text-[19px] leading-tight font-semibold text-fg" style={{ color: c.color }}>
              {c.value}
            </div>
            <div className="text-[12px] text-fg-4">{c.label}</div>
          </div>
        ))}
      </div>
      {pending > 0 && (
        <button
          onClick={() => actions.update([])}
          className="flex h-12 w-full cursor-pointer items-center gap-3 rounded-2xl border border-blue/25 bg-blue/[0.07] px-4 text-left active:bg-blue/15"
        >
          <CloudDownload size={18} className="text-blue" />
          <span className="flex-1 text-[14px] text-fg-2">
            <span className="font-semibold text-fg">{pending} update{pending === 1 ? "" : "s"}</span> on {withUpdates.map((n) => n.id).join(", ")}
          </span>
          <span className="text-[14px] font-medium text-blue">Review ›</span>
        </button>
      )}
    </div>
  );
}

/* ---------------- KPIs ---------------- */

function Kpi({
  icon: Icon,
  iconClass,
  label,
  value,
  sub,
  footer,
  onClick,
}: {
  icon: typeof Cpu;
  iconClass: string;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  footer?: React.ReactNode;
  onClick?: () => void;
}) {
  const El = onClick ? "button" : "div";
  return (
    <El
      onClick={onClick}
      className={clsx(
        "card relative flex min-h-[112px] w-[158px] shrink-0 snap-start flex-col overflow-hidden rounded-xl px-4 pt-3.5 pb-3 text-left md:w-auto",
        onClick && "cursor-pointer transition-colors hover:border-line-3",
      )}
    >
      <div className="flex items-center gap-2 text-[11.5px] font-medium text-fg-3">
        <Icon size={13} className={iconClass} />
        {label}
      </div>
      <div className="figure mt-2 text-[26px] leading-none font-semibold text-fg">{value}</div>
      <div className="mt-1.5 truncate text-[11.5px] text-fg-4">{sub}</div>
      {/* every card reserves the same footer slot so the row bottoms line up */}
      {footer && <div className="mt-auto flex h-4 items-end pt-2">{footer}</div>}
    </El>
  );
}

function Kpis() {
  const fleet = useFleet();
  const actions = useActions();
  const router = useRouter();
  const ms = fleet.nodes.map((n) => fleet.states[n.id]?.metrics).filter((m): m is NonNullable<typeof m> => !!m);
  const online = fleet.nodes.filter((n) => fleet.states[n.id]?.status === "online").length;
  const scope = online === fleet.nodes.length ? "all machines" : `${online} online`;

  const cpuVals = ms.map((m) => m.cpu).filter((v): v is number => v != null);
  const avgCpu = cpuVals.length ? cpuVals.reduce((a, b) => a + b, 0) / cpuVals.length : null;
  const memUsed = ms.reduce((a, m) => a + m.memUsed, 0);
  const memTotal = ms.reduce((a, m) => a + m.memTotal, 0);
  const diskUsed = ms.reduce((a, m) => a + m.disks.reduce((x, d) => x + d.used, 0), 0);
  const diskTotal = ms.reduce((a, m) => a + m.disks.reduce((x, d) => x + d.size, 0), 0);
  const cores = ms.reduce((a, m) => a + m.cpus, 0);

  const withUpdates = fleet.nodes.filter((n) => (fleet.updates[n.id]?.count ?? 0) > 0);
  const pending = withUpdates.reduce((a, n) => a + (fleet.updates[n.id]?.count ?? 0), 0);
  const updatesChecked = fleet.nodes.some((n) => fleet.updates[n.id]);

  // Everything that wants a human: unreachable machines, failed units, pending reboots, full disks.
  const issues: { text: string; node: string; tone: "red" | "yellow" }[] = [];
  const unreachable = fleet.nodes.filter((n) => fleet.displayStatus(n.id) === "offline");
  if (unreachable.length) issues.push({ text: `${unreachable.map((n) => n.id).join(", ")} unreachable`, node: unreachable[0].id, tone: "red" });
  for (const n of fleet.nodes) {
    const m = fleet.states[n.id]?.metrics;
    if (m?.failedUnits.length) issues.push({ text: `${n.id}: ${m.failedUnits.length} failed unit${m.failedUnits.length > 1 ? "s" : ""}`, node: n.id, tone: "red" });
    if (m?.rebootRequired) issues.push({ text: `${n.id} needs a reboot`, node: n.id, tone: "yellow" });
    for (const d of m?.disks ?? []) if (d.used / d.size > 0.85) issues.push({ text: `${n.id} ${d.mount} ${pct((d.used / d.size) * 100)} full`, node: n.id, tone: "yellow" });
  }
  const worst = issues.some((i) => i.tone === "red") ? "red" : issues.length ? "yellow" : "green";

  // fleet-wide CPU history: average across machines per sample index
  const len = Math.max(0, ...fleet.nodes.map((n) => fleet.history[n.id]?.length ?? 0));
  const avgHist: (number | null)[] = [];
  for (let i = 0; i < len; i++) {
    const vals = fleet.nodes
      .map((n) => {
        const h = fleet.history[n.id] ?? [];
        return h[h.length - len + i]?.cpu;
      })
      .filter((v): v is number => v != null);
    avgHist.push(vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null);
  }

  return (
    <div className="rail -mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 sm:-mx-6 sm:scroll-px-6 sm:px-6 md:mx-0 md:grid md:grid-cols-3 md:overflow-visible md:px-0 md:pb-0 2xl:grid-cols-6">
      <Kpi
        icon={Server}
        iconClass="text-green"
        label="Machines online"
        value={
          <>
            {online}
            <span className="text-fg-5">/{fleet.nodes.length || "–"}</span>
          </>
        }
        sub={online === fleet.nodes.length ? "everything reachable" : `${fleet.nodes.length - online} unreachable`}
        footer={
          <div className="flex w-full gap-1.5">
            {fleet.nodes.map((n) => {
              const st = fleet.displayStatus(n.id);
              return (
                <Tooltip key={n.id} content={`${n.id} · ${st.replace("-", " ")}`}>
                  <span
                    className={clsx(
                      "h-1 flex-1 rounded-full",
                      st === "online" ? "bg-green/80" : st === "unknown" ? "bg-hl" : st.includes("ing") ? "bg-yellow/80" : "bg-red/80",
                    )}
                  />
                </Tooltip>
              );
            })}
          </div>
        }
      />
      <Kpi
        icon={Cpu}
        iconClass="text-blue"
        label="Average CPU"
        value={pct(avgCpu)}
        sub={`${cores || "–"} cores · ${scope}`}
        footer={
          <div className="-mx-4 -mb-3 h-7 w-[calc(100%+2rem)]">
            <Sparkline values={avgHist} color="#7aa2f7" height={28} width={240} max={Math.max(25 / 1.2, ...avgHist.map((v) => v ?? 0)) * 1.2} />
          </div>
        }
      />
      <Kpi
        icon={MemoryStick}
        iconClass="text-magenta"
        label="Memory"
        value={memTotal ? pct((memUsed / memTotal) * 100) : "—"}
        sub={`${bytes(memUsed)} of ${bytes(memTotal, 0)} · ${scope}`}
        footer={<Meter value={memTotal ? (memUsed / memTotal) * 100 : null} color="#bb9af7" height={4} />}
      />
      <Kpi
        icon={HardDrive}
        iconClass="text-teal"
        label="Storage"
        value={diskTotal ? pct((diskUsed / diskTotal) * 100) : "—"}
        sub={`${bytes(diskUsed, 0)} of ${bytes(diskTotal, 0)} · ${scope}`}
        footer={<Meter value={diskTotal ? (diskUsed / diskTotal) * 100 : null} color="#73daca" height={4} />}
      />
      <Kpi
        icon={CloudDownload}
        iconClass="text-cyan"
        label="Pending updates"
        value={!updatesChecked && fleet.updatesLoading.__all ? <Spinner size={20} className="text-fg-4" /> : pending}
        sub={
          pending > 0
            ? `on ${withUpdates.map((n) => n.id).join(", ")}`
            : updatesChecked
              ? "everything current"
              : "checking…"
        }
        onClick={() => actions.update([])}
        footer={
          pending > 0 ? (
            <span className="text-[11px] font-medium text-blue">Review &amp; update →</span>
          ) : undefined
        }
      />
      <Kpi
        icon={worst === "green" ? CheckCircle2 : AlertTriangle}
        iconClass={worst === "red" ? "text-red" : worst === "yellow" ? "text-yellow" : "text-green"}
        label="Needs attention"
        value={
          <span className={issues.length ? (worst === "red" ? "text-red" : "text-yellow") : undefined}>
            {issues.length + Math.max(0, unreachable.length - 1)}
          </span>
        }
        sub={
          issues.length === 0 ? (
            "all clear"
          ) : (
            <Tooltip content={issues.map((i) => i.text).join(" · ")}>
              <span>{issues.map((i) => i.text).join(" · ")}</span>
            </Tooltip>
          )
        }
        onClick={
          issues.length
            ? () =>
                unreachable.length && issues[0].text.endsWith("unreachable")
                  ? document.getElementById("unreachable")?.scrollIntoView({ behavior: "smooth", block: "center" })
                  : router.push(`/nodes/${issues[0].node}`)
            : undefined
        }
      />
    </div>
  );
}

/* ---------------- node card ---------------- */

function Stat({
  icon: Icon,
  label,
  value,
  sub,
  percent,
  color,
  trend,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  sub: React.ReactNode;
  percent: number | null;
  color?: string;
  trend?: React.ReactNode;
}) {
  return (
    <div className="relative min-w-0 overflow-hidden sm:rounded-lg sm:border sm:border-line sm:bg-void/35 sm:px-3 sm:pt-2.5 sm:pb-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-fg-3">
        <Icon size={12} className="text-fg-4" />
        {label}
      </div>
      {trend && <div className="pointer-events-none absolute top-[30px] right-3 hidden h-5 w-16 border-b border-hl opacity-90 sm:block">{trend}</div>}
      <div className="figure mt-1 text-[18px] leading-none font-semibold text-fg sm:mt-1.5 sm:text-[20px]">{value}</div>
      <div className="mt-1 truncate text-[11px] text-fg-4 tabular max-sm:hidden">{sub}</div>
      <Meter value={percent} color={color} className="mt-2 sm:mt-2.5" height={3} />
    </div>
  );
}

function useTicker(active: boolean) {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

function NodeMenu({ node, online }: { node: FleetNode; online: boolean }) {
  const actions = useActions();
  const router = useRouter();
  const { copy } = useCopy();
  const sshCmd = node.sshCommand;
  return (
    <Menu
      items={[
        { label: "Open details", icon: Gauge, onSelect: () => router.push(`/nodes/${node.id}`) },
        { label: "Run command…", icon: SquareTerminal, onSelect: () => actions.run([node.id]), disabled: !online },
        ...(sshCmd ? [{ label: "Copy ssh command", icon: Copy, onSelect: () => copy(sshCmd) }] : []),
        ...(node.ips[0] ? [{ label: `Copy IP`, hint: node.ips[0].value, icon: Copy, onSelect: () => copy(node.ips[0].value) }] : []),
        {
          label: "Reboot…",
          icon: RotateCw,
          tone: "warning" as const,
          onSelect: () => actions.power(node.id, "reboot"),
          disabled: !online,
          separatorBefore: true,
        },
        { label: "Shut down…", icon: Power, tone: "danger" as const, onSelect: () => actions.power(node.id, "shutdown"), disabled: !online },
      ]}
      trigger={(p) => (
        <button
          {...p}
          aria-label={`More actions for ${node.id}`}
          className={clsx(
            "relative z-10 grid size-7.5 cursor-pointer place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg max-sm:size-11 max-sm:bg-hl/60",
            p["aria-expanded"] && "bg-hover text-fg",
          )}
        >
          <MoreHorizontal size={16} />
        </button>
      )}
    />
  );
}

export function NodeCard({ node, index }: { node: FleetNode; index: number }) {
  const fleet = useFleet();
  const actions = useActions();
  const s = fleet.states[node.id];
  const m = s?.metrics;
  const st = fleet.displayStatus(node.id);
  const accent = fleet.accent(node.id);
  const a = ACCENT[accent];
  const hist = fleet.history[node.id] ?? [];
  const upd = fleet.updates[node.id];
  const online = st === "online" && !!m;
  const transitioning = st === "rebooting" || st === "shutting-down";
  useTicker(!online);

  const root = m?.disks.find((d) => d.mount === "/") ?? m?.disks[0];
  const rootPct = root ? (root.used / root.size) * 100 : null;
  const memPct = m ? (m.memUsed / m.memTotal) * 100 : null;

  return (
    <article
      className="card group/card relative flex animate-fade-up flex-col rounded-xl transition-[border-color,transform] duration-200 hover:border-line-3 max-sm:rounded-2xl max-sm:active:scale-[0.99]"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-24 rounded-t-xl opacity-60 transition-opacity group-hover/card:opacity-100"
        style={{ background: `radial-gradient(60% 100% at 0% 0%, ${a.hex}14, transparent 70%)` }}
      />

      <header className="relative flex items-start gap-3 px-4 pt-4 sm:px-5 sm:pt-4.5">
        <NodeIcon kind={node.kind} accent={accent} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Link
              href={`/nodes/${node.id}`}
              className={clsx(
                "font-mono text-[17px] font-semibold tracking-tight after:absolute after:inset-0 after:rounded-xl after:content-[''] hover:underline hover:decoration-2 hover:underline-offset-4",
                a.text,
              )}
            >
              {node.id}
            </Link>
            {node.local && <LocalBadge />}
            <ReportingBadge node={node} />
          </div>
          <div className="mt-0.5 truncate text-[12px] text-fg-4">
            {shortModel(node)}
            <span className="max-sm:hidden">
              {" "}
              <span className="text-fg-5">·</span> {osOf(node, m?.osName)}
            </span>
          </div>
        </div>
        <StatusPill status={st} latency={s?.latencyMs ?? null} via={s?.via} />
      </header>

      {online && m ? (
        <>
          <div className="relative mt-3.5 grid grid-cols-3 gap-4 px-4 sm:mt-4 sm:gap-2.5 sm:px-5">
            <Stat
              icon={Cpu}
              label="CPU"
              value={pct(m.cpu)}
              sub={
                <>
                  {m.cpus} cores<span className="max-sm:hidden"> · load {m.load[0].toFixed(2)}</span>
                </>
              }
              percent={m.cpu}
              color={usageColor("cpu", m.cpu)}
              trend={<Sparkline values={hist.slice(-30).map((h) => h.cpu)} color="#7aa2f7" height={24} width={64} max={Math.max(25 / 1.2, ...hist.slice(-30).map((h) => h.cpu ?? 0)) * 1.2} />}
            />
            <Stat icon={MemoryStick} label="Memory" value={pct(memPct)} sub={`${bytes(m.memUsed)} / ${bytes(m.memTotal, 0)}`} percent={memPct} color={usageColor("mem", memPct)} />
            <Stat
              icon={HardDrive}
              label={`Disk ${root?.mount ?? ""}`}
              value={pct(rootPct)}
              sub={root ? `${bytes(root.used, 0)} / ${bytes(root.size, 0)}` : "—"}
              percent={rootPct}
              color={usageColor("disk", rootPct)}
            />
          </div>

          <div className="relative mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 text-[11.5px] text-fg-3 sm:px-5">
            <Tooltip content={`Booted ${new Date((s?.checkedAt ?? 0) - m.uptime * 1000).toLocaleString()}`}>
              <span className="relative z-10 flex items-center gap-1.5">
                <Clock size={12} className="text-fg-4" />
                up <span className="text-fg-2 tabular">{duration(m.uptime)}</span>
              </span>
            </Tooltip>
            {m.tempC != null && (
              <span className="flex items-center gap-1.5">
                <Thermometer size={12} className="text-fg-4" />
                <span className="tabular" style={{ color: m.tempC > 80 ? "#f7768e" : m.tempC > 65 ? "#e0af68" : undefined }}>
                  {m.tempC.toFixed(0)}°C
                </span>
              </span>
            )}
            <span className="flex items-center gap-1 tabular">
              <ArrowDown size={12} className="text-teal" />
              {rate(m.rx)}
              <ArrowUp size={12} className="ml-1.5 text-orange" />
              {rate(m.tx)}
            </span>
            <span className="ml-auto flex items-center gap-1.5">
              {m.rebootRequired && (
                <Tooltip content="A newer kernel is installed than the one running">
                  <span className="relative z-10">
                    <Badge tone="yellow" icon={RotateCw}>
                      reboot needed
                    </Badge>
                  </span>
                </Tooltip>
              )}
              {m.failedUnits.length > 0 && (
                <Tooltip content={m.failedUnits.join(", ")}>
                  <span className="relative z-10">
                    <Badge tone="red" icon={AlertTriangle}>
                      {m.failedUnits.length} failed
                    </Badge>
                  </span>
                </Tooltip>
              )}
            </span>
          </div>
        </>
      ) : (
        <div className="relative mx-5 mt-4 flex min-h-[124px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-line-2 bg-void/30 px-4 text-center">
          {transitioning ? (
            <>
              <RotateCw size={18} className="animate-spin-slow text-yellow" />
              <div className="text-[13px] font-medium text-yellow">{st === "rebooting" ? "Rebooting" : "Shutting down"}…</div>
              <div className="text-[11.5px] text-fg-4">
                {s?.status === "offline" ? "Waiting for it to come back" : "Waiting for it to go down"} · last seen {ago(s?.lastSeen)}
              </div>
            </>
          ) : (
            <>
              <Spinner className="text-fg-4" size={18} />
              <div className="text-[12px] text-fg-4">Connecting…</div>
            </>
          )}
        </div>
      )}

      <footer className="relative mt-3.5 flex items-center gap-1.5 border-line px-3.5 py-2.5 max-sm:gap-2 max-sm:px-4 max-sm:pt-1 max-sm:pb-4 sm:mt-4 sm:border-t">
        <Button size="sm" variant="subtle" icon={TerminalSquare} className="relative z-10 max-sm:!h-11 max-sm:flex-1" disabled={!online} onClick={() => actions.shell(node.id)}>
          Shell
        </Button>
        <Button size="sm" variant="ghost" icon={CloudDownload} className="relative z-10 max-sm:!h-11 max-sm:flex-1 max-sm:bg-hl/60" disabled={!online} onClick={() => actions.update(node.id)}>
          Update
          {(upd?.count ?? 0) > 0 && <span className="rounded-full bg-blue/15 px-1.5 text-[10.5px] font-semibold text-blue tabular">{upd!.count}</span>}
        </Button>
        <span className="relative z-10 ml-auto hidden items-center gap-2 pr-1 font-mono text-[11px] text-fg-4 lg:flex">
          {node.local ? "local" : node.sshCommand}
          {s?.latencyMs != null && online && (
            <Tooltip content={s.via === "agent" ? "Round-trip time to the machine's agent" : "Round-trip time of the last metrics probe over ssh"}>
              <span className="tabular" style={{ color: latencyColor(s.latencyMs) }}>
                {s.latencyMs}ms
              </span>
            </Tooltip>
          )}
        </span>
        <NodeMenu node={node} online={online} />
      </footer>
    </article>
  );
}

/* ---------------- offline row ---------------- */

function OfflineRow({ node }: { node: FleetNode }) {
  const fleet = useFleet();
  const { copy, copied } = useCopy();
  const [busy, setBusy] = useState<"retry" | "wake" | null>(null);
  const s = fleet.states[node.id];
  const st = fleet.displayStatus(node.id);
  const accent = fleet.accent(node.id);
  const sshCmd = node.sshCommand;

  const retry = async () => {
    setBusy("retry");
    try {
      await fleet.probe(node.id);
    } finally {
      setBusy(null);
    }
  };
  const wake = async () => {
    setBusy("wake");
    try {
      const res = await fetch(`/api/nodes/${node.id}/wake`, { method: "POST" });
      const body = await res.json();
      if (res.ok) toast.success(`Wake-on-LAN sent to ${node.id}`, { description: "It usually takes 20–60 s to boot." });
      else toast.error("Couldn't send wake packet", { description: body.error });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="group flex flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-2.5 transition-colors hover:bg-hl/20 sm:py-3">
      <NodeIcon kind={node.kind} accent={accent} size={34} dim />
      <div className="min-w-0 flex-1 sm:w-[190px] sm:flex-none">
        <div className="flex items-center gap-2">
          <Link href={`/nodes/${node.id}`} className="font-mono text-[14px] font-semibold text-fg-2 hover:underline">
            {node.id}
          </Link>
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red max-sm:hidden">
            <StatusDot status={st} size={6} />
            {st === "powered-off" ? "Powered off" : "Unreachable"}
          </span>
        </div>
        <div className="truncate text-[11.5px] text-fg-4 max-sm:hidden">{modelOf(node)}</div>
        <div className="truncate text-[12.5px] text-fg-4 sm:hidden">
          <span className="text-red">●</span> {s?.lastSeen ? `Offline since ${clockTime(s.lastSeen).slice(0, 5)}` : "Offline · never reached"}
        </div>
      </div>
      <div className="order-3 w-full min-w-0 max-sm:hidden sm:order-none sm:w-auto sm:flex-1">
        <div className="text-[13px] text-fg-2 sm:text-[12.5px]">{st === "powered-off" ? "Shut down from this panel" : explainError(s?.error)}</div>
        <div className="truncate font-mono text-[11px] text-fg-4">{s?.error}</div>
      </div>
      <div className="order-4 flex-1 text-[11.5px] whitespace-nowrap text-fg-4 max-sm:hidden sm:order-none sm:flex-none sm:text-right">
        {s?.lastSeen ? (
          <Tooltip content={new Date(s.lastSeen).toLocaleString()}>
            <span>last seen {ago(s.lastSeen)}</span>
          </Tooltip>
        ) : (
          <Tooltip content="The panel hasn't reached this machine since it started watching">
            <span>never reached · watching since {fleet.startedAt ? clockTime(fleet.startedAt).slice(0, 5) : "start"}</span>
          </Tooltip>
        )}
      </div>
      <div className="flex items-center gap-1 sm:order-none">
        <Button size="sm" variant="secondary" icon={RefreshCw} loading={busy === "retry"} onClick={retry} aria-label={`Retry ${node.id}`} className="max-sm:!size-11 max-sm:!px-0">
          <span className="max-sm:hidden">Retry</span>
        </Button>
        {node.mac ? (
          <Button size="sm" variant="secondary" icon={Zap} loading={busy === "wake"} onClick={wake}>
            Wake
          </Button>
        ) : (
          <Tooltip content="Wake-on-LAN needs a wired MAC address: it's detected when the machine is indexed, or set it in Edit machine">
            <span className="max-sm:hidden">
              <Button size="sm" variant="ghost" icon={Zap} disabled>
                Wake
              </Button>
            </span>
          </Tooltip>
        )}
        {sshCmd && (
          <Tooltip content={sshCmd}>
            <span className="max-sm:hidden">
              <Button size="sm" variant="ghost" icon={Copy} onClick={() => copy(sshCmd)}>
                <span className="max-sm:hidden">{copied === sshCmd ? "Copied" : "Copy ssh"}</span>
              </Button>
            </span>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

export function StatusPill({ status, latency, via }: { status: string; latency: number | null; via?: string | null }) {
  const label =
    status === "online"
      ? "Online"
      : status === "offline"
        ? "Unreachable"
        : status === "rebooting"
          ? "Rebooting"
          : status === "shutting-down"
            ? "Shutting down"
            : status === "powered-off"
              ? "Powered off"
              : "Checking";
  const tone =
    status === "online"
      ? "border-green/25 bg-green/[0.08] text-green"
      : status === "offline" || status === "powered-off"
        ? "border-red/25 bg-red/[0.08] text-red"
        : status === "unknown"
          ? "border-line-2 bg-hl/40 text-fg-3"
          : "border-yellow/25 bg-yellow/[0.08] text-yellow";
  return (
    <Tooltip content={latency != null && status === "online" ? `${via === "agent" ? "agent" : "ssh"} round-trip ${latency}ms` : label}>
      <span className={clsx("relative z-10 inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-medium", tone)}>
        <StatusDot status={status} size={6} />
        {label}
      </span>
    </Tooltip>
  );
}
