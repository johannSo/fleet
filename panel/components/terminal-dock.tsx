"use client";

import clsx from "clsx";
import {
  ChevronDown,
  ChevronUp,
  Maximize2,
  Minimize2,
  Plus,
  RotateCw,
  Square,
  SquareTerminal,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { useActions } from "./actions";
import { useFleet } from "./fleet-provider";
import { useTerminals } from "./terminal-provider";
import { ExtraKeys } from "./extra-keys";
import { useIsMobile, useVisualViewport } from "./hooks";
import { TerminalView } from "./terminal-view";
import { ACCENT, Button, IconButton, Kbd, Menu, StatusDot, Tooltip } from "./ui";

const ACTION_ICON: Partial<Record<SessionInfo["action"], string>> = {
  update: "↑",
  reboot: "↻",
  shutdown: "⏻",
  logs: "≡",
  exec: "❯",
};

function TabDot({ s }: { s: SessionInfo }) {
  if (!s.exited) return <StatusDot status="online" size={6} />;
  return <span className={clsx("size-1.5 shrink-0 rounded-full", s.exitCode === 0 ? "bg-fg-4" : "bg-red")} />;
}

export function TerminalDock() {
  const t = useTerminals();
  const fleet = useFleet();
  const actions = useActions();
  const [mounted, setMounted] = useState(false);
  const [dragging, setDragging] = useState(false);
  const tabsRef = useRef<HTMLDivElement>(null);

  const open = t.dock !== "closed";
  const mobile = useIsMobile();
  const vv = useVisualViewport();
  const keyboardUp = mobile && typeof window !== "undefined" && vv.height > 0 && window.innerHeight - vv.height > 120;
  const active = t.sessions.find((s) => s.id === t.activeId) ?? null;
  // Terminals mount the first time the dock opens, then stay mounted.
  if (open && !mounted) setMounted(true);

  // Ctrl+` toggles the dock, like an editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && (e.key === "`" || e.code === "Backquote")) {
        e.preventDefault();
        t.setDock(t.dock === "closed" ? "open" : "closed");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [t]);

  // keep active tab scrolled into view
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>(`[data-id="${t.activeId}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [t.activeId]);

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = t.dockHeight;
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const h = Math.max(180, Math.min(window.innerHeight - 160, startH + (startY - ev.clientY)));
      t.setDockHeight(h);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const running = t.sessions.filter((s) => !s.exited).length;
  const shellItems = fleet.nodes.map((n) => ({
    label: n.id,
    icon: TerminalSquare,
    hint: fleet.displayStatus(n.id) === "online" ? (n.local ? "local" : (n.sshCommand ?? "")) : "offline",
    disabled: fleet.displayStatus(n.id) !== "online",
    onSelect: () => actions.shell(n.id),
  }));

  return (
    <section
      aria-label="Terminal"
      className={clsx(
        mobile
          ? clsx("fixed inset-x-0 z-[70] flex-col bg-[#13141c] pt-[env(safe-area-inset-top)]", open ? "flex animate-fade-up" : "hidden")
          : "relative z-20 flex shrink-0 flex-col border-t border-line-2 bg-[#13141c] shadow-[0_-10px_30px_-10px_rgba(0,0,0,0.6)]",
        !mobile && !dragging && "transition-[height] duration-200 ease-out",
        !mobile && t.dock === "max" && "absolute inset-0 border-t-0",
      )}
      style={
        mobile
          ? { top: vv.top, height: vv.height || "100dvh" }
          : { height: t.dock === "closed" ? 40 : t.dock === "max" ? undefined : t.dockHeight }
      }
    >
      {mobile && (
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-1.5">
          <button
            onClick={() => t.setDock("closed")}
            aria-label="Close terminal"
            className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full text-fg-3 active:bg-hl"
          >
            <ChevronDown size={22} />
          </button>
          <div ref={tabsRef} className="rail flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" role="tablist">
            {t.sessions.length === 0 && <span className="px-1 text-[14px] font-semibold text-fg-2">Terminal</span>}
            {t.sessions.map((s, idx) => {
              const a = ACCENT[fleet.accent(s.node)] ?? ACCENT.blue;
              const isActive = s.id === t.activeId;
              const dup = t.sessions.slice(0, idx).filter((x) => x.node === s.node && x.title === s.title).length;
              return (
                <button
                  key={s.id}
                  data-id={s.id}
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => t.setActive(s.id)}
                  className={clsx(
                    "flex h-9 max-w-[190px] shrink-0 cursor-pointer items-center gap-1.5 rounded-full pr-1 pl-3.5 text-[13.5px]",
                    isActive ? "bg-hl text-fg ring-1 ring-line-3 ring-inset" : "text-fg-3",
                  )}
                >
                  <TabDot s={s} />
                  <span className={clsx("font-mono font-semibold", a.text)}>{s.node}</span>
                  <span className="truncate">
                    {s.title}
                    {dup > 0 && ` ${dup + 1}`}
                  </span>
                  <span
                    role="button"
                    aria-label={`Close ${s.node} ${s.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      t.close(s.id);
                    }}
                    className={clsx("-my-2 -mr-1 grid size-10 place-items-center rounded-full text-fg-4 active:bg-line-3", !isActive && "hidden")}
                  >
                    <X size={13} />
                  </span>
                </button>
              );
            })}
          </div>
          <Menu
            items={shellItems}
            trigger={(p) => (
              <button {...p} aria-label="New shell" className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-full text-blue active:bg-hl">
                <Plus size={22} />
              </button>
            )}
          />
        </div>
      )}
      {!mobile && t.dock === "open" && (
        <div
          onPointerDown={startDrag}
          className="group absolute -top-1.5 right-0 left-0 z-10 h-3 cursor-row-resize"
          aria-hidden
        >
          <div className={clsx("mx-auto mt-[3px] h-[2px] w-full transition-colors", dragging ? "bg-blue/60" : "group-hover:bg-blue/40")} />
          <div className="absolute top-[3px] left-1/2 h-[4px] w-14 -translate-x-1/2 rounded-full bg-line-3 opacity-80 transition-[opacity,background] group-hover:bg-blue/70 group-hover:opacity-100" />
        </div>
      )}

      {/* header */}
      <div className={clsx("h-10 shrink-0 items-center gap-1 border-b border-line/70 pr-2 pl-1.5", mobile ? "hidden" : "flex")}>
        <button
          onClick={() => t.setDock(open ? "closed" : "open")}
          className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-[12px] font-semibold text-fg-2 hover:bg-hover"
          aria-expanded={open}
        >
          <SquareTerminal size={14} className="text-blue" />
          Terminal
          {t.sessions.length > 0 && (
            <Tooltip content={`${running} running · ${t.sessions.length - running} finished`}>
              <span className="flex items-center gap-1 rounded-full bg-hl px-1.5 text-[10.5px] font-semibold text-fg-3 tabular">
                {running > 0 && <span className="size-1.5 rounded-full bg-green" />}
                {t.sessions.length}
              </span>
            </Tooltip>
          )}
        </button>

        <div className="mx-1 h-4 w-px bg-line-2" />

        <div ref={tabsRef} className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]" role="tablist">
          {t.sessions.map((s, idx) => {
            const a = ACCENT[fleet.accent(s.node)] ?? ACCENT.blue;
            const isActive = s.id === t.activeId;
            // number repeated titles on the same machine: "shell", "shell 2", …
            const dup = t.sessions.slice(0, idx).filter((x) => x.node === s.node && x.title === s.title).length;
            return (
              <div
                key={s.id}
                data-id={s.id}
                role="tab"
                aria-selected={isActive}
                tabIndex={0}
                onClick={() => {
                  t.setActive(s.id);
                  if (!open) t.setDock("open");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") t.setActive(s.id);
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) t.close(s.id);
                }}
                className={clsx(
                  "group relative flex h-7 max-w-[220px] shrink-0 cursor-pointer items-center gap-2 rounded-md pr-1 pl-2.5 text-[12px] transition-colors",
                  isActive && open ? "bg-hl text-fg" : "text-fg-3 hover:bg-hover/70 hover:text-fg-2",
                )}
              >
                {isActive && open && <span className={clsx("absolute inset-x-2 -bottom-[7px] h-[2px] rounded-full", a.bg)} />}
                <TabDot s={s} />
                <span className={clsx("font-mono font-semibold", a.text)}>{s.node}</span>
                <span className="truncate">
                  {ACTION_ICON[s.action] && <span className="mr-1 text-fg-4">{ACTION_ICON[s.action]}</span>}
                  {s.title}
                  {dup > 0 && <span className="ml-1 text-fg-4">{dup + 1}</span>}
                </span>
                <button
                  aria-label={`Close ${s.node} ${s.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    t.close(s.id);
                  }}
                  className={clsx(
                    "grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-4 group-hover:opacity-100 hover:bg-line-3/60 hover:text-fg focus:opacity-100",
                    isActive && open ? "opacity-100" : "opacity-0",
                  )}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 pl-1">
          <Menu items={shellItems} trigger={(p) => <IconButton icon={Plus} label="New shell" size={30} {...p} />} />
          {open && (
            <IconButton
              size={30}
              icon={t.dock === "max" ? Minimize2 : Maximize2}
              label={t.dock === "max" ? "Restore" : "Maximize"}
              onClick={() => t.setDock(t.dock === "max" ? "open" : "max")}
            />
          )}
          <IconButton
            size={30}
            icon={open ? ChevronDown : ChevronUp}
            label={open ? "Hide terminal (Ctrl+`)" : "Show terminal (Ctrl+`)"}
            onClick={() => t.setDock(open ? "closed" : "open")}
          />
        </div>
      </div>

      {/* body */}
      {mounted && (
        <div className={clsx("relative min-h-0 flex-1", !open && "hidden")}>
          {t.sessions.map((s) => (
            <div key={s.id} className={clsx("absolute inset-0 flex flex-col", s.id !== t.activeId && "invisible")}>
              <div className="min-h-0 flex-1">
                <TerminalView id={s.id} visible={open && s.id === t.activeId} />
              </div>
              {s.exited && <ExitBar s={s} />}
              {!s.exited && s.action !== "shell" && (
                <div className="flex h-8 shrink-0 items-center gap-2 border-t border-line/70 px-3 text-[11.5px] text-fg-4">
                  <span className="truncate font-mono">{s.command.split("\n")[0]}</span>
                  <Button size="xs" variant="ghost" icon={Square} className="ml-auto" onClick={() => t.kill(s.id)}>
                    Stop
                  </Button>
                </div>
              )}
            </div>
          ))}
          {t.sessions.length === 0 && <EmptyDock />}
        </div>
      )}
      {mobile && open && active && !active.exited && <ExtraKeys id={active.id} />}
      {mobile && open && !keyboardUp && <div className="shrink-0 bg-[#101118] pb-[env(safe-area-inset-bottom)]" />}
    </section>
  );
}

function ExitBar({ s }: { s: SessionInfo }) {
  const t = useTerminals();
  const ok = s.exitCode === 0;
  return (
    <div
      className={clsx(
        "flex h-9 shrink-0 items-center gap-2 border-t px-3 text-[12px]",
        ok ? "border-line/70 text-fg-3" : "border-red/20 bg-red/[0.04] text-red",
      )}
    >
      <span className={clsx("size-1.5 rounded-full", ok ? "bg-green" : "bg-red")} />
      {s.action === "shell" ? "Shell closed" : ok ? "Finished" : `Exited with code ${s.exitCode}`}
      <span className="text-fg-5">·</span>
      <span className="truncate font-mono text-fg-4">{s.node}</span>
      <div className="ml-auto flex items-center gap-1">
        <Button size="xs" variant="ghost" icon={RotateCw} onClick={() => t.open(s.spec)}>
          {s.action === "shell" ? "Reconnect" : "Run again"}
        </Button>
        <Button size="xs" variant="ghost" icon={X} onClick={() => t.close(s.id)}>
          Close
        </Button>
      </div>
    </div>
  );
}

function EmptyDock() {
  const fleet = useFleet();
  const actions = useActions();
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="text-center">
        <div className="mx-auto mb-3 grid size-10 place-items-center rounded-xl bg-blue/10 text-blue ring-1 ring-blue/25">
          <SquareTerminal size={18} />
        </div>
        <div className="text-[13px] font-medium text-fg-2">No open sessions</div>
        <div className="mt-1 mb-4 text-[12px] text-fg-4">
          Open a shell on a machine — sessions keep running if you reload the page.
        </div>
        <div className="flex flex-wrap justify-center gap-1.5">
          {fleet.nodes.map((n) => {
            const a = ACCENT[fleet.accent(n.id)];
            const st = fleet.displayStatus(n.id);
            return (
              <button
                key={n.id}
                disabled={st !== "online"}
                onClick={() => actions.shell(n.id)}
                className={clsx(
                  "inline-flex h-8 cursor-pointer items-center gap-2 rounded-md bg-raised px-3 font-mono text-[12.5px] ring-1 ring-line-2 transition-colors ring-inset hover:bg-hover hover:ring-line-3 disabled:cursor-not-allowed disabled:opacity-40",
                  a.text,
                )}
              >
                <StatusDot status={st} size={6} />
                {n.id}
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-fg-5">
          <Kbd>Ctrl</Kbd>
          <Kbd>`</Kbd>
          toggles this panel
        </div>
      </div>
    </div>
  );
}
