"use client";

import { useEffect, useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useTerminals } from "./terminal-provider";

export const TOKYO_NIGHT_XTERM = {
  background: "#13141c",
  foreground: "#c0caf5",
  cursor: "#c0caf5",
  cursorAccent: "#13141c",
  selectionBackground: "#33467c",
  selectionInactiveBackground: "#283457",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#ff899d",
  brightGreen: "#9fe044",
  brightYellow: "#faba4a",
  brightBlue: "#8db0ff",
  brightMagenta: "#c7a9ff",
  brightCyan: "#a4daff",
  brightWhite: "#c0caf5",
};

/** One xterm bound to one server-side PTY session. Stays mounted while hidden. */
export function TerminalView({ id, visible }: { id: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const { subscribe, send, size, applyMods, fontSize, setFontSize } = useTerminals();
  const fontRef = useRef(fontSize);
  const setFontSizeRef = useRef(setFontSize);
  useEffect(() => {
    setFontSizeRef.current = setFontSize;
  }, [setFontSize]);
  const visibleRef = useRef(visible);
  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    let disposed = false;
    let unsub: (() => void) | null = null;
    let ro: ResizeObserver | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/addon-web-links"),
      ]);
      if (disposed || !host.current) return;
      await document.fonts?.ready;
      const t = new Terminal({
        fontFamily: getComputedStyle(document.body).getPropertyValue("--font-mono") || "monospace",
        fontSize: fontRef.current,
        lineHeight: 1.25,
        letterSpacing: 0,
        cursorBlink: true,
        cursorStyle: "bar",
        cursorWidth: 2,
        scrollback: 10_000,
        allowProposedApi: true,
        theme: TOKYO_NIGHT_XTERM,
        macOptionIsMeta: true,
        smoothScrollDuration: 80,
      });
      const f = new FitAddon();
      t.loadAddon(f);
      t.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, "_blank", "noopener")));
      t.open(host.current);
      term.current = t;
      fit.current = f;

      t.onData((data) => send({ t: "input", id, data: applyMods(data) }));
      t.onResize(({ cols, rows }) => {
        size.current = { cols, rows };
        send({ t: "resize", id, cols, rows });
      });

      unsub = subscribe(id, (msg) => {
        if (msg.kind === "replay") {
          t.reset();
          t.write(msg.data);
        } else if (msg.kind === "data") {
          t.write(msg.data);
        } else if (msg.kind === "exit") {
          const ok = msg.code === 0;
          t.write(
            `\r\n\x1b[38;2;65;72;104m${"─".repeat(Math.max(8, Math.min(t.cols - 2, 60)))}\x1b[0m\r\n` +
              `\x1b[38;2;${ok ? "158;206;106" : "247;118;142"}m${ok ? "✓" : "✕"} process exited with code ${msg.code ?? "?"}\x1b[0m\r\n`,
          );
        }
      });

      const doFit = () => {
        if (!visibleRef.current || !host.current || host.current.clientWidth < 50) return;
        try {
          f.fit();
        } catch {
          /* not laid out yet */
        }
      };
      // Two-finger pinch changes the font size (phones have no ctrl+scroll).
      let pinch: { d: number; size: number } | null = null;
      const dist = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const el = host.current;
      el.addEventListener("touchstart", (e) => {
        if (e.touches.length === 2) pinch = { d: dist(e), size: fontRef.current };
      }, { passive: true });
      el.addEventListener("touchmove", (e) => {
        if (!pinch || e.touches.length !== 2) return;
        const next = Math.round(pinch.size * (dist(e) / pinch.d));
        if (next !== fontRef.current) setFontSizeRef.current(next);
      }, { passive: true });
      el.addEventListener("touchend", () => {
        pinch = null;
      });

      ro = new ResizeObserver(() => requestAnimationFrame(doFit));
      ro.observe(host.current);
      doFit();
      if (visibleRef.current) t.focus();
    })();

    return () => {
      disposed = true;
      unsub?.();
      ro?.disconnect();
      term.current?.dispose();
      term.current = null;
    };
  }, [id, send, subscribe, size, applyMods]);

  useEffect(() => {
    fontRef.current = fontSize;
    const t = term.current;
    if (!t || t.options.fontSize === fontSize) return;
    t.options.fontSize = fontSize;
    try {
      fit.current?.fit();
    } catch {
      /* ignore */
    }
  }, [fontSize]);

  useEffect(() => {
    if (!visible) return;
    const r = requestAnimationFrame(() => {
      try {
        fit.current?.fit();
      } catch {
        /* ignore */
      }
      term.current?.focus();
    });
    return () => cancelAnimationFrame(r);
  }, [visible]);

  return <div ref={host} data-term={id} className="h-full w-full" style={{ display: visible ? "block" : "none" }} />;
}
