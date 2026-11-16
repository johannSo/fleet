import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentConn, agentStatus, collect, freshProbe, IDLE_PROBE_MS, runCollector, setProbeInterval, WATCHED_PROBE_MS, type AgentReport } from "./agents";
import { agentRelease, COLLECTOR_TIMEOUT, collectorScript } from "./collectors";
import { loadFleet } from "./fleet";
import { maybeIndex } from "./indexer";
import { parseProbe, type RawSample } from "./probe";
import { runScript, sshError, type ExecResult } from "./ssh";
import type {
  AgentStatus,
  ContainerRow,
  FleetNode,
  NodeDetails,
  NodeState,
  ProcessRow,
  ReportVia,
  Sample,
  UnitRow,
  UpdateInfo,
} from "./types";

/** Survives dev hot reloads and is shared across route modules. */
interface Store {
  samples: Map<string, RawSample>;
  states: Map<string, NodeState>;
  inflight: Map<string, Promise<NodeState>>;
  updates: Map<string, UpdateInfo>;
  updatesInflight: Map<string, Promise<UpdateInfo>>;
  history: Map<string, Sample[]>;
}
const g = globalThis as unknown as { __fleetStore?: Store };
const store: Store = (g.__fleetStore ??= {
  samples: new Map(),
  states: new Map(),
  inflight: new Map(),
  updates: new Map(),
  updatesInflight: new Map(),
  history: new Map(),
});
store.history ??= new Map();

const HISTORY = 100;

const FRESH_MS = 1500;

/* last-seen times survive restarts so "last seen" stays truthful */
const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "fleet-panel");
const SEEN_FILE = path.join(STATE_DIR, "last-seen.json");
const seenG = globalThis as unknown as { __fleetSeen?: Record<string, number>; __fleetSeenWrite?: number; __fleetStarted?: number };
seenG.__fleetStarted ??= Date.now();
export const PANEL_STARTED = seenG.__fleetStarted;
if (!seenG.__fleetSeen) {
  try {
    seenG.__fleetSeen = JSON.parse(readFileSync(/*turbopackIgnore: true*/ SEEN_FILE, "utf8"));
  } catch {
    seenG.__fleetSeen = {};
  }
}
const seen = seenG.__fleetSeen!;

function recordSeen(id: string, at: number) {
  seen[id] = at;
  if (Date.now() - (seenG.__fleetSeenWrite ?? 0) < 30_000) return;
  seenG.__fleetSeenWrite = Date.now();
  try {
    mkdirSync(/*turbopackIgnore: true*/ STATE_DIR, { recursive: true });
    writeFileSync(/*turbopackIgnore: true*/ SEEN_FILE, JSON.stringify(seen));
  } catch {
    /* state dir not writable; last-seen just won't persist */
  }
}

/**
 * Turns one probe's output into the machine's state, chart history and last-seen.
 * `at` is when the probe ran: an agent's report, especially a backfilled one, can
 * arrive later. Returns null when the output isn't a probe.
 */
function applyProbe(node: FleetNode, r: { at: number; out: string; code: number | null }, via: ReportVia, latencyMs: number | null): NodeState | null {
  if (r.code !== 0 || !r.out.includes("hostname=")) return null;
  const prevSample = store.samples.get(node.id);
  // Older than what's already shown (a backfill overlapping ssh probes): nothing to add.
  if (prevSample && r.at <= prevSample.at) return store.states.get(node.id) ?? null;
  const { metrics, sample } = parseProbe(r.out, prevSample, r.at);
  store.samples.set(node.id, sample);
  recordSeen(node.id, r.at);
  maybeIndex(node, metrics);
  const hist = store.history.get(node.id) ?? [];
  if (!hist.length || hist[hist.length - 1].at < r.at) {
    hist.push({
      at: r.at,
      cpu: metrics.cpu,
      mem: metrics.memTotal ? (metrics.memUsed / metrics.memTotal) * 100 : 0,
      rx: metrics.rx,
      tx: metrics.tx,
    });
    store.history.set(node.id, hist.slice(-HISTORY));
  }
  const state: NodeState = {
    id: node.id,
    status: "online",
    latencyMs,
    checkedAt: r.at,
    lastSeen: r.at,
    error: null,
    metrics,
    via,
  };
  const cur = store.states.get(node.id);
  if (!cur || cur.checkedAt <= r.at) store.states.set(node.id, state);
  return state;
}

function offline(node: FleetNode, error: string): NodeState {
  store.samples.delete(node.id);
  return {
    id: node.id,
    status: "offline",
    latencyMs: null,
    checkedAt: Date.now(),
    lastSeen: store.states.get(node.id)?.lastSeen ?? seen[node.id] ?? null,
    error,
    metrics: null,
    via: null,
  };
}

/**
 * The machine's agent's latest probe when it is connected and the probe is fresh;
 * else a probe asked of the agent now; else one over ssh.
 */
async function probe(node: FleetNode, force = false): Promise<NodeState> {
  if (!node.local && agentConn(node.id)) {
    const cur = store.states.get(node.id);
    if (!force && cur?.via === "agent" && freshProbe(node.id)) return cur;
    const r = await collect(node.id, "probe");
    const s = r && applyProbe(node, r, "agent", agentConn(node.id)?.rtt ?? null);
    if (s) return s;
  }
  let r: ExecResult;
  try {
    r = await runScript(node, collectorScript("probe"), { timeoutMs: COLLECTOR_TIMEOUT.probe });
  } catch (err) {
    return offline(node, (err as Error).message);
  }
  const s = applyProbe(node, { at: Date.now(), out: r.stdout, code: r.code }, node.local ? "local" : "ssh", Math.round(r.ms));
  return s ?? offline(node, node.unreachable ? "No connection set up" : sshError(r));
}

/** A report an agent pushed on its own (lib/agent-server.ts). */
export function ingestAgentReport(node: FleetNode, r: AgentReport) {
  if (r.kind === "probe") applyProbe(node, r, "agent", agentConn(node.id)?.rtt ?? null);
  else if (r.kind === "updates") {
    const u = parseUpdates({ code: r.code, stdout: r.out, stderr: r.err ?? "", ms: r.ms, timedOut: !!r.timedOut });
    if (!u.error) store.updates.set(node.id, u);
  }
}

/** Probes an agent took while it couldn't reach the panel, oldest first. */
export function ingestBackfill(node: FleetNode, reports: AgentReport[]) {
  for (const r of [...reports].sort((a, b) => a.at - b.at)) if (r.kind === "probe") applyProbe(node, r, "agent", null);
}

export function getState(node: FleetNode, force = false): Promise<NodeState> {
  const cached = store.states.get(node.id);
  if (!force && cached && Date.now() - cached.checkedAt < FRESH_MS) return Promise.resolve(cached);
  let p = store.inflight.get(node.id);
  if (!p) {
    p = probe(node, force)
      .then((s) => {
        store.states.set(node.id, s);
        return s;
      })
      .finally(() => store.inflight.delete(node.id));
    store.inflight.set(node.id, p);
  }
  // A dead host takes seconds to time out; don't let it stall the whole
  // fleet poll. Serve the last known state and let the probe land later.
  if (!cached || force) return p;
  return Promise.race([p, new Promise<NodeState>((r) => setTimeout(() => r(cached), 900))]);
}

export async function getFleetState() {
  startSampler();
  const nodes = loadFleet();
  // The sampler drives probing at an even cadence; readers just take the
  // latest result (probing only if a node has never been seen).
  const states = await Promise.all(nodes.map((n) => store.states.get(n.id) ?? getState(n)));
  const history = Object.fromEntries(nodes.map((n) => [n.id, store.history.get(n.id) ?? []]));
  const release = agentRelease();
  const agents: Record<string, AgentStatus> = Object.fromEntries(nodes.map((n) => [n.id, agentStatus(n, release)]));
  return { nodes, states, history, agents, at: Date.now(), startedAt: PANEL_STARTED };
}

/* ---------------- pending updates ---------------- */

/* The script is agent/collectors/updates.sh. */

function parseUpdates(r: ExecResult): UpdateInfo {
  if (!r.stdout.includes("done=1")) {
    return { checkedAt: Date.now(), count: 0, packages: [], error: sshError(r) };
  }
  const packages = r.stdout
    .split("\n")
    .filter((l) => l.startsWith("pkg="))
    .map((l) => {
      const [name, from, to] = l.slice(4).split("|");
      return { name, from: from ?? "", to: to ?? "" };
    });
  return { checkedAt: Date.now(), count: packages.length, packages, error: null };
}

const UPDATES_TTL = 15 * 60_000;

export function getUpdates(node: FleetNode, force = false): Promise<UpdateInfo> {
  const cached = store.updates.get(node.id);
  if (!force && cached && Date.now() - cached.checkedAt < UPDATES_TTL) return Promise.resolve(cached);
  let p = store.updatesInflight.get(node.id);
  if (!p) {
    p = runCollector(node, "updates")
      .then(parseUpdates, (err: Error): UpdateInfo => ({ checkedAt: Date.now(), count: 0, packages: [], error: err.message }))
      .then((u) => {
        store.updates.set(node.id, u);
        return u;
      })
      .finally(() => store.updatesInflight.delete(node.id));
    store.updatesInflight.set(node.id, p);
  }
  return p;
}

export function cachedUpdates(id: string): UpdateInfo | undefined {
  return store.updates.get(id);
}

/** Called after an update/reboot so the next read re-checks. */
export function invalidateUpdates(id: string) {
  store.updates.delete(id);
}

/* ---------------- node details ---------------- */

/* The script is agent/collectors/details.sh. */

function sections(out: string): Record<string, string[]> {
  const res: Record<string, string[]> = {};
  let cur = "";
  for (const line of out.split("\n")) {
    const m = line.match(/^##(\w+)$/);
    if (m) {
      cur = m[1];
      res[cur] = [];
    } else if (cur && line.trim()) {
      res[cur].push(line);
    }
  }
  return res;
}

export async function getDetails(node: FleetNode): Promise<NodeDetails> {
  const r = await runCollector(node, "details");
  if (!r.stdout.includes("##end")) {
    return { processes: [], units: [], containers: [], dockerAccess: "none", listening: [], error: sshError(r) };
  }
  const s = sections(r.stdout);

  const processes: ProcessRow[] = (s.procs ?? [])
    .map((l) => {
      const m = l.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
      if (!m) return null;
      return {
        pid: Number(m[1]),
        user: m[2],
        cpu: Number(m[3]),
        mem: Number(m[4]),
        rss: Number(m[5]) * 1024,
        command: m[6],
      };
    })
    .filter((p): p is ProcessRow => p !== null && !/^(ps|head|bash -s|sshd-session:.*notty)/.test(p.command));

  const units: UnitRow[] = (s.units ?? [])
    .map((l) => {
      const m = l.match(/^(system|user)\s+(\S+)\s+\S+\s+(\S+)\s+(\S+)\s*(.*)$/);
      if (!m) return null;
      return {
        scope: m[1] as "system" | "user",
        unit: m[2].replace(/^●\s*/, ""),
        active: m[3],
        sub: m[4],
        description: m[5],
      };
    })
    .filter((u): u is UnitRow => u !== null);

  let dockerAccess: NodeDetails["dockerAccess"] = "none";
  const containers: ContainerRow[] = [];
  for (const l of s.docker ?? []) {
    if (l.startsWith("access=")) {
      dockerAccess = l.slice(7) as NodeDetails["dockerAccess"];
      continue;
    }
    const [id, name, image, state, status, ports] = l.split("\t");
    if (id && name) containers.push({ id, name, image, state, status, ports: ports ?? "" });
  }

  const listening: NodeDetails["listening"] = [];
  const seen = new Set<string>();
  for (const l of s.listen ?? []) {
    const parts = l.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const proto = parts[0];
    const local = parts[4];
    const idx = local.lastIndexOf(":");
    const addr = local.slice(0, idx).replace(/^\[|\]$/g, "").replace(/%\S+$/, "");
    const port = Number(local.slice(idx + 1));
    const proc = l.match(/users:\(\("([^"]+)"/)?.[1] ?? "";
    const key = `${proto}:${port}:${proc}`;
    if (!port || seen.has(key)) continue;
    seen.add(key);
    listening.push({ proto, addr, port, process: proc });
  }
  listening.sort((a, b) => a.port - b.port);

  return { processes, units, containers, dockerAccess, listening, error: null };
}

/* ---------------- background sampler ---------------- */

// Kept on globalThis so a hot-reloaded route and the running sampler agree.
const pollMark = globalThis as unknown as { __fleetLastPoll?: number };

/** Called by the API so the sampler knows someone is watching. */
export function markClientPoll() {
  pollMark.__fleetLastPoll = Date.now();
  setProbeInterval(WATCHED_PROBE_MS);
}

/**
 * Keeps the history warm so charts are populated the moment a page opens:
 * every 3s while a browser is polling, every 30s otherwise.
 */
export function startSampler() {
  const g2 = globalThis as unknown as { __fleetSampler?: boolean };
  if (g2.__fleetSampler) return;
  g2.__fleetSampler = true;
  let lastRun = 0;
  const tick = async () => {
    const watching = Date.now() - (pollMark.__fleetLastPoll ?? 0) < 60_000;
    // Agents push on the same cadence (lib/agents.ts).
    setProbeInterval(watching ? WATCHED_PROBE_MS : IDLE_PROBE_MS);
    if (Date.now() - lastRun >= (watching ? 3000 : 30_000)) {
      lastRun = Date.now();
      try {
        await Promise.all(loadFleet().map((n) => getState(n)));
      } catch {
        /* inventory database unavailable; try again later */
      }
    }
    setTimeout(tick, 1000).unref?.();
  };
  tick();
}
