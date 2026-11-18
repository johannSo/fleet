"use client";

import clsx from "clsx";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CloudDownload,
  FileCode2,
  HelpCircle,
  Info,
  Laptop2,
  Pencil,
  Play,
  Power,
  RefreshCw,
  Plus,
  RotateCw,
  ShieldAlert,
  SquareTerminal,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { approvalOf, type SavedScript } from "@/lib/approval";
import { CHECKS } from "@/lib/checks";
import { ago } from "@/lib/format";
import type { FleetNode, PkgManager } from "@/lib/types";
import { UPDATE_OSES, updateOsInfo, type UpdateOs } from "@/lib/update-os";
import { rebootHint, useFleet } from "./fleet-provider";
import { useTerminals } from "./terminal-provider";
import { AccountDialog } from "./account";
import { DevicesDialog } from "./devices";
import { api, MachineDialog, type MachineDialogState, type MachineSection } from "./machine-editor";
import { useIsMobile } from "./hooks";
import { ApprovalBadge, ApprovalNote } from "./approval";
import { Md } from "./md";
import { ACCENT, Badge, Button, HoldButton, Kbd, Modal, Spinner, StatusDot } from "./ui";

type Dialog =
  | { type: "power"; node: string; kind: "reboot" | "shutdown" }
  | { type: "update"; nodes: string[] }
  | { type: "run"; nodes: string[] }
  | { type: "devices" }
  | { type: "account" }
  | { type: "machine"; state: NonNullable<MachineDialogState> }
  | null;

interface ActionsCtx {
  power: (node: string, kind: "reboot" | "shutdown") => void;
  update: (nodes: string | string[]) => void;
  run: (nodes?: string[]) => void;
  devices: () => void;
  account: () => void;
  addMachine: () => void;
  editMachine: (id: string, section?: MachineSection) => void;
}

const Ctx = createContext<ActionsCtx | null>(null);

export function useActions() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useActions outside ActionsProvider");
  return c;
}

export const PKG_LABEL: Record<PkgManager, string> = {
  omarchy: "omarchy-update",
  yay: "yay -Syu",
  paru: "paru -Syu",
  pacman: "pacman -Syu",
  apt: "apt full-upgrade",
  dnf: "dnf upgrade",
  unknown: "unknown",
};

/** What the system update runs on a machine: by its OS, and for Arch by the helper the probe found. */
export function updaterLabel(os: UpdateOs | null | undefined, pkg?: PkgManager): string | null {
  if (os === "arch" && (pkg === "yay" || pkg === "paru" || pkg === "pacman")) return PKG_LABEL[pkg];
  return updateOsInfo(os)?.command ?? null;
}

/** The OS families the Update action can update, as chips. */
export function OsPicker({ value, onChange, label }: { value: UpdateOs | null | undefined; onChange: (os: UpdateOs) => void; label: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
      {UPDATE_OSES.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          title={[o.examples && `Also ${o.examples}`, `Runs ${o.command}`].filter(Boolean).join(" · ")}
          onClick={() => onChange(o.id)}
          className={clsx(
            "min-h-8 cursor-pointer rounded-md border px-2.5 text-[12px] font-medium transition-colors pointer-coarse:min-h-10",
            value === o.id ? "border-blue/50 bg-blue/[0.12] text-fg" : "border-line-2 bg-void/40 text-fg-3 hover:border-line-3 hover:text-fg-2",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ActionsProvider({ children }: { children: React.ReactNode }) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const term = useTerminals();
  const fleet = useFleet();

  const value = useMemo<ActionsCtx>(
    () => ({
      power: (node, kind) => setDialog({ type: "power", node, kind }),
      update: (nodes) => setDialog({ type: "update", nodes: Array.isArray(nodes) ? nodes : [nodes] }),
      run: (nodes) => setDialog({ type: "run", nodes: nodes ?? [] }),
      devices: () => setDialog({ type: "devices" }),
      account: () => setDialog({ type: "account" }),
      addMachine: () => setDialog({ type: "machine", state: { mode: "add" } }),
      editMachine: (id, section) => setDialog({ type: "machine", state: { mode: "edit", id, section } }),
    }),
    [],
  );

  // React to sessions finishing: re-check updates, and summarise multi-machine commands.
  const seen = useRef(new Set<string>());
  const primed = useRef(false);
  const batches = useRef<{ ids: string[]; cmd: string }[]>([]);
  const trackBatch = useCallback((ids: string[], cmd: string) => {
    batches.current = [...batches.current, { ids, cmd }];
  }, []);
  const { refreshUpdates } = fleet;
  useEffect(() => {
    // Sessions that had already finished before this page loaded aren't news.
    if (!primed.current && term.connected) {
      primed.current = true;
      for (const s of term.sessions) if (s.exited) seen.current.add(s.id);
    }
    const finished = batches.current.filter((b) =>
      b.ids.every((id) => {
        const s = term.sessions.find((x) => x.id === id);
        return !s || s.exited;
      }),
    );
    batches.current = batches.current.filter((b) => !finished.includes(b));
    for (const b of finished) {
      const list = b.ids.map((id) => term.sessions.find((s) => s.id === id));
      const done = list.filter((s): s is NonNullable<typeof s> => !!s);
      const failed = done.filter((s) => s.exitCode !== 0);
      const summary = done.map((s) => `${s.node} ${s.exitCode === 0 ? "✓" : `✕ ${s.exitCode}`}`).join("   ");
      (failed.length ? toast.error : toast.success)(
        failed.length ? `${failed.length} of ${done.length} machines failed` : `Finished on all ${done.length} machines`,
        { description: `${b.cmd}\n${summary}`, duration: 10_000 },
      );
    }
    for (const s of term.sessions) {
      if (!s.exited || seen.current.has(s.id)) continue;
      seen.current.add(s.id);
      if (s.action === "update") {
        refreshUpdates(s.node, true);
        if (s.exitCode === 0) toast.success(`${s.node} is up to date`, { description: "Update finished successfully." });
        else toast.error(`Update on ${s.node} exited with code ${s.exitCode}`, { description: "Check the terminal output." });
      }
    }
  }, [term.sessions, term.connected, refreshUpdates]);

  const close = useCallback(() => setDialog(null), []);

  return (
    <Ctx.Provider value={value}>
      {children}
      <PowerDialog dialog={dialog?.type === "power" ? dialog : null} onClose={close} />
      <UpdateDialog dialog={dialog?.type === "update" ? dialog : null} onClose={close} />
      <RunDialog dialog={dialog?.type === "run" ? dialog : null} onClose={close} onBatch={trackBatch} />
      <DevicesDialog open={dialog?.type === "devices"} onClose={close} onAccount={value.account} />
      <AccountDialog open={dialog?.type === "account"} onClose={close} />
      <MachineDialog dialog={dialog?.type === "machine" ? dialog.state : null} onClose={close} />
    </Ctx.Provider>
  );
}

/** Keeps the last non-null dialog so its content stays put during the exit animation. */
function useKept<T>(value: T | null): T | null {
  const [kept, setKept] = useState(value);
  if (value && value !== kept) setKept(value);
  return value ?? kept;
}

/* ---------------- power ---------------- */

function Callout({ tone, icon: Icon, children }: { tone: "red" | "yellow" | "blue"; icon: typeof Info; children: React.ReactNode }) {
  const cls = {
    red: "border-red/25 bg-red/[0.07] text-red",
    yellow: "border-yellow/25 bg-yellow/[0.07] text-yellow",
    blue: "border-blue/25 bg-blue/[0.07] text-blue",
  }[tone];
  return (
    <div className={clsx("flex gap-2.5 rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed", cls)}>
      <Icon size={15} className="mt-0.5 shrink-0" />
      <div className="text-fg-2">{children}</div>
    </div>
  );
}

function PowerDialog({
  dialog,
  onClose,
}: {
  dialog: { node: string; kind: "reboot" | "shutdown" } | null;
  onClose: () => void;
}) {
  const fleet = useFleet();
  const term = useTerminals();
  const phone = useIsMobile();
  const d = useKept(dialog);
  const node = fleet.nodes.find((n) => n.id === d?.node);
  if (!d) return null;
  const reboot = d.kind === "reboot";
  const live = term.sessions.filter((s) => s.node === d.node && !s.exited);
  const updating = live.some((s) => s.action === "update");
  const hint = rebootHint(node);

  const confirm = async () => {
    onClose();
    const s = await term.open({ node: d.node, action: d.kind });
    if (!s) return;
    fleet.markPower(d.node, d.kind);
    toast(reboot ? `Rebooting ${d.node}…` : `Shutting down ${d.node}…`, {
      description: reboot ? "We'll let you know when it's back." : "It will show as powered off once it drops.",
      icon: reboot ? <RotateCw size={15} className="text-yellow" /> : <Power size={15} className="text-red" />,
    });
  };

  return (
    <Modal
      open={!!dialog}
      onClose={onClose}
      icon={reboot ? RotateCw : Power}
      tone={reboot ? "yellow" : "red"}
      title={
        <>
          {reboot ? "Reboot" : "Shut down"} <span className="font-mono">{d.node}</span>?
        </>
      }
      description={
        reboot
          ? "Usually back within a minute or two — you'll get a notification when it's reachable again."
          : "You'll need physical access (or Wake-on-LAN) to turn it back on."
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose} className="max-sm:hidden">
            Cancel
          </Button>
          <HoldButton
            onConfirm={confirm}
            icon={reboot ? RotateCw : Power}
            tone={reboot ? "yellow" : "red"}
            className="max-sm:!h-[52px] max-sm:w-full max-sm:rounded-xl max-sm:text-[15px]"
            solid={phone}
          >
            Hold 1s to {reboot ? "reboot" : "shut down"} {d.node}
          </HoldButton>
        </>
      }
    >
      <div className="space-y-2">
        {node?.local && (
          <Callout tone="red" icon={Laptop2}>
            <b className="text-red">This is the machine running the control panel.</b> The panel goes down with it, and sudo
            will ask for your password in the terminal.
          </Callout>
        )}
        {updating && (
          <Callout tone="red" icon={AlertTriangle}>
            An update is still running on <span className="font-mono">{d.node}</span>. Interrupting a package upgrade can break
            the system.
          </Callout>
        )}
        {live.length > 0 && !updating && (
          <Callout tone="yellow" icon={TerminalSquare}>
            {live.length} open terminal session{live.length > 1 ? "s" : ""} on <span className="font-mono">{d.node}</span> will
            be cut off.
          </Callout>
        )}
        {hint && (
          <Callout tone="blue" icon={Info}>
            <Md text={hint.text} />
          </Callout>
        )}
        {!node?.local && (
          <div className="rounded-lg border border-line-2 bg-void/40 px-3 py-2.5 font-mono text-[12px] text-fg-3">
            <span className="text-fg-5">$</span> {node?.sshCommand ?? "ssh"} sudo systemctl {reboot ? "reboot" : "poweroff"}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---------------- update ---------------- */

function UpdateDialog({ dialog, onClose }: { dialog: { nodes: string[] } | null; onClose: () => void }) {
  const fleet = useFleet();
  const term = useTerminals();
  const actions = useActions();
  const d = useKept(dialog);
  const [auto, setAuto] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  // OS answers for machines whose OS couldn't be detected; saved to the machine on start.
  const [osPick, setOsPick] = useState<Record<string, UpdateOs>>({});
  const [starting, setStarting] = useState(false);
  const [openedFor, setOpenedFor] = useState<typeof dialog>(null);

  const ids = d?.nodes ?? [];
  const single = ids.length === 1 ? ids[0] : null;
  const candidates = single ? [single] : fleet.nodes.filter((n) => !n.unreachable).map((n) => n.id);

  // Reset the form each time the dialog opens (adjusting state during render).
  if (dialog && dialog !== openedFor) {
    setOpenedFor(dialog);
    setAuto(false);
    setOsPick({});
    setStarting(false);
    setPicked(
      dialog.nodes.length === 1
        ? dialog.nodes
        : fleet.nodes
            // The package check can't see what an update script updates, so machines with one are picked too.
            .filter((n) => fleet.states[n.id]?.status === "online" && ((fleet.updates[n.id]?.count ?? 0) > 0 || !!n.updateScript))
            .map((n) => n.id),
    );
  }

  if (!d) return null;
  const info = single ? fleet.updates[single] : undefined;
  const loading = single ? fleet.updatesLoading[single] : fleet.updatesLoading.__all;
  const pkg = single ? fleet.states[single]?.metrics?.pkg : undefined;
  const singleNode = single ? fleet.nodes.find((n) => n.id === single) : undefined;
  const script = singleNode?.updateScript ?? "";
  const singleOs = singleNode?.updateOs ?? (single ? osPick[single] : undefined);
  const updater = <span className="font-mono text-fg-2">{updaterLabel(singleOs, pkg) ?? "the system updater"}</span>;
  const nodeOf = (id: string) => fleet.nodes.find((n) => n.id === id);
  // Picked machines with no detected or chosen OS: there's no knowing which updater to run until the user says.
  const unknownOs = picked.filter((id) => !nodeOf(id)?.updateOs);
  const missingOs = unknownOs.filter((id) => !osPick[id]);
  // Machines whose update script they haven't approved: the run would stop before updating anything.
  const unapproved = picked.filter((id) => {
    const n = nodeOf(id);
    return !!n?.updateScriptHash && approvalOf(fleet.states[id]?.metrics, n.updateScriptHash) === "pending";
  });
  const editScript = () => {
    onClose();
    if (single) actions.editMachine(single, "update");
  };

  const start = async () => {
    if (missingOs.length) return;
    const answers = Object.entries(osPick).filter(([id]) => unknownOs.includes(id));
    if (answers.length) {
      setStarting(true);
      try {
        for (const [id, updateOs] of answers) await api("PATCH", `/api/machines/${encodeURIComponent(id)}`, { updateOs });
      } catch (err) {
        setStarting(false);
        toast.error("Couldn't save the OS", { description: (err as Error).message });
        return;
      }
    }
    onClose();
    let lastS = null;
    for (const id of picked) {
      lastS = await term.open({ node: id, action: "update", params: { auto } }, { focus: id === picked[picked.length - 1] });
    }
    if (lastS && picked.length > 1) toast(`Updating ${picked.length} machines`, { description: "Each runs in its own terminal tab." });
  };

  return (
    <Modal
      open={!!dialog}
      onClose={onClose}
      icon={CloudDownload}
      tone="blue"
      width={600}
      title={single ? <>Update <span className="font-mono">{single}</span></> : "Update machines"}
      description={
        single ? (
          script ? (
            <>
              Runs {singleNode?.updateScriptWhen === "before" ? <>your update script, then {updater}</> : <>{updater}, then your update script</>}, in a terminal tab so
              you can watch it and answer prompts.
            </>
          ) : (
            <>
              Runs {updater} in a terminal tab so you can watch it and answer prompts.
            </>
          )
        ) : (
          "Each machine runs its own updater, and its update script if it has one, in a separate terminal tab."
        )
      }
      footer={
        <>
          <label className="mr-auto flex cursor-pointer items-center gap-2 text-[12.5px] text-fg-3 select-none">
            <span
              className={clsx(
                "relative inline-flex h-[18px] w-8 items-center rounded-full transition-colors",
                auto ? "bg-blue" : "bg-hl ring-1 ring-line-3 ring-inset",
              )}
            >
              <span
                className={clsx(
                  "absolute size-3.5 rounded-full shadow transition-transform",
                  auto ? "translate-x-4 bg-[#11131c]" : "translate-x-0.5 bg-fg-2",
                )}
              />
            </span>
            <input type="checkbox" className="sr-only" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            Auto-answer prompts
          </label>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={single && info && info.count === 0 && !script ? "secondary" : "primary"}
            icon={Play}
            onClick={start}
            loading={starting}
            disabled={picked.length === 0 || missingOs.length > 0 || unapproved.length > 0}
            title={
              missingOs.length
                ? `Choose which OS ${missingOs.join(", ")} ${missingOs.length === 1 ? "runs" : "run"} first`
                : unapproved.length
                  ? `${unapproved.join(", ")} ${unapproved.length === 1 ? "hasn't" : "haven't"} approved ${unapproved.length === 1 ? "its" : "their"} update script`
                  : undefined
            }
          >
            {single ? (info && info.count === 0 && !script ? "Run updater anyway" : "Start update") : `Update ${picked.length} machine${picked.length === 1 ? "" : "s"}`}
          </Button>
        </>
      }
    >
      {single ? (
        <div>
          <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-line-2 bg-void/40 px-3 py-2.5">
            <div className="flex items-center gap-2 text-[12.5px] text-fg-3">
              {loading && !info ? (
                <>
                  <Spinner size={13} /> Checking for updates…
                </>
              ) : info?.error ? (
                <span className="text-red">{info.error}</span>
              ) : info && info.count === 0 ? (
                <>
                  <Check size={14} className="text-green" />
                  <span className="text-fg-2">Up to date</span>
                  <span className="text-fg-4">· checked {ago(info.checkedAt)}</span>
                </>
              ) : (
                <>
                  <span className="font-semibold text-fg">{info?.count ?? 0}</span> package{info?.count === 1 ? "" : "s"} to upgrade
                  {info && <span className="text-fg-4">· checked {ago(info.checkedAt)}</span>}
                </>
              )}
            </div>
            <Button size="xs" variant="ghost" icon={RefreshCw} loading={loading} onClick={() => fleet.refreshUpdates(single, true)}>
              Re-check
            </Button>
          </div>
          {info && info.count > 0 && <PackageList info={info} loading={!!loading} />}
          {fleet.states[single]?.metrics?.rebootRequired && (
            <div className="mt-2.5">
              <Callout tone="yellow" icon={RotateCw}>
                The running kernel is older than the installed one — reboot after updating.
              </Callout>
            </div>
          )}
          {singleNode && !singleNode.updateOs ? (
            <OsQuestion node={singleNode} value={osPick[singleNode.id]} onChange={(os) => setOsPick((p) => ({ ...p, [singleNode.id]: os }))} />
          ) : (
            <UpdaterLine node={singleNode} pkg={pkg} onEdit={editScript} />
          )}
          <UpdateScriptCard node={singleNode} onEdit={editScript} />
        </div>
      ) : (
        <div className="space-y-1.5">
          {candidates.map((id) => {
            const n = fleet.nodes.find((x) => x.id === id)!;
            const st = fleet.displayStatus(id);
            const u = fleet.updates[id];
            const on = picked.includes(id);
            const disabled = st !== "online";
            return (
              <button
                key={id}
                disabled={disabled}
                onClick={() => setPicked((p) => (on ? p.filter((x) => x !== id) : [...p, id]))}
                className={clsx(
                  "flex w-full cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45",
                  on ? "border-blue/40 bg-blue/[0.07]" : "border-line-2 bg-void/30 hover:border-line-3",
                )}
              >
                <span
                  className={clsx(
                    "grid size-4 place-items-center rounded-[4px] ring-1 ring-inset",
                    on ? "bg-blue text-[#11131c] ring-blue" : "ring-line-3",
                  )}
                >
                  {on && <Check size={11} strokeWidth={3} />}
                </span>
                <StatusDot status={st} size={7} />
                <span className={clsx("font-mono text-[13px] font-semibold", ACCENT[fleet.accent(id)]?.text)}>{id}</span>
                <span className="truncate text-[12px] text-fg-4">{n.os.split(",")[0]}</span>
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {!n.updateOs && (
                    <Badge tone={osPick[id] ? "neutral" : "yellow"} icon={osPick[id] ? undefined : HelpCircle}>
                      {updateOsInfo(osPick[id])?.label ?? "OS?"}
                    </Badge>
                  )}
                  {n.updateScript && (approvalOf(fleet.states[id]?.metrics, n.updateScriptHash) === "pending" ? (
                    <Badge tone="yellow" icon={ShieldAlert}>script not approved</Badge>
                  ) : (
                    <Badge tone="neutral" icon={FileCode2}>script</Badge>
                  ))}
                  {u == null ? (
                    <Spinner size={12} className="text-fg-4" />
                  ) : u.error ? (
                    <Badge tone="red">error</Badge>
                  ) : u.count > 0 ? (
                    <Badge tone="blue">{u.count} pending</Badge>
                  ) : (
                    <Badge tone="green" icon={Check}>
                      up to date
                    </Badge>
                  )}
                </span>
              </button>
            );
          })}
          {unknownOs.map((id) => (
            <OsQuestion key={id} node={nodeOf(id)!} value={osPick[id]} onChange={(os) => setOsPick((p) => ({ ...p, [id]: os }))} />
          ))}
          {unapproved.map((id) => (
            <div key={id} className="mt-2.5">
              <ApprovalNote node={nodeOf(id)!} hash={nodeOf(id)!.updateScriptHash!} what="its update script" compact />
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** Asks which OS a machine runs when it couldn't be detected, so the right updater runs. */
function OsQuestion({ node, value, onChange }: { node: FleetNode; value: UpdateOs | undefined; onChange: (os: UpdateOs) => void }) {
  const why = node.os ? <>Couldn&apos;t tell from &ldquo;{node.os}&rdquo;</> : <>It hasn&apos;t been indexed yet</>;
  return (
    <div className={clsx("mt-2.5 rounded-lg border p-3", value ? "border-line-2 bg-void/40" : "border-yellow/30 bg-yellow/[0.06]")}>
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-fg-2">
        <HelpCircle size={14} className={value ? "text-fg-4" : "text-yellow"} />
        Which OS does <span className="font-mono">{node.id}</span> run?
      </div>
      <p className="mt-0.5 mb-2.5 text-[11.5px] leading-relaxed text-fg-4">
        {why}, so there&apos;s no knowing which updater to use. Your answer is saved to the machine.
      </p>
      <OsPicker value={value} onChange={onChange} label={`Which OS ${node.id} runs`} />
      {value && <p className="mt-2 text-[11.5px] text-fg-4">Runs <span className="font-mono text-fg-3">{updateOsInfo(value)?.command}</span></p>}
    </div>
  );
}

/** Which updater the system update will run, and whether the OS was detected or chosen. */
function UpdaterLine({ node, pkg, onEdit }: { node: FleetNode | undefined; pkg?: PkgManager; onEdit: () => void }) {
  const info = updateOsInfo(node?.updateOs);
  if (!node || !info) return null;
  return (
    <div className="mt-2.5 flex items-center gap-2 text-[12px] text-fg-4">
      <CloudDownload size={13} className="shrink-0" />
      <span>
        System update for <span className="text-fg-3">{info.label}</span> ({node.updateOsManual ? "chosen" : "detected"}): <span className="font-mono text-fg-3">{updaterLabel(node.updateOs, pkg)}</span>
      </span>
      <button type="button" onClick={onEdit} className="cursor-pointer text-blue hover:underline">
        Change
      </button>
    </div>
  );
}

/** A machine's own update steps, as the Update action will run them, with a way to edit them. */
export function UpdateScriptCard({ node, onEdit }: { node: FleetNode | undefined; onEdit: () => void }) {
  if (!node) return null;
  if (!node.updateScript) {
    return (
      <div className="mt-2.5 flex items-center gap-2 text-[12px] text-fg-4">
        <FileCode2 size={13} className="shrink-0" />
        <span>No update script.</span>
        <button type="button" onClick={onEdit} className="cursor-pointer text-blue hover:underline">
          Add your own steps
        </button>
      </div>
    );
  }
  return (
    <div className="mt-2.5 overflow-hidden rounded-lg border border-line-2 bg-void/40">
      <div className="flex items-center gap-2 border-b border-line-2 px-3 py-1.5">
        <FileCode2 size={13} className="shrink-0 text-fg-4" />
        <span className="text-[12px] font-medium text-fg-2">Update script</span>
        <span className="text-[11.5px] text-fg-4">runs {node.updateScriptWhen} the system update</span>
        <Button size="xs" variant="ghost" icon={Pencil} className="ml-auto" onClick={onEdit}>
          Edit
        </Button>
      </div>
      <pre className="max-h-40 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed text-fg-3">{node.updateScript}</pre>
      {node.updateScriptHash && (
        <div className="border-t border-line-2 px-3 py-2.5">
          <ApprovalNote node={node} hash={node.updateScriptHash} what="this update script" />
        </div>
      )}
    </div>
  );
}

export function PackageList({ info, loading, max = 200 }: { info?: { packages: { name: string; from: string; to: string }[] }; loading: boolean; max?: number }) {
  if (!info) {
    return (
      <div className="space-y-1.5 rounded-lg border border-line-2 bg-void/40 p-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-3.5 rounded" style={{ width: `${70 - i * 15}%` }} />
        ))}
      </div>
    );
  }
  if (info.packages.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-green/20 bg-green/[0.05] px-3 py-3 text-[12.5px] text-green">
        <Check size={14} /> Everything is up to date{loading ? "…" : "."}
      </div>
    );
  }
  return (
    <div className="max-h-64 overflow-y-auto rounded-lg border border-line-2 bg-void/40 py-1">
      {info.packages.slice(0, max).map((p) => (
        <div key={p.name} className="flex items-center gap-2 px-3 py-[5px] font-mono text-[11.5px] hover:bg-hl/40">
          <span className="min-w-0 flex-1 truncate text-fg-2">{p.name}</span>
          <span className="hidden max-w-[34%] truncate text-fg-5 sm:block">{p.from}</span>
          <ArrowRight size={11} className="shrink-0 text-fg-5" />
          <span className="max-w-[34%] truncate text-teal">{p.to}</span>
        </div>
      ))}
      {info.packages.length > max && <div className="px-3 py-1 text-[11px] text-fg-4">+{info.packages.length - max} more</div>}
    </div>
  );
}

/* ---------------- run command ---------------- */

/**
 * Runs a built-in command or a saved one; there is no free-form command line.
 * Saved commands only run on machines that approved them (lib/approval.ts).
 */
type RunPick = { kind: "check"; id: string } | { kind: "script"; id: string } | null;
type Draft = { id: string | null; name: string; script: string };

function RunDialog({
  dialog,
  onClose,
  onBatch,
}: {
  dialog: { nodes: string[] } | null;
  onClose: () => void;
  onBatch: (sessionIds: string[], cmd: string) => void;
}) {
  const fleet = useFleet();
  const term = useTerminals();
  const [pick, setPick] = useState<RunPick>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [scripts, setScripts] = useState<SavedScript[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [openedFor, setOpenedFor] = useState<typeof dialog>(null);

  if (dialog && dialog !== openedFor) {
    setOpenedFor(dialog);
    setPick(null);
    setDraft(null);
    setPicked(dialog.nodes.length ? dialog.nodes : fleet.nodes.filter((n) => fleet.states[n.id]?.status === "online").map((n) => n.id));
  }

  const load = useCallback(
    () =>
      api<{ scripts: SavedScript[] }>("GET", "/api/scripts").then(
        (r) => setScripts(r.scripts),
        (err) => {
          toast.error("Couldn't load your saved commands", { description: (err as Error).message });
          setScripts((s) => s ?? []);
        },
      ),
    [],
  );
  useEffect(() => {
    if (dialog) void load();
  }, [dialog, load]);

  const check = pick?.kind === "check" ? CHECKS.find((c) => c.id === pick.id) : undefined;
  const script = pick?.kind === "script" ? scripts?.find((s) => s.id === pick.id) : undefined;
  const nodeOf = (id: string) => fleet.nodes.find((n) => n.id === id);
  const stateOn = (id: string) => (script ? approvalOf(fleet.states[id]?.metrics, script.hash) : "approved");
  // A saved command is only started where it isn't known to be unapproved; the machine checks again anyway.
  const runnable = picked.filter((id) => stateOn(id) !== "pending");
  const blocked = picked.filter((id) => stateOn(id) === "pending");
  const label = check?.label ?? script?.name ?? "";

  const run = async () => {
    if (draft || (!check && !script) || runnable.length === 0) return;
    onClose();
    const ids: string[] = [];
    for (const id of runnable) {
      const spec = check ? { check: check.id } : { script: script!.id };
      const s = await term.open({ node: id, action: check ? "check" : "script", params: spec }, { focus: id === runnable[runnable.length - 1] });
      if (s) ids.push(s.id);
    }
    if (ids.length > 1) {
      onBatch(ids, label);
      toast(`Running on ${ids.length} machines`, { description: "You'll get a summary of exit codes when they all finish." });
    }
  };

  const saveDraft = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const body = { name: draft.name, script: draft.script };
      const s = draft.id ? await api<SavedScript>("PATCH", `/api/scripts/${draft.id}`, body) : await api<SavedScript>("POST", "/api/scripts", body);
      await load();
      setDraft(null);
      setPick({ kind: "script", id: s.id });
    } catch (err) {
      toast.error("Couldn't save the command", { description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: SavedScript) => {
    if (!window.confirm(`Delete the saved command “${s.name}”?`)) return;
    try {
      await api("DELETE", `/api/scripts/${s.id}`);
      if (pick?.kind === "script" && pick.id === s.id) setPick(null);
      await load();
    } catch (err) {
      toast.error("Couldn't delete the command", { description: (err as Error).message });
    }
  };

  const chip = (on: boolean) =>
    clsx(
      "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[12px] font-medium ring-1 transition-all ring-inset",
      on ? "bg-magenta/10 text-magenta ring-magenta/40" : "text-fg-3 ring-line-2 hover:text-fg hover:ring-line-3",
    );

  return (
    <Modal
      open={!!dialog}
      onClose={onClose}
      icon={SquareTerminal}
      tone="magenta"
      width={640}
      title="Run command"
      description="A built-in command, or one of your saved commands on the machines that approved it. One terminal tab per machine."
      footer={
        <>
          <span className="mr-auto hidden items-center gap-1.5 text-[11.5px] text-fg-4 sm:flex">
            <Kbd>Ctrl</Kbd>
            <Kbd>↵</Kbd> to run
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={Play}
            onClick={run}
            disabled={!!draft || (!check && !script) || runnable.length === 0}
            title={blocked.length ? `Not approved on ${blocked.join(", ")}` : undefined}
          >
            Run on {runnable.length} {runnable.length === 1 ? "machine" : "machines"}
          </Button>
        </>
      }
    >
      <div
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !draft) {
            e.preventDefault();
            run();
          }
        }}
      >
        <div className="mb-4 flex flex-wrap gap-1.5">
          <button
            onClick={() => {
              const all = fleet.nodes.filter((n) => fleet.displayStatus(n.id) === "online").map((n) => n.id);
              setPicked((p) => (p.length === all.length ? [] : all));
            }}
            className="inline-flex h-7 cursor-pointer items-center rounded-full px-3 text-[12px] font-medium text-fg-3 ring-1 ring-line-2 ring-inset hover:text-fg hover:ring-line-3"
          >
            All online
          </button>
          {fleet.nodes.map((n) => {
            const on = picked.includes(n.id);
            const st = fleet.displayStatus(n.id);
            const a = ACCENT[fleet.accent(n.id)];
            return (
              <button
                key={n.id}
                disabled={st !== "online"}
                onClick={() => setPicked((p) => (on ? p.filter((x) => x !== n.id) : [...p, n.id]))}
                className={clsx(
                  "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-3 font-mono text-[12px] font-medium ring-1 transition-all ring-inset disabled:cursor-not-allowed disabled:opacity-40",
                  on ? clsx(a.text, a.ring, a.soft) : "text-fg-4 ring-line-2 hover:text-fg-2 hover:ring-line-3",
                  st !== "online" && "line-through",
                )}
                title={st !== "online" ? `${n.id} is not reachable` : undefined}
              >
                <StatusDot status={st} size={6} />
                {n.id}
              </button>
            );
          })}
        </div>

        <div className="mb-1.5 text-[12px] font-medium text-fg-3">Built in</div>
        <div className="mb-4 flex flex-wrap gap-1.5">
          {CHECKS.map((c) => (
            <button key={c.id} type="button" onClick={() => setPick({ kind: "check", id: c.id })} className={chip(check?.id === c.id)} title={c.cmd}>
              {c.label}
            </button>
          ))}
        </div>

        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[12px] font-medium text-fg-3">Your commands</span>
          <span className="text-[11.5px] text-fg-4">run only where the machine approved them</span>
          {!draft && (
            <Button size="xs" variant="ghost" icon={Plus} className="ml-auto" onClick={() => setDraft({ id: null, name: "", script: "" })}>
              New
            </Button>
          )}
        </div>
        {draft ? (
          <div className="rounded-lg border border-magenta/30 bg-void/40 p-3">
            <input
              data-autofocus
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Name, like “prune docker images”"
              aria-label="Name"
              className="mb-2 h-8 w-full rounded-md border border-line-2 bg-void/60 px-2.5 text-[13px] text-fg placeholder:text-fg-5 focus:border-magenta/50 focus:outline-none"
            />
            <textarea
              value={draft.script}
              onChange={(e) => setDraft({ ...draft, script: e.target.value })}
              rows={Math.min(12, Math.max(4, draft.script.split("\n").length + 1))}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={"docker image prune -f\ndf -h /"}
              aria-label="Script"
              className="block w-full resize-y rounded-md border border-line-2 bg-void/60 px-2.5 py-2 font-mono text-[12.5px] text-fg placeholder:text-fg-5 focus:border-magenta/50 focus:outline-none"
            />
            <p className="mt-2 text-[11.5px] leading-relaxed text-fg-4">
              Runs with bash as the machine&apos;s ssh user. Before it runs anywhere, that machine has to approve it: you&apos;ll get a command to run there. Changing it later needs approving again.
            </p>
            <div className="mt-2.5 flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" loading={saving} disabled={!draft.name.trim() || !draft.script.trim()} onClick={saveDraft}>
                Save
              </Button>
            </div>
          </div>
        ) : scripts === null ? (
          <div className="skeleton h-9 rounded-lg" />
        ) : scripts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line-2 px-3 py-2.5 text-[12px] text-fg-4">
            None yet. Save a command once, approve it on the machines that should run it, then run it from here.
          </p>
        ) : (
          <div className="space-y-1">
            {scripts.map((s) => {
              const on = script?.id === s.id;
              const approvedOn = picked.filter((id) => approvalOf(fleet.states[id]?.metrics, s.hash) === "approved").length;
              return (
                <div
                  key={s.id}
                  className={clsx(
                    "flex items-center gap-2 rounded-lg border px-3 py-1.5 transition-colors",
                    on ? "border-magenta/40 bg-magenta/[0.07]" : "border-line-2 bg-void/30 hover:border-line-3",
                  )}
                >
                  <button type="button" onClick={() => setPick({ kind: "script", id: s.id })} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left">
                    <FileCode2 size={13} className={on ? "text-magenta" : "text-fg-4"} />
                    <span className="truncate text-[13px] font-medium text-fg-2">{s.name}</span>
                    {picked.length > 0 && (
                      <span className="shrink-0 text-[11.5px] text-fg-4">
                        approved on {approvedOn} of {picked.length}
                      </span>
                    )}
                  </button>
                  <Button size="xs" variant="ghost" icon={Pencil} aria-label={`Edit ${s.name}`} onClick={() => setDraft({ id: s.id, name: s.name, script: s.script })} />
                  <Button size="xs" variant="ghost" icon={Trash2} aria-label={`Delete ${s.name}`} onClick={() => remove(s)} />
                </div>
              );
            })}
          </div>
        )}

        {!draft && check && (
          <div className="mt-4 rounded-lg border border-line-2 bg-void/60 px-3 py-2 font-mono text-[12px] text-fg-3">
            <span className="text-magenta">❯</span> {check.cmd}
          </div>
        )}
        {!draft && script && (
          <div className="mt-4 space-y-2">
            <pre className="max-h-48 overflow-auto rounded-lg border border-line-2 bg-void/60 px-3 py-2 font-mono text-[12px] leading-relaxed text-fg-3">{script.script}</pre>
            {picked.map((id) => {
              const n = nodeOf(id);
              if (!n) return null;
              const st = stateOn(id);
              return st === "approved" ? (
                <div key={id} className="flex items-center gap-2 text-[12px] text-fg-4">
                  <span className="font-mono text-fg-3">{id}</span>
                  <ApprovalBadge state={st} />
                </div>
              ) : (
                <ApprovalNote key={id} node={n} hash={script.hash} what={`“${script.name}”`} compact={picked.length > 1} />
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}


export type { FleetNode };
