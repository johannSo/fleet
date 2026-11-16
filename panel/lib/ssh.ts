import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FleetNode } from "./types";

/**
 * Multiplexed ssh: the first connection to a host opens a master socket that
 * later polls reuse, so a stats refresh costs a channel, not a handshake.
 */
const CONTROL_DIR = path.join(os.tmpdir(), `fleet-panel-${process.getuid?.() ?? "u"}`);
try {
  mkdirSync(CONTROL_DIR, { recursive: true, mode: 0o700 });
} catch {
  /* exists */
}

export const SSH_BASE_OPTS = [
  "-o", "ControlMaster=auto",
  "-o", `ControlPath=${CONTROL_DIR}/%C`,
  "-o", "ControlPersist=120",
  "-o", "ServerAliveInterval=15",
  "-o", "ServerAliveCountMax=3",
  // Machines are added from the panel, so the first connection to a new one has to
  // work without a prompt. A key that changes later is still refused.
  "-o", "StrictHostKeyChecking=accept-new",
];

/** Port and destination arguments for ssh, e.g. ["-p", "2222", "user@10.0.0.5"]. */
export function sshDest(node: FleetNode): string[] {
  if (!node.sshTarget) throw new Error(`${node.id} has no connection set up`);
  return [...(node.sshPort ? ["-p", String(node.sshPort)] : []), node.sshTarget];
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  timedOut: boolean;
}

/** Runs a bash script on a node (locally for the panel's own machine). */
export function runScript(
  node: FleetNode,
  script: string,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): Promise<ExecResult> {
  const start = performance.now();
  let cmd: string;
  let args: string[];
  if (node.local) {
    cmd = "bash";
    args = ["-s"];
  } else if (node.sshTarget) {
    cmd = "ssh";
    args = [
      ...SSH_BASE_OPTS,
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=4",
      "-T",
      ...sshDest(node),
      "bash -s",
    ];
  } else {
    return Promise.resolve({
      code: 255,
      stdout: "",
      stderr: "No connection set up for this machine",
      ms: 0,
      timedOut: false,
    });
  }

  return new Promise((resolve) => {
    const child = spawn(/*turbopackIgnore: true*/ cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C" } });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(err), ms: performance.now() - start, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: performance.now() - start, timedOut });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(script);
  });
}

/** Single-quotes a string for POSIX shells. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Cleans ssh's stderr into a short human message. */
export function sshError(r: ExecResult): string {
  if (r.timedOut) return "Timed out";
  const line = r.stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Warning: Permanently added"))
    .pop();
  return line?.replace(/^ssh: /, "") || `Exited with code ${r.code}`;
}
