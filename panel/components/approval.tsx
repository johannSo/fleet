"use client";

import clsx from "clsx";
import { Check, Copy, HelpCircle, ShieldAlert, ShieldCheck } from "lucide-react";
import { approvalOf, approveCommand, type ApprovalState } from "@/lib/approval";
import type { FleetNode } from "@/lib/types";
import { useFleet } from "./fleet-provider";
import { Badge, useCopy } from "./ui";

/** Whether a machine approved a script, from its latest probe. */
export function useApproval(node: FleetNode | undefined, hash: string | null | undefined): ApprovalState {
  const fleet = useFleet();
  return node ? approvalOf(fleet.states[node.id]?.metrics, hash) : "unknown";
}

export function ApprovalBadge({ state }: { state: ApprovalState }) {
  if (state === "approved") return <Badge tone="green" icon={ShieldCheck}>approved</Badge>;
  if (state === "pending") return <Badge tone="yellow" icon={ShieldAlert}>needs approval</Badge>;
  return <Badge tone="neutral" icon={HelpCircle}>approval unknown</Badge>;
}

/**
 * A custom script's approval on one machine: approved, or the command to run
 * on that machine to approve it. The panel can't approve anything itself.
 */
export function ApprovalNote({ node, hash, what, compact }: { node: FleetNode; hash: string; what: string; compact?: boolean }) {
  const state = useApproval(node, hash);
  const { copied, copy } = useCopy();
  if (state === "approved") {
    return (
      <div className="flex items-center gap-2 text-[12px] text-fg-4">
        <ShieldCheck size={13} className="shrink-0 text-green" />
        <span>
          Approved on <span className="font-mono text-fg-3">{node.id}</span>. Changing it needs a new approval there.
        </span>
      </div>
    );
  }
  const cmd = approveCommand(node, hash);
  const agent = !node.local && node.agent.installed;
  const where = node.local ? "on this machine, the one running the panel" : node.sshCommand ? <>at the machine, or over your own ssh (<span className="font-mono">{node.sshCommand}</span>)</> : "at the machine";
  return (
    <div className={clsx("rounded-lg border px-3 py-2.5", state === "pending" ? "border-yellow/30 bg-yellow/[0.06]" : "border-line-2 bg-void/40")}>
      <div className="flex items-start gap-2 text-[12.5px] leading-relaxed text-fg-2">
        {state === "pending" ? <ShieldAlert size={14} className="mt-0.5 shrink-0 text-yellow" /> : <HelpCircle size={14} className="mt-0.5 shrink-0 text-fg-4" />}
        <div className="min-w-0">
          {state === "pending" ? (
            <>
              <span className="font-mono">{node.id}</span> hasn&apos;t approved {what}, so it won&apos;t run there.
            </>
          ) : (
            <>
              Can&apos;t tell whether <span className="font-mono">{node.id}</span> approved {what} until it reports again. It only runs if it did.
            </>
          )}
          {!compact && <> The panel can&apos;t approve scripts: run this {where} yourself.</>}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1 rounded-md border border-line-2 bg-void/60 py-1 pr-1 pl-2.5">
        <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[11.5px] whitespace-nowrap text-fg-2 select-all">{cmd}</code>
        <button
          type="button"
          onClick={() => copy(cmd)}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded text-fg-4 hover:bg-hl hover:text-fg"
          aria-label="Copy the approve command"
          title="Copy"
        >
          {copied === cmd ? <Check size={13} className="text-green" /> : <Copy size={13} />}
        </button>
      </div>
      {!compact && (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-fg-4">
          {agent
            ? "fleet-agent fetches the script from the panel, checks it matches, shows it to you and asks before approving."
            : "This records the script's fingerprint as shown here: read the script above before you run it."}
        </p>
      )}
    </div>
  );
}
