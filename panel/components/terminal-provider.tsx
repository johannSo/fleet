"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { ActivityEvent } from "@/lib/activity-types";
import { FLEET_CHANGED_EVENT } from "./fleet-provider";
import type { ClientMsg, ServerMsg, SessionInfo, SessionSpec } from "@/lib/types";

type Listener = (msg: { kind: "data" | "replay"; data: string } | { kind: "exit"; code: number | null }) => void;

export type DockMode = "closed" | "open" | "max";

interface TermCtx {
  sessions: SessionInfo[];
  activeId: string | null;
  setActive: (id: string | null) => void;
  connected: boolean;
  dock: DockMode;
  setDock: (m: DockMode) => void;
  dockHeight: number;
  setDockHeight: (h: number) => void;
  open: (spec: SessionSpec, opts?: { focus?: boolean }) => Promise<SessionInfo | null>;
  send: (msg: ClientMsg) => void;
  subscribe: (id: string, fn: Listener) => () => void;
  close: (id: string) => void;
  kill: (id: string) => void;
  /** Most recent size reported by a mounted terminal, used for new sessions. */
  size: React.RefObject<{ cols: number; rows: number }>;
  /** Sticky Ctrl/Alt from the on-screen key row (phones have no modifier keys). */
  mods: { ctrl: boolean; alt: boolean };
  setMods: (m: { ctrl: boolean; alt: boolean }) => void;
  /** Applies and clears sticky modifiers for one chunk of typed input. */
  applyMods: (data: string) => string;
  fontSize: number;
  setFontSize: (n: number) => void;
  /** Live activity-log events (new rows and changes to existing ones). */
  onActivity: (fn: (e: ActivityEvent) => void) => () => void;
}

const Ctx = createContext<TermCtx | null>(null);

/** Fired on window when the AI proxy reports a change (new requests, accounts, settings). */
export const PROXY_CHANGED_EVENT = "proxy:changed";

function readStored<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function TerminalProvider({ children }: { children: React.ReactNode }) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [chosenId, setActiveId] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [mods, setModsState] = useState({ ctrl: false, alt: false });
  const modsRef = useRef(mods);
  const setMods = useCallback((m: { ctrl: boolean; alt: boolean }) => {
    modsRef.current = m;
    setModsState(m);
  }, []);
  const applyMods = useCallback(
    (data: string) => {
      const m = modsRef.current;
      if (!m.ctrl && !m.alt) return data;
      let out = data;
      if (m.ctrl && data.length === 1) {
        const c = data.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) out = String.fromCharCode(c - 96);
        else if (data === "[") out = "\x1b";
        else if (data === " " || data === "@") out = "\x00";
        else if (data === "\\") out = "\x1c";
      }
      if (m.alt) out = "\x1b" + out;
      setMods({ ctrl: false, alt: false });
      return out;
    },
    [setMods],
  );
  const [fontSize, setFontSizeState] = useState(() =>
    typeof window === "undefined" ? 13 : readStored("fleet.fontSize", window.innerWidth < 768 ? 12 : 13),
  );
  const setFontSize = useCallback((n: number) => {
    const v = Math.max(9, Math.min(20, n));
    setFontSizeState(v);
    try {
      localStorage.setItem("fleet.fontSize", JSON.stringify(v));
    } catch {
      /* ignore */
    }
  }, []);
  const [dock, setDockState] = useState<DockMode>("closed");
  // The dock is closed on first render, so reading storage here can't cause a visible hydration mismatch.
  const [dockHeight, setDockHeightState] = useState(() =>
    typeof window === "undefined" ? 360 : readStored("fleet.dockHeight", 360),
  );
  const ws = useRef<WebSocket | null>(null);
  const listeners = useRef(new Map<string, Set<Listener>>());
  const pending = useRef(new Map<string, { resolve: (s: SessionInfo | null) => void }>());
  const attached = useRef(new Set<string>());
  const size = useRef({ cols: 120, rows: 24 });
  const queue = useRef<ClientMsg[]>([]);
  const activityListeners = useRef(new Set<(e: ActivityEvent) => void>());
  const onActivity = useCallback((fn: (e: ActivityEvent) => void) => {
    activityListeners.current.add(fn);
    return () => void activityListeners.current.delete(fn);
  }, []);

  const setDock = useCallback((m: DockMode) => setDockState(m), []);
  const setDockHeight = useCallback((h: number) => {
    setDockHeightState(h);
    try {
      localStorage.setItem("fleet.dockHeight", JSON.stringify(h));
    } catch {
      /* ignore */
    }
  }, []);

  const send = useCallback((msg: ClientMsg) => {
    const sock = ws.current;
    if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
    else queue.current.push(msg);
  }, []);

  const emit = useCallback((id: string, payload: Parameters<Listener>[0]) => {
    listeners.current.get(id)?.forEach((fn) => fn(payload));
  }, []);

  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${location.host}/ws`);
      ws.current = sock;
      sock.onopen = () => {
        retry = 0;
        setConnected(true);
        // Re-attach everything we were showing (server keeps sessions alive).
        attached.current.clear();
        for (const id of listeners.current.keys()) {
          attached.current.add(id);
          sock.send(JSON.stringify({ t: "attach", id } satisfies ClientMsg));
        }
        for (const m of queue.current.splice(0)) sock.send(JSON.stringify(m));
      };
      sock.onmessage = (ev) => {
        const msg: ServerMsg = JSON.parse(ev.data);
        switch (msg.t) {
          case "sessions": {
            setSessions(msg.list);
            break;
          }
          case "created": {
            attached.current.add(msg.session.id);
            pending.current.get(msg.nonce)?.resolve(msg.session);
            pending.current.delete(msg.nonce);
            break;
          }
          case "error": {
            toast.error("Couldn't start session", { description: msg.message });
            if (msg.nonce) {
              pending.current.get(msg.nonce)?.resolve(null);
              pending.current.delete(msg.nonce);
            }
            break;
          }
          case "data":
            emit(msg.id, { kind: "data", data: msg.data });
            break;
          case "replay":
            emit(msg.id, { kind: "replay", data: msg.data });
            break;
          case "exit":
            emit(msg.id, { kind: "exit", code: msg.code });
            break;
          case "fleet":
            // FleetProvider re-fetches /api/fleet on this.
            window.dispatchEvent(new Event(FLEET_CHANGED_EVENT));
            break;
          case "activity":
            activityListeners.current.forEach((fn) => fn(msg.event));
            break;
          case "proxy":
            // The Proxy pages re-fetch on this.
            window.dispatchEvent(new Event(PROXY_CHANGED_EVENT));
            break;
        }
      };
      sock.onclose = () => {
        setConnected(false);
        if (stopped) return;
        // A refused upgrade usually means the session was revoked: check before retrying.
        if (retry >= 2)
          fetch("/api/auth/me")
            .then((r) => r.json())
            .then((me) => {
              if (!me.authed) window.location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
            })
            .catch(() => {});
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, 300 * 2 ** retry);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws.current?.close();
    };
  }, [emit]);

  // Fall back to the newest session when the chosen tab goes away.
  const activeId =
    chosenId && sessions.some((s) => s.id === chosenId) ? chosenId : (sessions[sessions.length - 1]?.id ?? null);

  const subscribe = useCallback(
    (id: string, fn: Listener) => {
      let set = listeners.current.get(id);
      if (!set) listeners.current.set(id, (set = new Set()));
      set.add(fn);
      // Every new view asks for the scrollback; the replay resets the view, so
      // live chunks that raced ahead of it aren't duplicated.
      attached.current.add(id);
      send({ t: "attach", id });
      return () => {
        set!.delete(fn);
        if (set!.size === 0) listeners.current.delete(id);
      };
    },
    [send],
  );

  const open = useCallback(
    (spec: SessionSpec, opts: { focus?: boolean } = {}) => {
      const nonce = Math.random().toString(36).slice(2);
      return new Promise<SessionInfo | null>((resolve) => {
        pending.current.set(nonce, {
          resolve: (s) => {
            if (s && opts.focus !== false) {
              setActiveId(s.id);
              setDockState((d) => (d === "closed" ? "open" : d));
            }
            resolve(s);
          },
        });
        send({ t: "create", spec, cols: size.current.cols, rows: size.current.rows, nonce });
      });
    },
    [send],
  );

  const close = useCallback((id: string) => send({ t: "close", id }), [send]);
  const kill = useCallback((id: string) => send({ t: "kill", id }), [send]);

  const value = useMemo<TermCtx>(
    () => ({
      sessions,
      activeId,
      setActive: setActiveId,
      connected,
      dock,
      setDock,
      dockHeight,
      setDockHeight,
      open,
      send,
      subscribe,
      close,
      kill,
      size,
      mods,
      setMods,
      applyMods,
      fontSize,
      setFontSize,
      onActivity,
    }),
    [sessions, activeId, connected, dock, setDock, dockHeight, setDockHeight, open, send, subscribe, close, kill, mods, setMods, applyMods, fontSize, setFontSize, onActivity],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTerminals() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTerminals outside TerminalProvider");
  return ctx;
}
