"use client";

import clsx from "clsx";
import {
  Activity,
  Play,
  ChevronLeft,
  ChevronRight,
  CloudDownload,
  Download,
  LayoutGrid,
  LogOut,
  Menu as MenuIcon,
  Network,
  Plus,
  Puzzle,
  Search,
  Server,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Wifi,
  WifiOff,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useState, useSyncExternalStore } from "react";
import { Toaster, toast } from "sonner";
import { pct } from "@/lib/format";
import { ActionsProvider, useActions } from "./actions";
import { Sparkline } from "./charts";
import { CommandPalette, usePalette } from "./command-palette";
import { FleetProvider, useFleet } from "./fleet-provider";
import { NodeIcon, kindLabel } from "./node-icon";
import { TerminalDock } from "./terminal-dock";
import { TerminalProvider, useTerminals } from "./terminal-provider";
import { ACCENT, Button, Kbd, Modal, StatusDot, Tooltip } from "./ui";
import { useInstallPrompt, useMe } from "./pwa";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <FleetProvider>
      <TerminalProvider>
        <ActionsProvider>
          <CommandPalette>
            <div className="flex h-dvh overflow-hidden">
              <Sidebar />
              <div className="flex min-w-0 flex-1 flex-col">
                <Topbar />
                <MobileTopbar />
                <ConnectionBanner />
                <div className="relative flex min-h-0 flex-1 flex-col">
                  <main className="canvas-grid min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[calc(64px+env(safe-area-inset-bottom))] md:pb-0">
                    {children}
                  </main>
                  <TerminalDock />
                </div>
              </div>
            </div>
            <BottomNav />
            <Suspense fallback={null}>
              <UrlEffects />
            </Suspense>
            <Toaster
              position="bottom-right"
              offset={{ bottom: 56, right: 16 }}
              mobileOffset={{ bottom: "calc(76px + env(safe-area-inset-bottom))", left: 12, right: 12 }}
              toastOptions={{
                classNames: {
                  toast:
                    "!bg-[#171821] !border !border-line-2 !text-fg !rounded-xl !shadow-[0_20px_50px_-12px_rgba(0,0,0,0.75)] !font-sans",
                  title: "!text-[13px] !font-semibold",
                  description: "!text-[12px] !text-fg-3 !whitespace-pre-line",
                  actionButton: "!bg-blue !text-[#11131c] !font-semibold",
                },
              }}
            />
          </CommandPalette>
        </ActionsProvider>
      </TerminalProvider>
    </FleetProvider>
  );
}

/** Handles ?terminal=1 (home-screen shortcut) and ?paired=1 (just scanned a pairing code). */
function UrlEffects() {
  const params = useSearchParams();
  const router = useRouter();
  const term = useTerminals();
  const { setDock } = term;
  useEffect(() => {
    if (params.get("terminal") === "1") {
      setDock("open");
      router.replace("/");
    }
    if (params.get("paired") === "1") {
      const standalone = window.matchMedia("(display-mode: standalone)").matches;
      toast.success("This device is signed in", {
        description: standalone
          ? undefined
          : /iPhone|iPad/.test(navigator.userAgent)
            ? "Install it: tap Share, then Add to Home Screen."
            : "Install it from the browser menu: Add to Home screen / Install app.",
        duration: 10_000,
      });
      router.replace("/");
    }
  }, [params, router, setDock]);
  return null;
}

function Logo({ size = 26 }: { size?: number }) {
  // unique per instance: a gradient defined inside a hidden copy can't be referenced
  const id = `lg${useId().replace(/:/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7aa2f7" />
          <stop offset="100%" stopColor="#bb9af7" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8" fill="#1f2335" stroke={`url(#${id})`} strokeOpacity="0.55" />
      <path d="M9 11l5 5-5 5" fill="none" stroke={`url(#${id})`} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16.5 21.5h6.5" stroke="#7dcfff" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

function NavLink({ href, icon: Icon, children, badge }: { href: string; icon: typeof LayoutGrid; children: React.ReactNode; badge?: React.ReactNode }) {
  const path = usePathname();
  const active = href === "/" ? path === "/" : path.startsWith(href);
  return (
    <Link
      href={href}
      className={clsx(
        "group flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-colors",
        active ? "bg-hl text-fg" : "text-fg-3 hover:bg-hover hover:text-fg-2",
      )}
    >
      <Icon size={15} className={active ? "text-blue" : "text-fg-4 group-hover:text-fg-3"} />
      <span className="flex-1">{children}</span>
      {badge}
    </Link>
  );
}

function MachineRow({ id, onNavigate, big }: { id: string; onNavigate?: () => void; big?: boolean }) {
  const fleet = useFleet();
  const path = usePathname();
  const n = fleet.nodes.find((x) => x.id === id)!;
  const st = fleet.displayStatus(n.id);
  const m = fleet.states[n.id]?.metrics;
  const active = path === `/nodes/${n.id}`;
  const a = ACCENT[fleet.accent(n.id)];
  const upd = fleet.updates[n.id];
  const hist = (fleet.history[n.id] ?? []).slice(-20).map((x) => x.cpu);
  return (
    <Link
      href={`/nodes/${n.id}`}
      onClick={onNavigate}
      className={clsx(
        "group relative flex items-center gap-2.5 rounded-md transition-colors",
        big ? "rounded-xl px-3 py-3 active:bg-hl" : "px-2.5 py-2",
        active ? "bg-hl" : "hover:bg-hover",
      )}
    >
      {active && !big && <span className={clsx("absolute top-2 bottom-2 left-0 w-[2px] rounded-full", a.bg)} />}
      {big ? <NodeIcon kind={n.kind} accent={fleet.accent(n.id)} size={38} dim={st === "offline" || st === "powered-off"} /> : <StatusDot status={st} size={7} />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {big && <StatusDot status={st} size={6} />}
          <span className={clsx("font-mono font-semibold", big ? "text-[15px]" : "text-[13px]", st === "offline" || st === "powered-off" ? "text-fg-3" : a.text)}>
            {n.id}
          </span>
          {(upd?.count ?? 0) > 0 && !big && (
            <Tooltip content={`${upd!.count} pending update${upd!.count === 1 ? "" : "s"}`} side="right">
              <span className="flex items-center gap-0.5 rounded-full bg-blue/12 px-1.5 text-[10px] leading-[15px] font-semibold text-blue tabular">
                <CloudDownload size={10} strokeWidth={2.5} />
                {upd!.count}
              </span>
            </Tooltip>
          )}
        </div>
        <div className={clsx("truncate text-fg-4", big ? "text-[12.5px]" : "text-[11px]")}>
          {kindLabel(n.kind)}
          {n.local && st === "online" && !big && <span className="text-cyan"> · this machine</span>}
          {st !== "online" && st !== "unknown" && ` · ${st === "offline" ? "offline" : st.replace("-", " ")}`}
          {big && m && st === "online" && ` · CPU ${pct(m.cpu)}`}
          {big && (upd?.count ?? 0) > 0 && ` · ${upd!.count} update${upd!.count === 1 ? "" : "s"}`}
        </div>
      </div>
      {m && st === "online" && (
        <Tooltip content={`CPU ${pct(m.cpu)}`} side="right">
          <div className={clsx("shrink-0", big ? "h-7 w-16" : "h-5 w-11")} aria-label={`CPU ${pct(m.cpu)}`}>
            <Sparkline values={hist} color={a.hex} height={big ? 28 : 20} width={big ? 64 : 44} max={Math.max(25 / 1.2, ...hist.map((v) => v ?? 0)) * 1.2} />
          </div>
        </Tooltip>
      )}
      {big && <ChevronRight size={16} className="text-fg-5" />}
    </Link>
  );
}

function Sidebar() {
  const fleet = useFleet();
  const term = useTerminals();
  const actions = useActions();
  const running = term.sessions.filter((s) => !s.exited).length;
  const local = fleet.nodes.find((n) => n.local);

  return (
    <aside className="hidden w-[248px] shrink-0 flex-col border-r border-line bg-panel/70 md:flex">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <Logo />
        <div className="leading-none">
          <div className="text-[14px] font-semibold tracking-tight text-fg">fleet</div>
          <div className="mt-0.5 text-[10.5px] font-medium text-fg-4">control panel</div>
        </div>
      </div>

      <nav className="space-y-0.5 px-2.5 pt-2">
        <NavLink href="/" icon={LayoutGrid}>
          Overview
        </NavLink>
        <NavLink href="/proxy" icon={Network}>
          AI proxy
        </NavLink>
        <NavLink href="/skill" icon={Puzzle}>
          Claude skill
        </NavLink>
        <NavLink
          href="/activity"
          icon={Activity}
          badge={
            running > 0 ? (
              <span className="flex items-center gap-1.5 rounded-full bg-green/10 px-1.5 font-mono text-[10.5px] text-green">
                <StatusDot status="online" size={5} />
                {running}
              </span>
            ) : null
          }
        >
          Activity
        </NavLink>
      </nav>

      <div className="mt-6 flex items-center justify-between gap-2 pr-3 pl-5 pb-1.5">
        <span className="text-[10.5px] font-semibold tracking-[0.09em] text-fg-4 uppercase">Machines</span>
        <span className="ml-auto font-mono text-[10.5px] text-fg-5 tabular">
          {fleet.nodes.filter((n) => fleet.states[n.id]?.status === "online").length}/{fleet.nodes.length}
        </span>
        <Tooltip content="Add machine" side="right">
          <button
            onClick={actions.addMachine}
            aria-label="Add machine"
            className="grid size-6 cursor-pointer place-items-center rounded-md text-fg-4 transition-colors hover:bg-hover hover:text-fg"
          >
            <Plus size={14} />
          </button>
        </Tooltip>
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2.5">
        {!fleet.loaded && [0, 1, 2, 3].map((i) => <div key={i} className="skeleton mx-1 my-1.5 h-9 rounded-md opacity-60" />)}
        {fleet.nodes.map((n) => (
          <MachineRow key={n.id} id={n.id} />
        ))}
        {fleet.loaded && fleet.nodes.length === 0 && (
          <button onClick={actions.addMachine} className="mx-1 my-1 w-[calc(100%-8px)] cursor-pointer rounded-md border border-dashed border-line-3 px-3 py-3 text-left text-[12px] text-fg-4 hover:border-blue/40 hover:text-fg-2">
            No machines yet. <span className="text-blue">Add one</span>
          </button>
        )}
      </div>

      <div className="space-y-2 border-t border-line px-3 py-3">
        <button
          onClick={actions.devices}
          className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-[12.5px] font-medium text-fg-3 transition-colors hover:bg-hover hover:text-fg"
        >
          <Smartphone size={14} className="text-cyan" />
          Add a device
        </button>
        <div className="flex items-center gap-2 px-2 text-[11px] text-fg-4">
          {term.connected ? <Wifi size={12} className="text-green" /> : <WifiOff size={12} className="text-red" />}
          <span className="truncate">
            {term.connected ? "Live" : "Reconnecting…"} · panel on <span className="font-mono text-fg-3">{local?.id ?? "localhost"}</span>
          </span>
        </div>
      </div>
    </aside>
  );
}

const subscribeClock = (cb: () => void) => {
  const t = setInterval(cb, 1000);
  return () => clearInterval(t);
};
/** Wall clock that ticks every second; null during SSR so hydration matches. */
function useClock(): number | null {
  return useSyncExternalStore(
    subscribeClock,
    () => Math.floor(Date.now() / 1000) * 1000,
    () => null,
  );
}

function LiveDot() {
  const fleet = useFleet();
  const now = useClock();
  const stale = fleet.lastFetch && now ? now - fleet.lastFetch > 10_000 : false;
  return (
    <span
      className={clsx(
        "size-1.5 shrink-0 rounded-full",
        fleet.fetchError || stale ? "bg-red" : fleet.loaded ? "animate-pulse-dot bg-green text-green" : "bg-fg-5",
      )}
    />
  );
}

function Topbar() {
  const path = usePathname();
  const palette = usePalette();
  const actions = useActions();
  const fleet = useFleet();
  const now = useClock();

  const crumbs: { label: string; href?: string; mono?: boolean }[] = [{ label: "Fleet", href: "/" }];
  if (path.startsWith("/nodes/")) crumbs.push({ label: decodeURIComponent(path.split("/")[2] ?? ""), mono: true });
  else if (path === "/activity") crumbs.push({ label: "Activity" });
  else if (path === "/ai") crumbs.push({ label: "AI chat" });
  else if (path === "/skill") crumbs.push({ label: "Claude skill" });
  else if (path === "/machines") crumbs.push({ label: "Machines" });
  else if (path.startsWith("/proxy")) {
    const tab = path.split("/")[2];
    crumbs.push(tab ? { label: "AI proxy", href: "/proxy" } : { label: "AI proxy" });
    if (tab) crumbs.push({ label: { accounts: "Accounts", keys: "API keys", models: "Models", usage: "Usage", logs: "Logs", settings: "Settings" }[tab] ?? tab });
  }
  else crumbs.push({ label: "Overview" });

  return (
    <header className="hidden h-14 shrink-0 items-center gap-3 border-b border-line bg-bg/80 px-5 backdrop-blur md:flex">
      <nav className="flex min-w-0 items-center gap-1.5 text-[13px]" aria-label="Breadcrumb">
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1.5">
            {i > 0 && <ChevronRight size={13} className="text-fg-5" />}
            {c.href && i < crumbs.length - 1 ? (
              <Link href={c.href} className="text-fg-4 hover:text-fg-2">
                {c.label}
              </Link>
            ) : (
              <span className={clsx("font-medium text-fg", c.mono && "font-mono")}>{c.label}</span>
            )}
          </span>
        ))}
      </nav>

      <button
        onClick={() => palette.setOpen(true)}
        className="mx-auto flex h-8 w-full max-w-[420px] cursor-pointer items-center gap-2 rounded-md border border-line-2 bg-panel/80 px-3 text-[12.5px] text-fg-4 transition-colors hover:border-line-3 hover:text-fg-3"
      >
        <Search size={14} />
        <span className="flex-1 text-left">Search machines, run actions…</span>
        <Kbd>Ctrl</Kbd>
        <Kbd>K</Kbd>
      </button>

      <div className="flex shrink-0 items-center gap-3">
        <Tooltip content={fleet.fetchError ? `Polling failed: ${fleet.fetchError}` : "Metrics refresh every 3 seconds"} side="bottom">
          <div className="hidden items-center gap-2 text-[11.5px] text-fg-4 tabular lg:flex">
            <LiveDot />
            {fleet.fetchError
              ? "Disconnected"
              : !fleet.loaded || !now || !fleet.lastFetch
                ? "Connecting…"
                : `Live · ${Math.max(0, Math.round((now - fleet.lastFetch) / 1000))}s ago`}
          </div>
        </Tooltip>
        <Button size="sm" variant="secondary" icon={SquareTerminal} onClick={() => actions.run()}>
          Run command
        </Button>
      </div>
    </header>
  );
}

function ConnectionBanner() {
  const fleet = useFleet();
  const term = useTerminals();
  void term;
  if (!fleet.fetchError) return null;
  return (
    <div className="flex shrink-0 items-center justify-center gap-2 bg-yellow/10 px-4 py-1.5 text-[12.5px] text-yellow">
      <WifiOff size={13} /> Can&apos;t reach the panel — reconnecting…
    </div>
  );
}

/* ---------------- mobile chrome ---------------- */

function MobileTopbar() {
  const path = usePathname();
  const palette = usePalette();
  const fleet = useFleet();
  const nodeId = path.startsWith("/nodes/") ? decodeURIComponent(path.split("/")[2] ?? "") : null;
  const title =
    nodeId ??
    (path === "/activity" ? "Activity" : path === "/machines" ? "Machines" : path === "/ai" ? "AI chat" : path === "/skill" ? "Claude skill" : path.startsWith("/proxy") ? "AI proxy" : "Fleet");

  return (
    <header className="flex shrink-0 items-end border-b border-line bg-bg/85 pt-[env(safe-area-inset-top)] backdrop-blur-md md:hidden">
      <div className="flex h-[52px] w-full items-center gap-2 px-2">
        {nodeId ? (
          <Link href="/machines" aria-label="Back to machines" className="grid size-10 place-items-center rounded-full text-fg-3 active:bg-hl">
            <ChevronLeft size={22} />
          </Link>
        ) : (
          <Link href="/" className="grid size-10 place-items-center" aria-label="Overview">
            <Logo size={28} />
          </Link>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={clsx("truncate text-[17px] font-semibold tracking-tight", nodeId ? clsx("font-mono", ACCENT[fleet.accent(nodeId)]?.text) : "text-fg")}>
            {title}
          </span>
          {fleet.fetchError && (
            <span className="rounded-full bg-yellow/12 px-2 py-0.5 text-[11.5px] font-medium text-yellow">Reconnecting…</span>
          )}
        </div>
        <button onClick={() => palette.setOpen(true)} aria-label="Search" className="grid size-11 place-items-center rounded-full text-fg-3 active:bg-hl">
          <Search size={21} />
        </button>
      </div>
    </header>
  );
}

function BottomNav() {
  const path = usePathname();
  const term = useTerminals();
  const fleet = useFleet();
  const [sheet, setSheet] = useState<"more" | null>(null);
  const running = term.sessions.filter((s) => !s.exited).length;
  const termOpen = term.dock !== "closed";
  const pending = Object.values(fleet.updates).reduce((a, u) => a + (u?.count ?? 0), 0);

  const items: { key: string; label: string; icon: typeof LayoutGrid; href?: string; onClick?: () => void; active: boolean; badge?: React.ReactNode }[] = [
    { key: "overview", label: "Overview", icon: LayoutGrid, href: "/", active: path === "/" && !termOpen && !sheet },
    {
      key: "machines",
      label: "Machines",
      icon: Server,
      href: "/machines",
      active: (path === "/machines" || path.startsWith("/nodes/")) && !termOpen && !sheet,
      badge: pending ? <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-blue ring-2 ring-bg" /> : null,
    },
    {
      key: "terminal",
      label: "Terminal",
      icon: SquareTerminal,
      onClick: () => term.setDock(termOpen ? "closed" : "open"),
      active: termOpen,
      badge: running ? (
        <span className="absolute -top-1 -right-2 min-w-4 rounded-full bg-green px-1 text-center text-[9.5px] leading-4 font-bold text-[#11131c] tabular">{running}</span>
      ) : null,
    },
    { key: "ai", label: "AI", icon: Sparkles, href: "/ai", active: path === "/ai" && !termOpen && !sheet },
    { key: "more", label: "More", icon: MenuIcon, onClick: () => setSheet("more"), active: sheet === "more" },
  ];

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Main"
      >
        <div className="grid h-[64px] grid-cols-5">
          {items.map((it) => {
            const inner = (
              <>
                <span className={clsx("relative grid h-8 w-14 place-items-center rounded-full transition-colors", it.active && "bg-blue/15")}>
                  <it.icon size={20} strokeWidth={it.active ? 2.3 : 1.9} />
                  {it.badge}
                </span>
                <span className={clsx("text-[11px]", it.active ? "font-semibold" : "font-medium")}>{it.label}</span>
              </>
            );
            const cls = clsx(
              "relative flex flex-col items-center justify-center gap-0.5 transition-colors",
              it.active ? "text-blue" : "text-fg-3",
            );
            return it.href ? (
              <Link
                key={it.key}
                href={it.href}
                className={cls}
                onClick={() => {
                  setSheet(null);
                  term.setDock("closed");
                }}
              >
                {inner}
              </Link>
            ) : (
              <button key={it.key} onClick={it.onClick} className={clsx(cls, "cursor-pointer")}>
                {inner}
              </button>
            );
          })}
        </div>
      </nav>
      <MoreSheet open={sheet === "more"} onClose={() => setSheet(null)} />
    </>
  );
}

/** Phone "Machines" tab: every machine as a big tappable row. */
export function MachinesView() {
  const fleet = useFleet();
  const actions = useActions();
  const online = fleet.nodes.filter((n) => fleet.states[n.id]?.status === "online").length;
  return (
    <div className="mx-auto max-w-2xl px-3 pt-3 pb-8 md:pt-7">
      <div className="flex items-center gap-2 px-2 pb-2">
        <p className="flex-1 text-[13px] text-fg-4">{fleet.loaded ? `${online} of ${fleet.nodes.length} online` : "Connecting…"}</p>
        <Button size="sm" variant="secondary" icon={Plus} onClick={actions.addMachine}>
          Add machine
        </Button>
      </div>
      <div className="card space-y-0.5 rounded-2xl p-1.5">
        {fleet.loaded && fleet.nodes.length === 0 && (
          <button onClick={actions.addMachine} className="w-full cursor-pointer rounded-xl px-4 py-8 text-center text-[13.5px] text-fg-3 active:bg-hl">
            No machines yet. <span className="text-blue">Add your first one</span>
          </button>
        )}
        {!fleet.loaded && [0, 1, 2, 3].map((i) => <div key={i} className="skeleton m-1 h-14 rounded-xl opacity-50" />)}
        {[...fleet.nodes]
          .sort((a, b) => Number(fleet.states[b.id]?.status === "online") - Number(fleet.states[a.id]?.status === "online"))
          .map((n) => (
            <MachineRow key={n.id} id={n.id} big />
          ))}
      </div>
    </div>
  );
}

function SheetItem({ icon: Icon, label, hint, onClick, tone }: { icon: typeof Search; label: string; hint?: string; onClick: () => void; tone?: "red" }) {
  return (
    <button onClick={onClick} className="flex min-h-14 w-full cursor-pointer items-center gap-3.5 rounded-xl px-3 py-2.5 text-left active:bg-hl">
      <span className={clsx("grid size-9 place-items-center rounded-lg", tone === "red" ? "bg-red/10 text-red" : "bg-hl/70 text-fg-2")}>
        <Icon size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className={clsx("block text-[15px] font-medium", tone === "red" ? "text-red" : "text-fg")}>{label}</span>
        {hint && <span className="block truncate text-[12.5px] text-fg-4">{hint}</span>}
      </span>
      {tone !== "red" && <ChevronRight size={16} className="text-fg-5" />}
    </button>
  );
}

function MoreSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const palette = usePalette();
  const actions = useActions();
  const fleet = useFleet();
  const me = useMe();
  const install = useInstallPrompt();
  const pending = Object.values(fleet.updates).reduce((a, u) => a + (u?.count ?? 0), 0);
  const go = (fn: () => void) => () => {
    onClose();
    setTimeout(fn, 180);
  };
  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.replace("/login");
  };

  return (
    <Modal open={open} onClose={onClose} icon={MenuIcon} tone="neutral" title="More">
      <div className="-mx-2 space-y-0.5 pb-3">
        <SheetItem icon={Search} label="Search & actions" hint="Jump to a machine or run any action" onClick={go(() => palette.setOpen(true))} />
        <SheetItem icon={Activity} label="Activity" hint="Running and finished terminal sessions" onClick={go(() => router.push("/activity"))} />
        <SheetItem icon={Network} label="AI proxy" hint="Subscriptions, API keys, usage" onClick={go(() => router.push("/proxy"))} />
        <SheetItem icon={Plus} label="Add machine" hint="Indexed automatically over ssh" onClick={go(actions.addMachine)} />
        <SheetItem icon={Puzzle} label="Claude skill" hint="Teach Claude Code your machines" onClick={go(() => router.push("/skill"))} />
        <SheetItem icon={Play} label="Run command" hint="On one or several machines" onClick={go(() => actions.run())} />
        <SheetItem icon={CloudDownload} label="Update machines" hint={pending ? `${pending} pending` : "Everything current"} onClick={go(() => actions.update([]))} />
        <SheetItem icon={Smartphone} label="Add a device" hint="Pairing code, signed-in devices, password" onClick={go(actions.devices)} />
        {install.canInstall && <SheetItem icon={Download} label="Install app" hint="Add Fleet to your home screen" onClick={go(install.prompt)} />}
        {install.iosHint && (
          <div className="mx-3 my-2 rounded-xl border border-line-2 bg-void/40 px-3.5 py-3 text-[13px] leading-relaxed text-fg-3">
            <span className="font-medium text-fg-2">Install on iPhone:</span> tap <span className="text-fg-2">Share</span>, then{" "}
            <span className="text-fg-2">Add to Home Screen</span>.
          </div>
        )}
        {me && !me.local && <SheetItem icon={LogOut} label="Sign out" hint={me.device?.name} onClick={signOut} tone="red" />}
      </div>
    </Modal>
  );
}
