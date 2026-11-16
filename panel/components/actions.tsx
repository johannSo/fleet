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
  RotateCw,
  SquareTerminal,
  TerminalSquare,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ago } from "@/lib/format";
import type { FleetNode, PkgManager } from "@/lib/types";
import { UPDATE_OSES, updateOsInfo, type UpdateOs } from "@/lib/update-os";
import { rebootHint, useFleet } from "./fleet-provider";
import { useTerminals } from "./terminal-provider";
import { DevicesDialog } from "./devices";
import { api, MachineDialog, type MachineDialogState, type MachineSection } from "./machine-editor";
import { useIsMobile } from "./hooks";
import { Md } from "./md";
import { ACCENT, Badge, Button, HoldButton, Kbd, Modal, Spinner, StatusDot } from "./ui";

type Dialog =
  | { type: "power"; node: string; kind: "reboot" | "shutdown" }
  | { type: "update"; nodes: string[] }
  | { type: "run"; nodes: string[]; cmd?: string }
  | { type: "devices" }
  | { type: "machine"; state: NonNullable<MachineDialogState> }
  | null;

interface ActionsCtx {
  shell: (node: string) => void;
  power: (node: string, kind: "reboot" | "shutdown") => void;
  update: (nodes: string | string[]) => void;
  run: (nodes?: string[], cmd?: string) => void;
  devices: () => void;
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

  const shell = useCallback(
    (node: string) => {
      term.open({ node, action: "shell" });
    },
    [term],
  );

  const value = useMemo<ActionsCtx>(
    () => ({
      shell,
      power: (node, kind) => setDialog({ type: "power", node, kind }),
      update: (nodes) => setDialog({ type: "update", nodes: Array.isArray(nodes) ? nodes : [nodes] }),
      run: (nodes, cmd) => setDialog({ type: "run", nodes: nodes ?? [], cmd }),
      devices: () => setDialog({ type: "devices" }),
      addMachine: () => setDialog({ type: "machine", state: { mode: "add" } }),
      editMachine: (id, section) => setDialog({ type: "machine", state: { mode: "edit", id, section } }),
    }),
    [shell],
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
      <DevicesDialog open={dialog?.type === "devices"} onClose={close} />
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
            disabled={picked.length === 0 || missingOs.length > 0}
            title={missingOs.length ? `Choose which OS ${missingOs.join(", ")} ${missingOs.length === 1 ? "runs" : "run"} first` : undefined}
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
                  {n.updateScript && <Badge tone="neutral" icon={FileCode2}>script</Badge>}
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

const SNIPPETS: { label: string; cmd: string }[] = [
  { label: "uptime", cmd: "uptime" },
  { label: "disk usage", cmd: "df -h -x tmpfs -x devtmpfs -x efivarfs" },
  { label: "memory", cmd: "free -h" },
  { label: "failed units", cmd: "systemctl --failed --no-pager" },
  { label: "errors this boot", cmd: "journalctl -p err -b --no-pager -n 50" },
  { label: "containers", cmd: "docker ps -a 2>/dev/null || sudo docker ps -a" },
  { label: "htop", cmd: "htop || top" },
];

function RunDialog({
  dialog,
  onClose,
  onBatch,
}: {
  dialog: { nodes: string[]; cmd?: string } | null;
  onClose: () => void;
  onBatch: (sessionIds: string[], cmd: string) => void;
}) {
  const fleet = useFleet();
  const term = useTerminals();
  const [cmd, setCmd] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [openedFor, setOpenedFor] = useState<typeof dialog>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  if (dialog && dialog !== openedFor) {
    setOpenedFor(dialog);
    setCmd(dialog.cmd ?? "");
    setPicked(
      dialog.nodes.length
        ? dialog.nodes
        : fleet.nodes.filter((n) => fleet.states[n.id]?.status === "online").map((n) => n.id),
    );
  }

  const run = async () => {
    const c = cmd.trim();
    if (!c || picked.length === 0) return;
    onClose();
    const ids: string[] = [];
    for (const id of picked) {
      const s = await term.open({ node: id, action: "exec", params: { cmd: c } }, { focus: id === picked[picked.length - 1] });
      if (s) ids.push(s.id);
    }
    if (ids.length > 1) {
      onBatch(ids, c);
      toast(`Running on ${ids.length} machines`, { description: "You'll get a summary of exit codes when they all finish." });
    }
  };

  return (
    <Modal
      open={!!dialog}
      onClose={onClose}
      icon={SquareTerminal}
      tone="magenta"
      width={600}
      title="Run command"
      description="One terminal tab per machine, as your ssh user. Prefix sudo if needed."
      footer={
        <>
          <span className="mr-auto hidden items-center gap-1.5 text-[11.5px] text-fg-4 sm:flex">
            <Kbd>Ctrl</Kbd>
            <Kbd>↵</Kbd> to run
          </span>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={Play} onClick={run} disabled={!cmd.trim() || picked.length === 0}>
            Run on {picked.length} {picked.length === 1 ? "machine" : "machines"}
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap gap-1.5">
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
      <div className="group relative rounded-lg border border-line-2 bg-void/60 transition-colors focus-within:border-magenta/50">
        <span className="pointer-events-none absolute top-[11px] left-3 font-mono text-[13px] text-magenta">❯</span>
        <textarea
          ref={area}
          data-autofocus
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              run();
            }
          }}
          rows={3}
          spellCheck={false}
          placeholder="uptime && df -h /"
          className="block w-full resize-none bg-transparent py-2.5 pr-3 pl-8 font-mono text-[13px] text-fg placeholder:text-fg-5 focus:outline-none"
        />
      </div>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {SNIPPETS.map((s) => (
          <button
            key={s.label}
            onClick={() => {
              setCmd(s.cmd);
              area.current?.focus();
            }}
            className="cursor-pointer rounded-md bg-hl/50 px-2 py-1 text-[11.5px] text-fg-3 transition-colors hover:bg-hl hover:text-fg"
          >
            {s.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}

export type { FleetNode };
