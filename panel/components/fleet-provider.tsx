"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { AgentStatus, FleetNode, NodeState, Sample, UpdateInfo } from "@/lib/types";

export type { Sample };

/** Fired on window when the server says the inventory changed (see terminal-provider). */
export const FLEET_CHANGED_EVENT = "fleet:changed";

export type PowerKind = "reboot" | "shutdown";
interface PowerIntent {
  kind: PowerKind;
  at: number;
  sawOffline: boolean;
}

export type DisplayStatus = "online" | "offline" | "unknown" | "rebooting" | "shutting-down" | "powered-off";

interface FleetCtx {
  nodes: FleetNode[];
  states: Record<string, NodeState>;
  history: Record<string, Sample[]>;
  /** Each machine's fleet-agent: connected, version, out of date. */
  agents: Record<string, AgentStatus>;
  updates: Record<string, UpdateInfo | undefined>;
  updatesLoading: Record<string, boolean>;
  loaded: boolean;
  lastFetch: number | null;
  fetchError: string | null;
  refresh: () => void;
  /** Re-checks one machine immediately. */
  probe: (id: string) => Promise<void>;
  /** When the panel's server started (for "not seen since…"). */
  startedAt: number | null;
  refreshUpdates: (id?: string, force?: boolean) => Promise<void>;
  markPower: (id: string, kind: PowerKind) => void;
  displayStatus: (id: string) => DisplayStatus;
  accent: (id: string) => string;
}

const Ctx = createContext<FleetCtx | null>(null);

const POLL_MS = 3000;
// Identity colours avoid the status hues (green/yellow/orange/red) so a machine name never reads as a warning.
const ACCENTS = ["blue", "magenta", "cyan", "orange", "teal", "purple"];

export function FleetProvider({ children }: { children: React.ReactNode }) {
  const [nodes, setNodes] = useState<FleetNode[]>([]);
  const [states, setStates] = useState<Record<string, NodeState>>({});
  const [history, setHistory] = useState<Record<string, Sample[]>>({});
  const [agents, setAgents] = useState<Record<string, AgentStatus>>({});
  const [updates, setUpdates] = useState<Record<string, UpdateInfo | undefined>>({});
  const [updatesLoading, setUpdatesLoading] = useState<Record<string, boolean>>({});
  const [lastFetch, setLastFetch] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [power, setPower] = useState<Record<string, PowerIntent>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inflight = useRef(false);
  /** A poll was asked for while one was in flight; run another when it ends so we never miss a change. */
  const pollAgain = useRef(false);

  const refreshUpdates = useCallback(async (id?: string, force = false) => {
    if (!id) {
      setUpdatesLoading((l) => ({ ...l, __all: true }));
      try {
        const res = await fetch("/api/updates", { cache: "no-store" });
        if (res.ok) setUpdates(await res.json());
      } finally {
        setUpdatesLoading((l) => ({ ...l, __all: false }));
      }
      return;
    }
    setUpdatesLoading((l) => ({ ...l, [id]: true }));
    try {
      const res = await fetch(`/api/nodes/${id}/updates${force ? "?force=1" : ""}`, { cache: "no-store" });
      if (res.ok) {
        const info: UpdateInfo = await res.json();
        setUpdates((u) => ({ ...u, [id]: info }));
      }
    } finally {
      setUpdatesLoading((l) => ({ ...l, [id]: false }));
    }
  }, []);

  // Track power transitions (online → offline → online again) as poll results arrive.
  const powerRef = useRef<Record<string, PowerIntent>>({});
  const trackPower = useCallback(
    (list: FleetNode[], states: NodeState[]) => {
      const prev = powerRef.current;
      const next = { ...prev };
      let changed = false;
      for (const [id, intent] of Object.entries(prev)) {
        const s = states.find((x) => x.id === id);
        if (!s) continue;
        if (s.status === "offline" && !intent.sawOffline) {
          next[id] = { ...intent, sawOffline: true };
          changed = true;
        } else if (s.status === "online" && intent.sawOffline) {
          delete next[id];
          changed = true;
          const hint = rebootHint(list.find((n) => n.id === id));
          toast.success(`${id} is back online`, {
            description: hint?.text.replace(/\*\*/g, "") ?? `Came back after ${Math.round((Date.now() - intent.at) / 1000)}s.`,
            action: hint?.url ? { label: "Open", onClick: () => window.open(hint.url, "_blank", "noopener") } : undefined,
            duration: hint ? 20_000 : 6000,
          });
          refreshUpdates(id, true);
        } else if (intent.kind === "reboot" && Date.now() - intent.at > 15 * 60_000) {
          delete next[id];
          changed = true;
        }
      }
      if (changed) {
        powerRef.current = next;
        setPower(next);
      }
    },
    [refreshUpdates],
  );

  const fetchOnce = useCallback(async () => {
    try {
      const res = await fetch("/api/fleet", { cache: "no-store" });
      if (res.status === 401) {
        window.location.replace(`/login?next=${encodeURIComponent(location.pathname)}`);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: {
        nodes: FleetNode[];
        states: NodeState[];
        history: Record<string, Sample[]>;
        agents?: Record<string, AgentStatus>;
        at: number;
        startedAt: number;
      } = await res.json();
      setNodes(data.nodes);
      setStartedAt(data.startedAt);
      setStates(Object.fromEntries(data.states.map((s) => [s.id, s])));
      trackPower(data.nodes, data.states);
      // The server keeps the sample history, so charts survive reloads.
      setHistory(data.history);
      setAgents(data.agents ?? {});
      setLastFetch(Date.now());
      setFetchError(null);
    } catch (err) {
      setFetchError((err as Error).message);
    }
  }, [trackPower]);

  const poll = useCallback(async () => {
    if (inflight.current) {
      pollAgain.current = true;
      return;
    }
    inflight.current = true;
    try {
      do {
        pollAgain.current = false;
        await fetchOnce();
      } while (pollAgain.current);
    } finally {
      inflight.current = false;
    }
  }, [fetchOnce]);

  useEffect(() => {
    let stopped = false;
    const loop = async () => {
      if (!document.hidden) await poll();
      if (!stopped) timer.current = setTimeout(loop, POLL_MS);
    };
    loop();
    const onVis = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", onVis);
    // The inventory changed (an edit, a new machine, a fresh index): re-fetch now.
    const onFleetChanged = () => poll();
    window.addEventListener(FLEET_CHANGED_EVENT, onFleetChanged);
    return () => {
      stopped = true;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener(FLEET_CHANGED_EVENT, onFleetChanged);
    };
  }, [poll]);

  useEffect(() => {
    const first = setTimeout(() => refreshUpdates(), 0);
    const t = setInterval(() => refreshUpdates(), 15 * 60_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [refreshUpdates]);

  const probe = useCallback(async (id: string) => {
    const res = await fetch(`/api/nodes/${id}/probe`, { cache: "no-store" });
    if (res.ok) {
      const s: NodeState = await res.json();
      setStates((prev) => ({ ...prev, [id]: s }));
    }
  }, []);

  const markPower = useCallback((id: string, kind: PowerKind) => {
    powerRef.current = { ...powerRef.current, [id]: { kind, at: Date.now(), sawOffline: false } };
    setPower(powerRef.current);
  }, []);

  const displayStatus = useCallback(
    (id: string): DisplayStatus => {
      const s = states[id];
      const intent = power[id];
      if (intent) {
        if (intent.kind === "shutdown") return s?.status === "offline" ? "powered-off" : "shutting-down";
        return "rebooting";
      }
      return s?.status ?? "unknown";
    },
    [states, power],
  );

  const accent = useCallback(
    (id: string) => {
      const i = nodes.findIndex((n) => n.id === id);
      return ACCENTS[(i < 0 ? 0 : i) % ACCENTS.length];
    },
    [nodes],
  );

  const value = useMemo<FleetCtx>(
    () => ({
      nodes,
      states,
      history,
      agents,
      updates,
      updatesLoading,
      loaded: lastFetch !== null,
      lastFetch,
      fetchError,
      refresh: poll,
      probe,
      startedAt,
      refreshUpdates,
      markPower,
      displayStatus,
      accent,
    }),
    [nodes, states, history, agents, updates, updatesLoading, lastFetch, fetchError, poll, probe, startedAt, refreshUpdates, markPower, displayStatus, accent],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFleet() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFleet outside FleetProvider");
  return ctx;
}

/** Finds a sentence in the machine's notes that applies after a reboot (e.g. "unlock it at http://… after a restart"). */
export function rebootHint(node: FleetNode | undefined): { text: string; url?: string } | null {
  if (!node) return null;
  const sentence = node.notes
    .replace(/\*\*|`/g, "")
    .split(/(?<=[.!])\s+/)
    .find((x) => /\b(restart|reboot)/i.test(x) && /unlock|manual|after/i.test(x));
  return sentence ? { text: sentence, url: sentence.match(/https?:\/\/[^\s)]+/)?.[0] } : null;
}
