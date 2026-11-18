/**
 * Custom scripts (a machine's update script, saved commands) only run on a
 * machine once someone has approved them on that machine itself, by running a
 * command there. The panel can't approve anything: whoever gets into the panel
 * (a stolen session, a hijacked phone) can only run the built-in actions and
 * scripts that each machine's owner already approved, word for word.
 *
 * An approval is the script's sha256, one per line, in APPROVED_FILE on the
 * machine. Changing a script changes its hash, so it needs approving again.
 * The panel checks the file right before running (lib/scripts.ts → approvedRun),
 * and the probe reports its hashes so the UI can show what still needs approving.
 *
 * Client-safe: no node imports. Hashes are computed on the server.
 */
import type { FleetNode, NodeMetrics } from "./types";

export const APPROVED_FILE = "~/.config/fleet/approved-scripts";

/** A command saved in the panel, run from Run command on any machine that approved it. */
export interface SavedScript {
  id: string;
  name: string;
  script: string;
  /** sha256 of `script`: what a machine approves. */
  hash: string;
  createdAt: number;
  updatedAt: number;
}

export const isHash = (h: string) => /^[0-9a-f]{64}$/.test(h);

/**
 * What to run on the machine to approve a script. With fleet-agent, it fetches
 * the script from the panel, shows it and asks first; without, it records the
 * hash of the script as shown in the panel. Only the hex hash goes in, never
 * text someone typed into the panel, since the person pastes this into a shell.
 */
export function approveCommand(node: Pick<FleetNode, "local" | "agent">, hash: string): string {
  if (!isHash(hash)) throw new Error("Not a script hash");
  if (!node.local && node.agent.installed) return `~/.local/bin/fleet-agent approve ${hash}`;
  return `mkdir -p ~/.config/fleet && echo ${hash} >> ${APPROVED_FILE}`;
}

export type ApprovalState = "approved" | "pending" | "unknown";

/** Whether the machine approved a script, as its latest probe reported. */
export function approvalOf(metrics: NodeMetrics | null | undefined, hash: string | null | undefined): ApprovalState {
  if (!hash || !metrics?.approved) return "unknown";
  return metrics.approved.includes(hash) ? "approved" : "pending";
}
