/**
 * Which Fleet this is, and whether a newer release is out. The running version is
 * $FLEET_VERSION (the Docker image's release tag, set at build time) or package.json's.
 * The latest release comes from GitHub's API, checked every few hours; FLEET_UPDATE_CHECK=0
 * turns the check off.
 *
 * Only server.ts (and modules it imports) may use this.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO = process.env.FLEET_REPO || "johannSo/fleet";
const CHECK_EVERY = 6 * 3600_000;
const RETRY_AFTER = 15 * 60_000;

export interface VersionInfo {
  current: string;
  commit: string | null;
  /** How this panel runs, for the upgrade hint. */
  install: "docker" | "service";
  latest: { version: string; url: string; publishedAt: string | null } | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  error: string | null;
}

function packageVersion(): string {
  try {
    return String(JSON.parse(readFileSync(path.join(/*turbopackIgnore: true*/ process.cwd(), "package.json"), "utf8")).version || "0.0.0");
  } catch {
    return "0.0.0";
  }
}

const current = (process.env.FLEET_VERSION || packageVersion()).replace(/^v/, "");
const commit = process.env.FLEET_COMMIT || null;

/** x.y.z → [x, y, z]; a pre-release suffix only matters in newer(). */
function parts(v: string): number[] {
  const m = v.replace(/^v/, "").match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : [0, 0, 0];
}

const isPre = (v: string) => /^\d+(\.\d+){0,2}-/.test(v.replace(/^v/, ""));

export function newer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  // Same numbers: a release is newer than its own pre-release (0.3.0 over 0.3.0-beta.1).
  return !isPre(a) && isPre(b);
}

const g = globalThis as unknown as { __fleetRelease?: { latest: VersionInfo["latest"]; at: number | null; tried: number; error: string | null; inflight: Promise<void> | null } };
const state = (g.__fleetRelease ??= { latest: null, at: null, tried: 0, error: null, inflight: null });

async function check(): Promise<void> {
  state.tried = Date.now();
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "fleet-panel" },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 404) {
      state.latest = null; // no release yet
    } else if (!r.ok) {
      throw new Error(`GitHub answered HTTP ${r.status}`);
    } else {
      const d = (await r.json()) as { tag_name?: string; html_url?: string; published_at?: string };
      if (!d.tag_name) throw new Error("GitHub's answer has no tag");
      state.latest = { version: d.tag_name.replace(/^v/, ""), url: d.html_url || `https://github.com/${REPO}/releases`, publishedAt: d.published_at ?? null };
    }
    state.at = Date.now();
    state.error = null;
  } catch (err) {
    state.error = (err as Error).message; // offline: keep the last answer
  }
}

export async function versionInfo(): Promise<VersionInfo> {
  const enabled = process.env.FLEET_UPDATE_CHECK !== "0";
  const due = !state.at ? Date.now() - state.tried > RETRY_AFTER : Date.now() - state.at > CHECK_EVERY;
  if (enabled && due && !state.inflight) state.inflight = check().finally(() => (state.inflight = null));
  // The first check waits for its answer; later ones refresh in the background.
  if (state.inflight && !state.at) await state.inflight;
  const latest = enabled ? state.latest : null;
  return {
    current,
    commit,
    install: process.env.FLEET_INSTALL === "docker" ? "docker" : "service",
    latest,
    updateAvailable: !!latest && newer(latest.version, current),
    checkedAt: state.at,
    error: enabled ? state.error : null,
  };
}
