/**
 * fleet-agent connections (docs/SERVER_AGENT.md). An agent opens /ws/agent
 * (server.ts → lib/agent-server.ts) and pushes its collectors' output; this
 * module keeps the live connections, asks an agent to run a collector now, and
 * falls back to ssh when there is no agent or it doesn't answer.
 *
 * Next's route handlers (through lib/state.ts) and server.ts import separate
 * copies of this module, so the connections live on globalThis. It must not
 * import lib/audit.ts.
 */
import { agentRelease, COLLECTOR_TIMEOUT, collectorScript, goArch, type CollectorKind } from "./collectors";
import { runScript, type ExecResult } from "./ssh";
import type { AgentStatus, FleetNode, ReportVia } from "./types";

/** One collector's output, as the agent sent it. */
export interface AgentReport {
  kind: CollectorKind;
  /** When it ran, in the panel's clock (corrected for the agent's skew). */
  at: number;
  out: string;
  code: number;
  ms: number;
  err?: string;
  timedOut?: boolean;
}

export type PanelMsg =
  | { t: "config"; probeMs: number }
  | { t: "collect"; req: string; kind: CollectorKind }
  | { t: "update"; build: string; url: string; sha256: string };

export interface AgentConn {
  /** The machine's id in the inventory (from its token, not from what the agent says). */
  id: string;
  version: string;
  build: string;
  arch: string;
  hostname: string;
  connectedAt: number;
  /** Panel clock minus agent clock, in ms. */
  skew: number;
  /** WebSocket round-trip of the last ping, in ms. */
  rtt: number | null;
  /** When each kind of report last arrived (panel clock). */
  lastReport: Partial<Record<CollectorKind, number>>;
  /** The probe interval last sent to it. */
  probeMs: number;
  updateError: string | null;
  /** Build of the last update offered, and when. */
  offered: { build: string; at: number } | null;
  pending: Map<string, (r: AgentReport | null) => void>;
  send: (msg: PanelMsg) => boolean;
  close: (code: number, reason: string) => void;
}

interface Shared {
  conns: Map<string, AgentConn>;
  probeMs: number;
  seq: number;
}
const g = globalThis as unknown as { __fleetAgents?: Shared };
const shared: Shared = (g.__fleetAgents ??= { conns: new Map(), probeMs: 30_000, seq: 0 });

/** Probe interval while a browser is watching, and otherwise; the same cadence as the ssh sampler. */
export const WATCHED_PROBE_MS = 3000;
export const IDLE_PROBE_MS = 30_000;

const key = (id: string) => id.toLowerCase();

export function agentConn(id: string): AgentConn | undefined {
  return shared.conns.get(key(id));
}

export function allAgents(): AgentConn[] {
  return [...shared.conns.values()];
}

/** Adds a connection; returns the one it replaces (the same machine connecting again), if any. */
export function registerAgent(conn: AgentConn): AgentConn | undefined {
  const prev = shared.conns.get(key(conn.id));
  shared.conns.set(key(conn.id), conn);
  conn.probeMs = shared.probeMs;
  conn.send({ t: "config", probeMs: shared.probeMs });
  return prev;
}

/** Removes a connection (if it's still the current one) and fails its open requests. */
export function unregisterAgent(conn: AgentConn) {
  if (shared.conns.get(key(conn.id)) === conn) shared.conns.delete(key(conn.id));
  for (const done of conn.pending.values()) done(null);
  conn.pending.clear();
}

export function resolveReply(conn: AgentConn, req: string, report: AgentReport) {
  const done = conn.pending.get(req);
  if (done) {
    conn.pending.delete(req);
    done(report);
  }
}

/** Asks the machine's agent to run a collector now; null when there's no agent or it didn't answer in time. */
export function collect(id: string, kind: CollectorKind, timeoutMs = COLLECTOR_TIMEOUT[kind] + 3000): Promise<AgentReport | null> {
  const conn = agentConn(id);
  if (!conn) return Promise.resolve(null);
  const req = `r${++shared.seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      conn.pending.delete(req);
      resolve(null);
    }, timeoutMs);
    conn.pending.set(req, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    if (!conn.send({ t: "collect", req, kind })) {
      conn.pending.delete(req);
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/** Tells every agent how often to probe; sent only when it changes. */
export function setProbeInterval(ms: number) {
  if (shared.probeMs === ms) return;
  shared.probeMs = ms;
  for (const c of shared.conns.values()) {
    c.probeMs = ms;
    c.send({ t: "config", probeMs: ms });
  }
}

/** The agent is connected and its last probe is younger than twice its interval. */
export function freshProbe(id: string): boolean {
  const c = agentConn(id);
  const at = c?.lastReport.probe;
  return !!c && !!at && Date.now() - at < 2 * Math.max(c.probeMs, WATCHED_PROBE_MS);
}

/** What the panel shows about a machine's agent. */
export function agentStatus(node: FleetNode, release = agentRelease()): AgentStatus {
  const c = agentConn(node.id);
  const build = c?.build ?? node.agent.build;
  const arch = c?.arch ?? node.agent.arch;
  const ga = goArch(arch);
  return {
    installed: node.agent.installed,
    connected: !!c,
    version: c?.version ?? node.agent.version,
    build,
    arch,
    since: c ? c.connectedAt : node.agent.seen,
    rtt: c?.rtt ?? null,
    outdated: !!(release && build && (c || node.agent.installed) && build !== release.build && ga && release.binaries[ga]),
    updateError: c?.updateError ?? null,
  };
}

export type CollectorResult = ExecResult & { via: ReportVia; at: number };

/**
 * Runs a collector on a machine: through its agent when one is connected and
 * answers, otherwise over ssh (or locally, for the panel's own machine).
 */
export async function runCollector(node: FleetNode, kind: CollectorKind): Promise<CollectorResult> {
  if (!node.local) {
    const r = await collect(node.id, kind);
    if (r) return { code: r.code, stdout: r.out, stderr: r.err ?? "", ms: r.ms, timedOut: !!r.timedOut, via: "agent", at: r.at };
  }
  const at = Date.now();
  const r = await runScript(node, collectorScript(kind), { timeoutMs: COLLECTOR_TIMEOUT[kind] });
  return { ...r, via: node.local ? "local" : "ssh", at };
}
