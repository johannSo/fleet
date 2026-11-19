"use client";

import clsx from "clsx";
import { Globe, List, Pencil, RefreshCw, Router as RouterIcon, Waypoints, Zap } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { ago } from "@/lib/format";
import { buildNetworkMap, guestLabel, linkLabel, type NetMember, type Router, type Subnet } from "@/lib/network";
import type { FleetNode } from "@/lib/types";
import { useActions } from "./actions";
import { useFleet } from "./fleet-provider";
import { NodeIcon, kindLabel } from "./node-icon";
import { NodeMenu, wakeMachine } from "./overview";
import { ACCENT, Button, Empty, StatusDot, Tooltip } from "./ui";

/* ---------------- map or list, remembered per browser ---------------- */

type View = "map" | "list";
const VIEW_KEY = "fleet.network.view";
const viewListeners = new Set<() => void>();
let memView: View | null = null;

function readView(): View {
  if (memView) return memView;
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "map";
  } catch {
    return "map";
  }
}

function useView(): [View, (v: View) => void] {
  const view = useSyncExternalStore(
    (cb) => {
      viewListeners.add(cb);
      return () => void viewListeners.delete(cb);
    },
    readView,
    () => "map" as View,
  );
  const set = useCallback((v: View) => {
    memView = v;
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* private window: remembered for this visit only */
    }
    for (const l of viewListeners) l();
  }, []);
  return [view, set];
}

/* ---------------- page ---------------- */

export function NetworkView() {
  const fleet = useFleet();
  const actions = useActions();
  const [view, setView] = useView();
  const map = useMemo(() => buildNetworkMap(fleet.nodes, fleet.networkNames), [fleet.nodes, fleet.networkNames]);
  const placed = fleet.nodes.filter((n) => !map.unplaced.includes(n.id));
  const online = placed.filter((n) => fleet.states[n.id]?.status === "online").length;

  return (
    <div className="mx-auto max-w-[1440px] px-4 pt-5 pb-8 sm:px-6 sm:py-7 lg:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 max-sm:mb-4">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight text-fg max-sm:hidden sm:text-[22px]">Network</h1>
          <p className="mt-1 text-[13px] text-fg-4 max-sm:mt-0">
            {fleet.loaded ? (
              <>
                {map.subnets.length} network{map.subnets.length === 1 ? "" : "s"}
                <span className="text-fg-5"> · </span>
                {placed.length} machine{placed.length === 1 ? "" : "s"}
                <span className="text-fg-5"> · </span>
                <span className={online === placed.length && online > 0 ? "text-green" : "text-fg-3"}>{online} online</span>
              </>
            ) : (
              "Connecting to your machines…"
            )}
          </p>
        </div>
        {map.subnets.length > 0 && <ViewToggle view={view} onChange={setView} />}
      </div>

      {!fleet.loaded && <div className="card skeleton h-[420px] rounded-xl opacity-50" />}

      {fleet.loaded && fleet.nodes.length === 0 && (
        <div className="card mx-auto mt-10 max-w-xl rounded-2xl">
          <Empty
            icon={Waypoints}
            title="No machines yet"
            hint={
              <>
                Add a machine and its networks show up here once it&apos;s indexed.{" "}
                <button onClick={actions.addMachine} className="cursor-pointer text-blue hover:underline">
                  Add machine
                </button>
              </>
            }
          />
        </div>
      )}

      {fleet.loaded && fleet.nodes.length > 0 && map.subnets.length === 0 && (
        <div className="card mx-auto mt-10 max-w-xl rounded-2xl">
          <Empty
            icon={Waypoints}
            title="No networks found yet"
            hint="Networks come from the addresses found when machines are indexed, which happens over ssh the next time each machine is online."
          />
        </div>
      )}

      {map.subnets.length > 0 && (
        <>
          {/* The map needs a wide screen; phones always get the list. */}
          <div className={clsx(view === "map" ? "max-md:hidden" : "hidden")}>
            <NetworkMapView subnets={map.subnets} routers={map.routers} />
          </div>
          <div className={clsx(view === "map" && "md:hidden")}>
            <NetworkList subnets={map.subnets} />
          </div>
        </>
      )}

      {fleet.loaded && map.unplaced.length > 0 && map.subnets.length > 0 && (
        <p className="mt-6 text-[12px] leading-relaxed text-fg-4">
          {map.unplaced.map((id, i) => (
            <span key={id}>
              {i > 0 && ", "}
              <Link href={`/nodes/${id}`} className="font-mono text-fg-3 hover:underline">
                {id}
              </Link>
            </span>
          ))}{" "}
          {map.unplaced.length === 1 ? "has" : "have"} no addresses on record yet. They show up here once indexed, which happens the next time they&apos;re
          online.
        </p>
      )}
    </div>
  );
}

function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const opts: { v: View; label: string; icon: typeof List }[] = [
    { v: "map", label: "Map", icon: Waypoints },
    { v: "list", label: "List", icon: List },
  ];
  return (
    <div role="radiogroup" aria-label="View" className="flex rounded-lg border border-line-2 bg-panel/80 p-0.5 max-md:hidden">
      {opts.map((o) => (
        <button
          key={o.v}
          role="radio"
          aria-checked={view === o.v}
          onClick={() => onChange(o.v)}
          className={clsx(
            "flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-3 text-[12.5px] font-medium transition-colors",
            view === o.v ? "bg-hl text-fg" : "text-fg-4 hover:text-fg-2",
          )}
        >
          <o.icon size={13} />
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------------- naming a subnet ---------------- */

function SubnetName({ subnet, variant }: { subnet: Subnet; variant: "card" | "section" }) {
  const fleet = useFleet();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const custom = fleet.networkNames[subnet.cidr] ?? "";

  const start = () => {
    setDraft(subnet.name ?? "");
    setEditing(true);
  };
  const save = async () => {
    const name = draft.trim();
    if (name === (subnet.name ?? "") || (!name && !custom)) return setEditing(false);
    setSaving(true);
    try {
      const res = await fetch("/api/networks/name", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cidr: subnet.cidr, name }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error("Couldn't save the name", { description: body.error });
        return;
      }
      setEditing(false);
      fleet.refresh();
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        maxLength={40}
        disabled={saving}
        placeholder="Name, e.g. Home"
        aria-label={`Name for ${subnet.cidr}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") setEditing(false);
        }}
        className={clsx(
          "relative z-10 h-6 rounded-md border border-blue/50 bg-void px-1.5 text-fg outline-none",
          variant === "card" ? "w-full text-[12px]" : "w-44 text-[12px]",
        )}
      />
    );
  }

  if (!subnet.name) {
    return (
      <button
        onClick={start}
        className={clsx(
          "relative z-10 inline-flex cursor-pointer items-center gap-1 rounded text-fg-5 hover:text-fg-3",
          variant === "card" ? "text-[12px] italic" : "text-[11.5px]",
        )}
      >
        {variant === "card" ? "Name this network" : "Name"}
        <Pencil size={11} />
      </button>
    );
  }

  return (
    <button
      onClick={start}
      aria-label={`Rename ${subnet.cidr}`}
      className={clsx(
        "group/name relative z-10 inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded hover:text-fg-2",
        variant === "card" ? "text-[12px] text-fg-3" : "text-[11px] font-semibold tracking-[0.09em] text-fg-3 uppercase",
      )}
    >
      <span className="truncate">{subnet.name}</span>
      <Pencil size={11} className="shrink-0 text-fg-5 opacity-60 transition-opacity group-hover/name:opacity-100" />
    </button>
  );
}

/* ---------------- shared bits ---------------- */

const isDown = (st: string) => st === "offline" || st === "powered-off";

function useRecover(node: FleetNode | undefined) {
  const fleet = useFleet();
  const [busy, setBusy] = useState<"retry" | "wake" | null>(null);
  const retry = async () => {
    if (!node) return;
    setBusy("retry");
    try {
      await fleet.probe(node.id);
    } finally {
      setBusy(null);
    }
  };
  const wake = async () => {
    if (!node) return;
    setBusy("wake");
    try {
      await wakeMachine(node.id);
    } finally {
      setBusy(null);
    }
  };
  return { busy, retry, wake };
}

function GuestTag({ virt, node }: { virt: string | null; node?: FleetNode }) {
  // A VPS is always a VM; saying so adds nothing.
  const g = node?.kind === "vps" ? null : guestLabel(virt);
  if (!g) return null;
  return (
    <Tooltip content={g === "VM" ? `Virtual machine (${virt})` : `Container (${virt})`}>
      <span className="relative z-10 rounded bg-magenta/12 px-1 text-[10px] leading-4 font-semibold text-magenta">{g}</span>
    </Tooltip>
  );
}

function LinkChip({ m }: { m: NetMember }) {
  const label = linkLabel(m);
  if (!label) return null;
  return (
    <Tooltip content={`${m.iface}${m.speed && m.nic !== "wifi" ? ` · ${m.speed} Mbit/s` : ""}`}>
      <span
        className={clsx(
          "relative z-10 min-w-10 rounded-md border px-1.5 text-center font-mono text-[10.5px] leading-[18px]",
          (m.speed ?? 0) > 1000 && m.nic === "ethernet" && !m.virt ? "border-cyan/25 text-cyan" : "border-line-2 text-fg-3",
        )}
      >
        {label}
      </span>
    </Tooltip>
  );
}

/* ---------------- map ---------------- */

interface Wire {
  from: string;
  to: string;
  dashed?: boolean;
}

/** Draws lines between [data-wire] elements inside `ref`, re-measured whenever it resizes. */
function useWires(ref: React.RefObject<HTMLDivElement | null>, wires: Wire[]) {
  const [paths, setPaths] = useState<{ d: string; dashed?: boolean }[]>([]);
  const key = JSON.stringify(wires);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const list: Wire[] = JSON.parse(key);
    const find = (id: string) => el.querySelector<HTMLElement>(`[data-wire="${CSS.escape(id)}"]`);
    const ro = new ResizeObserver(() => {
      const box = el.getBoundingClientRect();
      const out: { d: string; dashed?: boolean }[] = [];
      for (const w of list) {
        const a = find(w.from)?.getBoundingClientRect();
        const b = find(w.to)?.getBoundingClientRect();
        if (!a || !b) continue;
        const x1 = a.left + a.width / 2 - box.left;
        const y1 = a.bottom - box.top;
        const x2 = b.left + b.width / 2 - box.left;
        const y2 = b.top - box.top;
        const my = (y1 + y2) / 2;
        out.push({ d: `M${x1} ${y1} C${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`, dashed: w.dashed });
      }
      setPaths(out);
    });
    ro.observe(el);
    for (const c of el.querySelectorAll("[data-wire]")) ro.observe(c);
    return () => ro.disconnect();
  }, [ref, key]);
  return paths;
}

function NetworkMapView({ subnets, routers }: { subnets: Subnet[]; routers: Router[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const lan = subnets.filter((s) => s.kind === "lan");
  const behind = (r: Router) => lan.filter((s) => s.router === r.key);
  const loose = lan.filter((s) => !s.router);
  const pub = subnets.filter((s) => s.kind === "public");
  const overlays = subnets.filter((s) => s.kind === "overlay");
  const hasRouters = routers.length > 0;

  const wires: Wire[] = [
    ...routers.map((r) => ({ from: "internet", to: `router:${r.key}` })),
    ...routers.flatMap((r) => behind(r).map((s) => ({ from: `router:${r.key}`, to: `net:${s.cidr}` }))),
    ...pub.map((s) => ({ from: "internet", to: `net:${s.cidr}`, dashed: true })),
  ];
  const paths = useWires(ref, wires);

  return (
    <div className="card overflow-x-auto rounded-xl">
      <div ref={ref} className="relative mx-auto w-max min-w-full px-6 pt-6 pb-6">
        <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
          {paths.map((p, i) => (
            <path key={i} d={p.d} fill="none" stroke="var(--color-line-3)" strokeWidth={1.5} strokeDasharray={p.dashed ? "5 5" : undefined} />
          ))}
        </svg>

        <div className="absolute top-4 right-5 flex items-center gap-4 text-[11px] text-fg-4">
          <span className="flex items-center gap-1.5">
            <span className="w-5 border-t-[1.5px] border-line-3" />
            same network
          </span>
          {pub.length > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-5 border-t-[1.5px] border-dashed border-line-3" />
              over the internet
            </span>
          )}
        </div>

        {(hasRouters || pub.length > 0) && (
          <div className="flex justify-center">
            <div data-wire="internet" className="relative flex h-9 items-center gap-2 rounded-full border border-dashed border-line-3 bg-bg px-4 text-[12.5px] font-medium text-fg-2">
              <Globe size={14} className="text-fg-3" />
              Internet
            </div>
          </div>
        )}

        <div className={clsx("flex items-start justify-center gap-6", (hasRouters || pub.length > 0) && "mt-14")}>
          {routers.map((r) => (
            <div key={r.key} className="flex flex-col items-center gap-14">
              <RouterCard router={r} />
              <div className="flex items-start gap-4">
                {behind(r).map((s) => (
                  <SubnetCard key={s.cidr} subnet={s} />
                ))}
              </div>
            </div>
          ))}
          {(loose.length > 0 || pub.length > 0) && (
            // Lined up with the subnets behind a router, not with the routers.
            <div className={clsx("flex items-start gap-4", hasRouters && "mt-[116px]")}>
              {loose.map((s) => (
                <SubnetCard key={s.cidr} subnet={s} />
              ))}
              {pub.map((s) => (
                <SubnetCard key={s.cidr} subnet={s} />
              ))}
            </div>
          )}
        </div>

        {overlays.length > 0 && (
          <div className="mt-8 space-y-3">
            {overlays.map((s) => (
              <OverlayStrip key={s.cidr} subnet={s} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RouterCard({ router }: { router: Router }) {
  return (
    <div data-wire={`router:${router.key}`} className="card relative flex h-[60px] min-w-[240px] items-center gap-3 rounded-xl px-3.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-hl/60 text-fg-3 ring-1 ring-line-3 ring-inset">
        <RouterIcon size={17} strokeWidth={1.8} />
      </span>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-fg">
          Gateway
          {router.machine && (
            <Link href={`/nodes/${router.machine}`} className="font-mono text-[12px] text-fg-3 hover:underline">
              · {router.machine}
            </Link>
          )}
        </div>
        <div className="truncate font-mono text-[11.5px] text-fg-4 tabular">{router.ips.join(" · ")}</div>
      </div>
    </div>
  );
}

function SubnetCard({ subnet }: { subnet: Subnet }) {
  const fleet = useFleet();
  const online = subnet.members.filter((m) => fleet.states[m.id]?.status === "online").length;
  return (
    <section data-wire={`net:${subnet.cidr}`} className="card relative w-[290px] overflow-hidden rounded-xl" aria-label={subnet.cidr}>
      <header className="flex items-start justify-between gap-2 border-b border-line px-3.5 pt-3 pb-2.5">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[13px] font-medium text-fg tabular">{subnet.cidr}</div>
          <div className="mt-0.5 flex min-w-0">
            <SubnetName subnet={subnet} variant="card" />
          </div>
        </div>
        <span className="shrink-0 pt-0.5 text-[11.5px] text-fg-4 tabular">
          {subnet.members.length} · {online} online
        </span>
      </header>
      <div className="py-1">
        {subnet.members.map((m) => (
          <MapRow key={`${m.id}:${m.addr}`} m={m} />
        ))}
      </div>
    </section>
  );
}

function MapRow({ m }: { m: NetMember }) {
  const fleet = useFleet();
  const node = fleet.nodes.find((n) => n.id === m.id);
  const st = fleet.displayStatus(m.id);
  const down = isDown(st);
  const a = ACCENT[fleet.accent(m.id)] ?? ACCENT.blue;
  const { busy, retry, wake } = useRecover(node);

  return (
    <div className="group relative flex h-10 items-center gap-2.5 px-3.5 transition-colors hover:bg-hover/70">
      <Link href={`/nodes/${m.id}`} className="absolute inset-0" aria-label={`Open ${m.id}`} />
      <StatusDot status={st} size={7} />
      <span className={clsx("truncate font-mono text-[12.5px] font-semibold", down ? "text-fg-3" : a.text)}>{m.id}</span>
      <GuestTag virt={m.virt} node={node} />
      <span className={clsx("ml-auto font-mono text-[11.5px] tabular", down ? "text-fg-5" : "text-fg-4")}>{m.addr}</span>
      {down ? (
        node?.mac ? (
          <button
            onClick={wake}
            disabled={busy === "wake"}
            className="relative z-10 inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-yellow/25 px-1.5 text-[11.5px] font-medium text-yellow hover:bg-yellow/10 disabled:opacity-50"
          >
            <Zap size={11} />
            Wake
          </button>
        ) : (
          <button
            onClick={retry}
            disabled={busy === "retry"}
            className="relative z-10 inline-flex h-6 cursor-pointer items-center gap-1 rounded-md border border-line-2 px-1.5 text-[11.5px] font-medium text-fg-3 hover:bg-hover hover:text-fg disabled:opacity-50"
          >
            <RefreshCw size={11} className={busy === "retry" ? "animate-spin" : undefined} />
            Retry
          </button>
        )
      ) : (
        <span className="relative flex items-center">
          <span className="transition-opacity group-hover:opacity-0 group-has-[[aria-expanded=true]]:opacity-0">
            <LinkChip m={m} />
          </span>
          {node && (
            <span className="absolute right-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 group-has-[[aria-expanded=true]]:opacity-100">
              <NodeMenu node={node} online={st === "online"} />
            </span>
          )}
        </span>
      )}
    </div>
  );
}

function OverlayStrip({ subnet }: { subnet: Subnet }) {
  const fleet = useFleet();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-dashed border-line-3 bg-panel/50 px-4 py-3">
      <div className="w-[200px] shrink-0">
        <div className="flex min-w-0 [&_button]:text-[13px] [&_button]:font-medium [&_button]:text-fg">
          <SubnetName subnet={subnet} variant="card" />
        </div>
        <div className="font-mono text-[11.5px] text-fg-4">{subnet.cidr} · overlay</div>
      </div>
      <div className="flex flex-wrap gap-2">
        {subnet.members.map((m) => {
          const st = fleet.displayStatus(m.id);
          return (
            <Tooltip key={`${m.id}:${m.addr}`} content={`${m.addr} on ${m.iface}`}>
              <Link
                href={`/nodes/${m.id}`}
                className={clsx(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border border-line-2 bg-panel px-2.5 font-mono text-[12px] hover:border-line-3",
                  isDown(st) ? "text-fg-4" : "text-fg-2",
                )}
              >
                <StatusDot status={st} size={6} />
                {m.id}
              </Link>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- list ---------------- */

function NetworkList({ subnets }: { subnets: Subnet[] }) {
  return (
    <div className="space-y-7 max-sm:space-y-6">
      {subnets.map((s) => (
        <section key={s.cidr} aria-label={s.cidr}>
          <div className="mb-2.5 flex min-w-0 items-center gap-2">
            <span className="font-mono text-[12.5px] font-medium text-fg-2 tabular">{s.cidr}</span>
            <SubnetName subnet={s} variant="section" />
            {s.gateway && (
              <span className="truncate text-[12px] text-fg-4 max-sm:hidden">
                <span className="text-fg-5">· </span>gateway <span className="font-mono">{s.gateway}</span>
              </span>
            )}
            {s.kind === "overlay" && <span className="text-[12px] text-fg-4 max-sm:hidden">· overlay</span>}
            <span className="ml-auto rounded-full bg-hl px-1.5 text-[10.5px] font-semibold text-fg-3 tabular sm:ml-0">{s.members.length}</span>
          </div>
          <div className="card divide-y divide-line overflow-hidden rounded-xl">
            {s.members.map((m) => (
              <ListRow key={`${m.id}:${m.addr}`} m={m} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function ListRow({ m }: { m: NetMember }) {
  const fleet = useFleet();
  const node = fleet.nodes.find((n) => n.id === m.id);
  const s = fleet.states[m.id];
  const st = fleet.displayStatus(m.id);
  const down = isDown(st);
  const accent = fleet.accent(m.id);
  const a = ACCENT[accent] ?? ACCENT.blue;
  const { busy, retry, wake } = useRecover(node);
  if (!node) return null;

  return (
    <div className="group relative flex items-center gap-x-4 px-4 py-2.5 transition-colors hover:bg-hl/20 max-sm:gap-x-3 max-sm:px-3">
      <Link href={`/nodes/${m.id}`} className="absolute inset-0" aria-label={`Open ${m.id}`} />
      <NodeIcon kind={node.kind} accent={accent} size={34} dim={down} />
      <div className="min-w-0 flex-1 sm:w-[190px] sm:flex-none">
        <div className="flex items-center gap-1.5">
          <span className={clsx("truncate font-mono text-[14px] font-semibold", down ? "text-fg-3" : a.text)}>{m.id}</span>
          <GuestTag virt={m.virt} node={node} />
        </div>
        <div className="truncate text-[11.5px] text-fg-4 max-sm:hidden">
          {kindLabel(node.kind)}
          {node.local && <span className="text-cyan"> · this machine</span>}
        </div>
        <div className="truncate font-mono text-[12px] text-fg-4 sm:hidden">{m.addr}</div>
      </div>
      <span className={clsx("w-[120px] shrink-0 font-mono text-[12.5px] tabular max-sm:hidden", down ? "text-fg-4" : "text-fg-2")}>{m.addr}</span>
      <span className="w-[130px] shrink-0 truncate text-[12px] text-fg-4 max-lg:hidden">
        <span className="font-mono">{m.iface}</span>
        {linkLabel(m) && (
          <>
            <span className="text-fg-5"> · </span>
            <span className={(m.speed ?? 0) > 1000 && m.nic === "ethernet" && !m.virt ? "text-cyan" : undefined}>{linkLabel(m)}</span>
          </>
        )}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px] max-sm:hidden">
        <StatusDot status={st} size={6} />
        {down ? (
          <span className="truncate text-red">
            {st === "powered-off" ? "Powered off" : "Unreachable"}
            {s?.lastSeen && <span className="text-fg-4"> · last seen {ago(s.lastSeen)}</span>}
          </span>
        ) : (
          <span className="truncate text-fg-4">
            {st === "online" ? "Online" : st === "unknown" ? "Checking" : st.replace("-", " ")}
            {st === "online" && (s?.via === "local" ? " · local" : s?.latencyMs != null ? ` · ${s.latencyMs}ms` : "")}
          </span>
        )}
      </span>
      <div className="relative z-10 flex shrink-0 items-center gap-1">
        {down ? (
          <>
            <Button size="sm" variant="secondary" icon={RefreshCw} loading={busy === "retry"} onClick={retry} aria-label={`Retry ${m.id}`} className="max-sm:!size-11 max-sm:!px-0">
              <span className="max-sm:hidden">Retry</span>
            </Button>
            {node.mac && (
              <Button size="sm" variant="secondary" icon={Zap} loading={busy === "wake"} onClick={wake}>
                Wake
              </Button>
            )}
          </>
        ) : (
          <>
            <span className="sm:hidden">
              <LinkChip m={m} />
            </span>
            <span className="max-sm:hidden">
              <NodeMenu node={node} online={st === "online"} />
            </span>
          </>
        )}
      </div>
    </div>
  );
}
