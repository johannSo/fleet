"use client";

import clsx from "clsx";
import { Command } from "cmdk";
import {
  Activity,
  ArrowRight,
  BarChart3,
  Boxes,
  CircuitBoard,
  Cloud,
  CloudDownload,
  KeyRound,
  Laptop,
  LayoutGrid,
  Monitor,
  Network,
  Play,
  Plus,
  Power,
  Puzzle,
  RotateCw,
  Search,
  Server,
  Smartphone,
  SquareTerminal,
  UserRound,
  Users,
  Waves,
  Waypoints,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useActions } from "./actions";
import { useFleet } from "./fleet-provider";
import { useTerminals } from "./terminal-provider";
import { ACCENT, Kbd, StatusDot } from "./ui";

const KIND_ICON: Record<string, typeof Search> = { desktop: Monitor, laptop: Laptop, "raspberry-pi": CircuitBoard, server: Server, vps: Cloud };

const Ctx = createContext<{ open: boolean; setOpen: (o: boolean) => void } | null>(null);
export function usePalette() {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePalette outside CommandPalette");
  return c;
}

function Item({
  value,
  onSelect,
  icon: Icon,
  children,
  hint,
  tone,
  keywords,
  className,
}: {
  className?: string;
  value: string;
  onSelect: () => void;
  icon: typeof Search;
  children: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "danger" | "warning";
  keywords?: string[];
}) {
  return (
    <Command.Item
      value={value}
      keywords={keywords}
      onSelect={onSelect}
      className={clsx(className, "group mx-1.5 flex h-9 cursor-pointer items-center gap-3 rounded-md px-2.5 text-[13px] text-fg-2 data-[selected=true]:text-fg pointer-coarse:h-11 pointer-coarse:text-[15px]")}
    >
      <Icon
        size={15}
        className={clsx(tone === "danger" ? "text-red" : tone === "warning" ? "text-yellow" : "text-fg-4 group-data-[selected=true]:text-blue")}
      />
      <span className="flex min-w-0 flex-1 items-center gap-2 truncate">{children}</span>
      {hint && <span className="text-[11px] text-fg-4">{hint}</span>}
      <ArrowRight size={13} className="text-fg-5 opacity-0 group-data-[selected=true]:opacity-100" />
    </Command.Item>
  );
}

export function CommandPalette({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = useState(false);
  const [q, setQ] = useState("");
  // On touch screens nothing is pre-highlighted: a highlight means "Enter picks this", and there's no Enter.
  const [selected, setSelected] = useState("");
  const [touch, setTouch] = useState(false);
  const setOpen = useCallback((o: boolean) => {
    if (o) {
      setQ("");
      setSelected("");
      setTouch(window.matchMedia("(pointer: coarse)").matches);
    }
    setOpenState(o);
  }, []);
  const router = useRouter();
  const fleet = useFleet();
  const actions = useActions();
  const term = useTerminals();
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!openRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  const value = useMemo(() => ({ open, setOpen }), [open, setOpen]);
  const online = fleet.nodes.filter((n) => fleet.displayStatus(n.id) === "online");

  return (
    <Ctx.Provider value={value}>
      {children}
      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-[85] flex items-start justify-center px-2 pt-[calc(env(safe-area-inset-top)+8px)] sm:px-4 sm:pt-[14vh]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
          >
            <div className="fixed inset-0 bg-[#0a0b10]/70 backdrop-blur-[3px]" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: 8, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.985 }}
              transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
              className="relative w-full max-w-[600px] overflow-hidden rounded-xl border border-line-2 bg-[#171821] shadow-[0_40px_100px_-20px_rgba(0,0,0,0.85)]"
            >
              <Command
                label="Command palette"
                loop
                {...(touch ? { value: selected, onValueChange: setSelected } : {})}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setOpen(false);
                  }
                }}
              >
                <div className="flex h-12 items-center gap-3 border-b border-line-2 px-4">
                  <Search size={16} className="text-fg-4" />
                  <Command.Input
                    autoFocus
                    value={q}
                    onValueChange={setQ}
                    placeholder="Type a machine or an action…"
                    className="h-full flex-1 bg-transparent text-[14px] text-fg placeholder:text-fg-5 focus:outline-none"
                  />
                  <Kbd className="pointer-coarse:hidden">Esc</Kbd>
                  <button onClick={() => setOpen(false)} className="hidden cursor-pointer text-[14px] text-blue pointer-coarse:block">
                    Cancel
                  </button>
                </div>
                <Command.List className="max-h-[62dvh] overflow-y-auto overscroll-contain py-1.5 sm:max-h-[52vh] [mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)] pb-6">
                  <Command.Empty className="py-10 text-center text-[13px] text-fg-4">No matches for “{q}”.</Command.Empty>

                  <Command.Group heading="Machines">
                    {[...fleet.nodes]
                      .sort((a, b) => Number(fleet.displayStatus(b.id) === "online") - Number(fleet.displayStatus(a.id) === "online"))
                      .map((n) => (
                      <Item
                        key={n.id}
                        value={`go ${n.id}`}
                        keywords={[n.hostname, n.os, n.kind, n.model, ...n.ips.map((i) => i.value)]}
                        icon={KIND_ICON[n.kind] ?? LayoutGrid}
                        onSelect={() => run(() => router.push(`/nodes/${n.id}`))}
                        hint={<span className="font-mono pointer-coarse:hidden">{n.ips[0]?.value}</span>}
                      >
                        <StatusDot status={fleet.displayStatus(n.id)} size={6} />
                        <span className={clsx("font-mono font-semibold", fleet.displayStatus(n.id) === "online" ? ACCENT[fleet.accent(n.id)]?.text : "text-fg-3")}>
                          {n.id}
                        </span>
                        <span className="truncate text-fg-4 pointer-coarse:hidden">{n.use.replace(/[`*]/g, "").split(/[;,]/)[0]}</span>
                        <span className="hidden truncate text-[13px] text-fg-4 pointer-coarse:inline">
                          {fleet.displayStatus(n.id) === "online" ? `CPU ${Math.round(fleet.states[n.id]?.metrics?.cpu ?? 0)}%` : "offline"}
                        </span>
                      </Item>
                    ))}
                  </Command.Group>

                  <Command.Group heading="Actions">
                    <Item value="run command fleet broadcast" icon={Play} onSelect={() => run(() => actions.run())}>
                      Run command…
                    </Item>
                    <Item value="update all machines upgrade" icon={CloudDownload} onSelect={() => run(() => actions.update([]))}>
                      Update machines…
                    </Item>
                    <Item
                      className="pointer-coarse:hidden"
                      value="toggle terminal panel"
                      icon={SquareTerminal}
                      hint={
                        <span className="flex gap-1 pointer-coarse:hidden">
                          <Kbd>Ctrl</Kbd>
                          <Kbd>`</Kbd>
                        </span>
                      }
                      onSelect={() => run(() => term.setDock(term.dock === "closed" ? "open" : "closed"))}
                    >
                      Toggle terminal
                    </Item>
                    <Item value="add machine new computer server inventory" icon={Plus} onSelect={() => run(actions.addMachine)}>
                      Add machine…
                    </Item>
                    <Item value="claude skill download install inventory" icon={Puzzle} onSelect={() => run(() => router.push("/skill"))}>
                      Claude skill
                    </Item>
                    <Item value="add device phone pair qr" icon={Smartphone} onSelect={() => run(actions.devices)}>
                      Add a device…
                    </Item>
                    <Item value="account login password two-factor 2fa totp authenticator username" icon={UserRound} onSelect={() => run(actions.account)}>
                      Account…
                    </Item>
                  </Command.Group>

                  <Command.Group heading="Go to">
                    <Item value="overview dashboard home" icon={LayoutGrid} onSelect={() => run(() => router.push("/"))}>
                      Overview
                    </Item>
                    <Item value="network subnets addresses gateway lan vlan map" icon={Waypoints} onSelect={() => run(() => router.push("/network"))}>
                      Network
                    </Item>
                    <Item value="activity sessions history" icon={Activity} onSelect={() => run(() => router.push("/activity"))}>
                      Activity
                    </Item>
                    <Item value="ai proxy cliproxyapi gateway endpoint" icon={Network} onSelect={() => run(() => router.push("/proxy"))}>
                      AI proxy
                    </Item>
                    <Item value="proxy accounts subscriptions sign in login claude codex oauth" icon={Users} onSelect={() => run(() => router.push("/proxy/accounts"))}>
                      AI proxy: accounts
                    </Item>
                    <Item value="proxy api keys tokens" icon={KeyRound} onSelect={() => run(() => router.push("/proxy/keys"))}>
                      AI proxy: API keys
                    </Item>
                    <Item value="proxy models aliases" icon={Boxes} onSelect={() => run(() => router.push("/proxy/models"))}>
                      AI proxy: models
                    </Item>
                    <Item value="proxy usage tokens requests stats" icon={BarChart3} onSelect={() => run(() => router.push("/proxy/usage"))}>
                      AI proxy: usage
                    </Item>
                    <Item value="proxy traffic raw prompts answers requests clickhouse" icon={Waves} onSelect={() => run(() => router.push("/proxy/traffic"))}>
                      AI proxy: traffic
                    </Item>
                  </Command.Group>

                  {online.length > 0 && (
                    <Command.Group heading="Power & updates">
                      {online.map((n) => (
                        <Item key={`u${n.id}`} value={`update upgrade ${n.id}`} icon={CloudDownload} onSelect={() => run(() => actions.update(n.id))}>
                          Update <span className={clsx("font-mono", ACCENT[fleet.accent(n.id)]?.text)}>{n.id}</span>
                          {(fleet.updates[n.id]?.count ?? 0) > 0 && (
                            <span className="rounded-full bg-blue/12 px-1.5 text-[10.5px] font-semibold text-blue">{fleet.updates[n.id]!.count}</span>
                          )}
                        </Item>
                      ))}
                      {online.map((n) => (
                        <Item
                          key={`r${n.id}`}
                          value={`reboot restart ${n.id}`}
                          icon={RotateCw}
                          tone="warning"
                          onSelect={() => run(() => actions.power(n.id, "reboot"))}
                        >
                          Reboot <span className={clsx("font-mono", ACCENT[fleet.accent(n.id)]?.text)}>{n.id}</span>…
                        </Item>
                      ))}
                      {online.map((n) => (
                        <Item
                          key={`s${n.id}`}
                          value={`shutdown power off ${n.id}`}
                          icon={Power}
                          tone="danger"
                          onSelect={() => run(() => actions.power(n.id, "shutdown"))}
                        >
                          Shut down <span className={clsx("font-mono", ACCENT[fleet.accent(n.id)]?.text)}>{n.id}</span>…
                        </Item>
                      ))}
                    </Command.Group>
                  )}
                </Command.List>
                <div className="hidden h-9 items-center gap-4 border-t border-line-2 bg-void/40 px-4 text-[11px] text-fg-4 pointer-fine:flex">
                  <span className="flex items-center gap-1.5">
                    <Kbd>↑</Kbd>
                    <Kbd>↓</Kbd> navigate
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Kbd>↵</Kbd> select
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Kbd>Esc</Kbd> close
                  </span>
                </div>
              </Command>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </Ctx.Provider>
  );
}
