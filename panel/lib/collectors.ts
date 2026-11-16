/**
 * The read-only scripts the panel runs on machines (probe, details, updates,
 * index). They live in ../agent/collectors/, where fleet-agent compiles
 * them in, so a machine reports the same output whether its agent pushed it or
 * the panel fetched it over ssh, and the same parsers read both.
 *
 * Also where the agent binaries are: ../agent/bin/ (built by
 * agent/build.sh, synced to the panel's machine by deploy.sh).
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export type CollectorKind = "probe" | "details" | "updates" | "index";
export const COLLECTOR_KINDS: readonly CollectorKind[] = ["probe", "details", "updates", "index"];

/** How long each collector may run, the same on both runners. */
export const COLLECTOR_TIMEOUT: Record<CollectorKind, number> = {
  probe: 8000,
  details: 15_000,
  updates: 60_000,
  index: 30_000,
};

/** The agent directory: $FLEET_AGENT_DIR, or next to the panel. */
export const AGENT_DIR = process.env.FLEET_AGENT_DIR || path.resolve(/*turbopackIgnore: true*/ process.cwd(), "..", "agent");
export const AGENT_BIN_DIR = path.join(AGENT_DIR, "bin");
export const AGENT_ARCHES = ["amd64", "arm64"] as const;
export type AgentArch = (typeof AGENT_ARCHES)[number];

interface Cached<T> {
  mtime: number;
  size: number;
  value: T;
}
const g = globalThis as unknown as { __fleetCollectors?: Map<string, Cached<unknown>> };
const cache = (g.__fleetCollectors ??= new Map());

/** Reads a file once per change (by mtime and size). */
function cachedRead<T>(file: string, parse: (buf: Buffer) => T): T | null {
  let st;
  try {
    st = statSync(/*turbopackIgnore: true*/ file);
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file) as Cached<T> | undefined;
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.value;
  const value = parse(readFileSync(/*turbopackIgnore: true*/ file));
  cache.set(file, { mtime: st.mtimeMs, size: st.size, value });
  return value;
}

/** A collector's script. Throws when agent/collectors/ is missing (a broken deploy). */
export function collectorScript(kind: CollectorKind): string {
  const file = path.join(AGENT_DIR, "collectors", `${kind}.sh`);
  const s = cachedRead(file, (b) => b.toString("utf8"));
  if (s == null) throw new Error(`Missing collector ${file}: deploy agent/collectors next to the panel`);
  return s;
}

export interface AgentBinary {
  arch: AgentArch;
  file: string;
  sha256: string;
  size: number;
}

/** The agent build the panel offers: id from bin/BUILD, plus each binary's sha256. */
export function agentRelease(): { build: string; binaries: Partial<Record<AgentArch, AgentBinary>> } | null {
  const build = cachedRead(path.join(AGENT_BIN_DIR, "BUILD"), (b) => b.toString("utf8").trim());
  if (!build) return null;
  const binaries: Partial<Record<AgentArch, AgentBinary>> = {};
  for (const arch of AGENT_ARCHES) {
    const file = path.join(AGENT_BIN_DIR, `fleet-agent-${arch}`);
    const bin = cachedRead(file, (b) => ({ arch, file, sha256: createHash("sha256").update(b).digest("hex"), size: b.length }));
    if (bin) binaries[arch] = bin;
  }
  return { build, binaries };
}

/** Go's GOARCH for `uname -m`. */
export function goArch(machine: string | null | undefined): AgentArch | null {
  if (!machine) return null;
  if (/^(x86_64|amd64)$/.test(machine)) return "amd64";
  if (/^(aarch64|arm64)$/.test(machine)) return "arm64";
  return null;
}
