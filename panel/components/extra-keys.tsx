"use client";

import clsx from "clsx";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, Keyboard } from "lucide-react";
import { useRef, useState } from "react";
import { useTerminals } from "./terminal-provider";

type Key =
  | { label: React.ReactNode; aria: string; seq: string; repeat?: boolean; wide?: boolean }
  | { label: React.ReactNode; aria: string; mod: "ctrl" | "alt" }
  | { label: React.ReactNode; aria: string; action: "paste" | "keyboard" };

const KEYS: Key[] = [
  { label: <Keyboard size={17} />, aria: "Show or hide keyboard", action: "keyboard" },
  { label: "esc", aria: "Escape", seq: "\x1b" },
  { label: "ctrl", aria: "Control (sticky)", mod: "ctrl" },
  { label: "alt", aria: "Alt (sticky)", mod: "alt" },
  { label: "tab", aria: "Tab", seq: "\t" },
  { label: <ArrowLeft size={16} />, aria: "Left", seq: "\x1b[D", repeat: true },
  { label: <ArrowUp size={16} />, aria: "Up", seq: "\x1b[A", repeat: true },
  { label: <ArrowDown size={16} />, aria: "Down", seq: "\x1b[B", repeat: true },
  { label: <ArrowRight size={16} />, aria: "Right", seq: "\x1b[C", repeat: true },
  { label: "|", aria: "Pipe", seq: "|" },
  { label: "~", aria: "Tilde", seq: "~" },
  { label: "/", aria: "Slash", seq: "/" },
  { label: "-", aria: "Dash", seq: "-" },
  { label: "home", aria: "Home", seq: "\x1b[H" },
  { label: "end", aria: "End", seq: "\x1b[F" },
  { label: "pgup", aria: "Page up", seq: "\x1b[5~", repeat: true },
  { label: "pgdn", aria: "Page down", seq: "\x1b[6~", repeat: true },
  { label: "^C", aria: "Control-C", seq: "\x03" },
  { label: <ClipboardPaste size={16} />, aria: "Paste", action: "paste" },
];

/**
 * The keys a phone keyboard lacks, Termux-style. Buttons never take focus,
 * so the on-screen keyboard stays up while you tap them.
 */
export function ExtraKeys({ id }: { id: string | null }) {
  const t = useTerminals();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [page, setPage] = useState(0);

  const textarea = () => (id ? document.querySelector<HTMLTextAreaElement>(`[data-term="${id}"] textarea`) : null);
  const send = (data: string) => id && t.send({ t: "input", id, data: t.applyMods(data) });

  // Fire on release, so swiping the row to scroll it doesn't press the key you started on.
  // Repeating keys (arrows, page up/down) also auto-repeat while held.
  const down = useRef<{ x: number; y: number; fired: boolean } | null>(null);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const press = async (k: Key) => {
    navigator.vibrate?.(8);
    if ("mod" in k) {
      t.setMods({ ...t.mods, [k.mod]: !t.mods[k.mod] });
      return;
    }
    if ("action" in k) {
      const ta = textarea();
      if (k.action === "keyboard") {
        if (ta && document.activeElement === ta) ta.blur();
        else ta?.focus();
      } else {
        try {
          const text = await navigator.clipboard.readText();
          if (text && id) t.send({ t: "input", id, data: text });
        } catch {
          /* clipboard needs HTTPS and permission */
        }
      }
      return;
    }
    send(k.seq);
  };

  const onDown = (e: React.PointerEvent, k: Key) => {
    e.preventDefault();
    down.current = { x: e.clientX, y: e.clientY, fired: false };
    if ("seq" in k && k.repeat) {
      const again = (delay: number) => {
        timer.current = setTimeout(() => {
          if (!down.current) return;
          down.current.fired = true;
          send(k.seq);
          again(60);
        }, delay);
      };
      again(380);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = down.current;
    if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) {
      down.current = null;
      stop();
    }
  };
  const onUp = (k: Key) => {
    stop();
    if (down.current && !down.current.fired) press(k);
    down.current = null;
  };

  const key = (k: Key, i: number) => {
    const on = "mod" in k && t.mods[k.mod];
    return (
      <button
        key={i}
        aria-label={k.aria}
        aria-pressed={"mod" in k ? on : undefined}
        onPointerDown={(e) => onDown(e, k)}
        onPointerMove={onMove}
        onPointerUp={() => onUp(k)}
        onPointerCancel={() => {
          down.current = null;
          stop();
        }}
        onContextMenu={(e) => e.preventDefault()}
        className={clsx(
          "grid h-11 min-w-0 cursor-pointer place-items-center rounded-xl font-mono text-[13.5px] transition-colors select-none active:scale-95",
          on ? "bg-blue text-[#11131c]" : "bg-hl/70 text-fg-2 active:bg-line-3",
        )}
      >
        {k.label}
      </button>
    );
  };

  // Page 1 (always fully visible): keyboard, esc, ctrl, alt, tab and all four arrows.
  // Swipe left for page 2: symbols, home/end, page up/down, paste.
  const pages = [KEYS.slice(0, 9), KEYS.slice(9)];
  return (
    <div className="shrink-0 border-t border-line bg-[#101118]">
      <div className="flex justify-center gap-1 pt-1.5" aria-hidden>
        {pages.map((_, i) => (
          <span key={i} className={clsx("size-[5px] rounded-full transition-colors", page === i ? "bg-blue" : "bg-line-3")} />
        ))}
      </div>
      <div
        className="rail flex snap-x snap-mandatory overflow-x-auto"
        role="toolbar"
        aria-label="Extra keys"
        onScroll={(e) => {
          const el = e.currentTarget;
          const p = Math.round(el.scrollLeft / el.clientWidth);
          if (p !== page) {
            setPage(p);
            navigator.vibrate?.(6);
          }
        }}
      >
        {pages.map((pg, pi) => (
          <div key={pi} className="grid w-full shrink-0 snap-start gap-1 px-1.5 pt-1 pb-1.5" style={{ gridTemplateColumns: `repeat(${pg.length}, minmax(0, 1fr))` }}>
            {pg.map((k, i) => key(k, pi * 100 + i))}
          </div>
        ))}
      </div>
    </div>
  );
}
