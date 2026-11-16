"use client";

import clsx from "clsx";
import { AlertTriangle, Check, ChevronDown, Copy, KeyRound, Pencil, Plus, Server, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { explainError } from "@/lib/format";
import type { AddressEntry, FleetNode, MachineInput, NodeKind, UpdateScriptWhen } from "@/lib/types";
import { UPDATE_OSES, updateOsInfo, type UpdateOs } from "@/lib/update-os";
import { useFleet } from "./fleet-provider";
import { kindLabel } from "./node-icon";
import { inputCls, textareaCls } from "./proxy/bits";
import { Button, HoldButton, Modal, Spinner, useCopy } from "./ui";

export type MachineSection = "notes" | "connection" | "update";
export type MachineDialogState = { mode: "add" } | { mode: "edit"; id: string; section?: MachineSection } | null;

const KINDS: NodeKind[] = ["desktop", "laptop", "server", "vps", "raspberry-pi", "nas", "other"];

/** fetch + JSON with the server's error message on failure. */
export async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

interface Form {
  id: string;
  kind: NodeKind | "";
  host: string;
  user: string;
  port: string;
  alias: string;
  use: string;
  location: string;
  notes: string;
  mac: string;
  addresses: AddressEntry[];
  updateScript: string;
  updateScriptWhen: UpdateScriptWhen;
  /** "" for automatic. */
  updateOs: UpdateOs | "";
}

const EMPTY: Form = { id: "", kind: "", host: "", user: "", port: "", alias: "", use: "", location: "", notes: "", mac: "", addresses: [], updateScript: "", updateScriptWhen: "after", updateOs: "" };

function fromNode(n: FleetNode): Form {
  return {
    id: n.id,
    kind: n.kindSource === "manual" ? n.kind : "",
    host: n.ssh.host,
    user: n.ssh.user,
    port: n.ssh.port ? String(n.ssh.port) : "",
    alias: n.ssh.alias,
    use: n.use,
    location: n.location,
    notes: n.notes,
    mac: n.macSource === "manual" ? (n.mac ?? "") : "",
    addresses: n.addresses.map((a) => ({ ...a })),
    updateScript: n.updateScript,
    updateScriptWhen: n.updateScriptWhen,
    updateOs: n.updateOsManual ?? "",
  };
}

function toInput(f: Form): MachineInput {
  return {
    id: f.id.trim(),
    kind: f.kind || null,
    host: f.host,
    user: f.user,
    port: f.port.trim() ? Number(f.port) : null,
    alias: f.alias,
    use: f.use,
    location: f.location,
    notes: f.notes,
    mac: f.mac.trim() || null,
    addresses: f.addresses,
    updateScript: f.updateScript,
    updateScriptWhen: f.updateScriptWhen,
    updateOs: f.updateOs || null,
  };
}

/** Only the fields that differ, so an edit never overwrites what it didn't touch. */
function changes(before: Form, after: Form): MachineInput {
  const a = toInput(before) as Record<string, unknown>;
  const b = toInput(after) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(b)) if (k !== "id" && JSON.stringify(a[k]) !== JSON.stringify(b[k])) out[k] = b[k];
  return out as MachineInput;
}

export function Field({ label, hint, children, className }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={clsx("block min-w-0", className)}>
      <span className="mb-1 block text-[12px] font-medium text-fg-3">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] leading-relaxed text-fg-4">{hint}</span>}
    </label>
  );
}

function Section({ title, count, tag, children, action, open, onToggle, id }: { title: string; count?: number; tag?: string; children: React.ReactNode; action?: React.ReactNode; open: boolean; onToggle: () => void; id: string }) {
  return (
    <section id={id} className="border-t border-line pt-3">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onToggle} className="flex min-h-8 flex-1 cursor-pointer items-center gap-1.5 text-left text-[12.5px] font-semibold text-fg-2">
          <ChevronDown size={14} className={clsx("text-fg-4 transition-transform", !open && "-rotate-90")} />
          {title}
          {count ? <span className="rounded-full bg-hl px-1.5 text-[10.5px] text-fg-3 tabular">{count}</span> : null}
          {tag ? <span className="rounded-full bg-hl px-1.5 text-[10.5px] font-normal text-fg-3">{tag}</span> : null}
        </button>
        {open && action}
      </div>
      {open && <div className="pt-2.5 pb-1">{children}</div>}
    </section>
  );
}

/** The panel's public key and the one command that authorizes it on a machine. */
export function SshKeyHelp({ user, compact }: { user?: string; compact?: boolean }) {
  const [key, setKey] = useState<{ publicKey: string | null; user: string; host: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { copy, copied } = useCopy();
  useEffect(() => {
    api<{ publicKey: string | null; user: string; host: string }>("GET", "/api/panel/ssh-key").then(setKey, () => setKey(null));
  }, []);
  if (!key) return <Spinner size={13} className="text-fg-4" />;
  if (!key.publicKey) {
    return (
      <div className="space-y-2 text-[12px] text-fg-3">
        <p>The panel&apos;s machine ({key.host}) has no ssh key yet.</p>
        <Button
          size="sm"
          icon={KeyRound}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setKey(await api("POST", "/api/panel/ssh-key"));
            } catch (err) {
              toast.error("Couldn't create a key", { description: (err as Error).message });
            } finally {
              setBusy(false);
            }
          }}
        >
          Create one
        </Button>
      </div>
    );
  }
  const cmd = `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${key.publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
  return (
    <div className="space-y-2">
      {!compact && (
        <p className="text-[12px] leading-relaxed text-fg-3">
          Run this on the machine{user ? <> as <span className="font-mono text-fg-2">{user}</span></> : null} to let the panel ({key.user}@{key.host}) in:
        </p>
      )}
      <div className="flex items-start gap-2 rounded-lg border border-line-2 bg-void/50 p-2.5">
        <code className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-all text-fg-2">{cmd}</code>
        <button type="button" onClick={() => copy(cmd)} aria-label="Copy command" className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg pointer-coarse:size-10">
          {copied === cmd ? <Check size={14} className="text-green" /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

export function MachineDialog({ dialog, onClose }: { dialog: MachineDialogState; onClose: () => void }) {
  const fleet = useFleet();
  const router = useRouter();
  // Keep showing the last dialog's content while the modal animates out.
  const [kept, setKept] = useState(dialog);
  if (dialog && dialog !== kept) setKept(dialog);
  const shown = dialog ?? kept;
  const node = shown?.mode === "edit" ? fleet.nodes.find((n) => n.id === shown.id) : undefined;
  const [form, setForm] = useState<Form>(EMPTY);
  const [base, setBase] = useState<Form>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<FleetNode | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [open, setOpen] = useState({ addresses: false, update: false, advanced: false, key: false });

  // Reset whenever the dialog opens for something new.
  const key = dialog ? (dialog.mode === "add" ? "add" : `edit:${dialog.id}:${dialog.section ?? ""}`) : null;
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (key === lastKey.current) return;
    lastKey.current = key;
    if (!dialog) return;
    const f = dialog.mode === "edit" && node ? fromNode(node) : EMPTY;
    const t = setTimeout(() => {
      setForm(f);
      setBase(f);
      setError(null);
      setAdded(null);
      setBusy(false);
      setConfirmRemove(false);
      setOpen({
        addresses: false,
        update: dialog.mode === "edit" && dialog.section === "update",
        advanced: dialog.mode === "edit" && (!!f.alias || !!f.mac || !!f.port),
        key: false,
      });
      if (dialog.mode === "edit" && dialog.section) {
        setTimeout(() => document.getElementById(`machine-${dialog.section}`)?.scrollIntoView({ block: "start", behavior: "smooth" }), 280);
      }
    }, 0);
    return () => clearTimeout(t);
  }, [key, dialog, node]);

  const set = useCallback(<K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v })), []);
  const isAdd = shown?.mode === "add";
  const dirty = JSON.stringify(form) !== JSON.stringify(base);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isAdd) {
        const n = await api<FleetNode>("POST", "/api/machines", toInput(form));
        fleet.refresh();
        if (n.indexError && !n.local) {
          setAdded(n);
        } else {
          toast.success(`Added ${n.id}`, { description: [n.model, n.os].filter(Boolean).join(" · ") || undefined });
          onClose();
          router.push(`/nodes/${encodeURIComponent(n.id)}`);
        }
      } else if (node) {
        const patch = changes(base, form);
        if (Object.keys(patch).length) {
          const n = await api<FleetNode>("PATCH", `/api/machines/${encodeURIComponent(node.id)}`, patch);
          fleet.refresh();
          if (n.indexError && ("host" in patch || "user" in patch || "port" in patch || "alias" in patch)) {
            toast.error(`Saved, but can't reach ${n.id}`, { description: `${explainError(n.indexError)}\n${n.indexError}` });
          } else toast.success(`Saved ${n.id}`);
        }
        onClose();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!added) return;
    setBusy(true);
    try {
      const n = await api<FleetNode>("POST", `/api/machines/${encodeURIComponent(added.id)}/index`);
      fleet.refresh();
      if (n.indexError) {
        setAdded(n);
        toast.error(`Still can't reach ${n.id}`, { description: n.indexError });
      } else {
        toast.success(`${n.id} is connected`, { description: [n.model, n.os].filter(Boolean).join(" · ") || undefined });
        onClose();
        router.push(`/nodes/${encodeURIComponent(n.id)}`);
      }
    } catch (err) {
      toast.error("Couldn't index it", { description: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!node) return;
    try {
      await api("DELETE", `/api/machines/${encodeURIComponent(node.id)}`);
      fleet.refresh();
      toast.success(`Removed ${node.id}`, { description: "Its activity history stays in the log." });
      onClose();
      router.push("/");
    } catch (err) {
      toast.error("Couldn't remove it", { description: (err as Error).message });
    }
  };

  const title = added ? (
    <>
      Added <span className="font-mono">{added.id}</span>, but can&apos;t reach it yet
    </>
  ) : isAdd ? (
    "Add a machine"
  ) : (
    <>
      Edit <span className="font-mono">{node?.id}</span>
    </>
  );

  /* ---------- after adding: connection failed ---------- */
  if (added) {
    return (
      <Modal
        open={!!dialog}
        onClose={onClose}
        icon={AlertTriangle}
        tone="yellow"
        width={600}
        title={title}
        description={
          <>
            {explainError(added.indexError)}. <span className="font-mono text-[11.5px] text-fg-4">{added.indexError}</span>
          </>
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => { onClose(); router.push(`/nodes/${encodeURIComponent(added.id)}`); }}>
              Done, try later
            </Button>
            <Button variant="primary" loading={busy} onClick={retry}>
              Try again
            </Button>
          </>
        }
      >
        <div className="space-y-3 pb-2 text-[12.5px] leading-relaxed text-fg-3">
          <p>
            The panel connects with <span className="font-mono text-fg-2">{added.sshCommand}</span> using its own ssh key. Make sure sshd runs there and the key is authorized, then try again. It also retries by itself whenever the machine is online.
          </p>
          <SshKeyHelp user={added.ssh.user || undefined} />
        </div>
      </Modal>
    );
  }

  /* ---------- remove confirmation ---------- */
  if (confirmRemove && node) {
    return (
      <Modal
        open={!!dialog}
        onClose={() => setConfirmRemove(false)}
        icon={Trash2}
        tone="red"
        title={
          <>
            Remove <span className="font-mono">{node.id}</span>?
          </>
        }
        description="It disappears from the panel and the Claude skill. Its activity history and usage stay. Nothing on the machine itself changes."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
            <HoldButton icon={Trash2} onConfirm={remove}>
              Hold to remove
            </HoldButton>
          </>
        }
      />
    );
  }

  /* ---------- the form ---------- */
  const detectedKind = node?.hardware?.kind;
  const detectedMac = node?.macSource === "detected" ? node.mac : null;
  const detectedOs = node?.updateOsDetected ?? null;
  return (
    <Modal
      open={!!dialog}
      onClose={onClose}
      icon={isAdd ? Server : Pencil}
      tone="blue"
      width={640}
      title={title}
      description={
        isAdd
          ? "Name it and say how to reach it. The panel indexes its hardware, addresses and what runs on it over ssh."
          : "Hardware, addresses and workloads are indexed automatically; this is what the index can't know."
      }
      footer={
        <>
          {!isAdd && (
            <Button variant="ghost" icon={Trash2} className="mr-auto text-red hover:bg-red/10 hover:text-red" onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          )}
          {error && <span className="mr-auto min-w-0 flex-1 text-[12px] text-red max-sm:basis-full">{error}</span>}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={isAdd ? !form.id.trim() : !dirty} onClick={save}>
            {busy && isAdd ? "Connecting…" : isAdd ? "Add machine" : "Save"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3.5 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_200px]">
          {isAdd ? (
            <Field label="Name" hint="Short, like pc or nas. Can't be changed later.">
              <input className={clsx(inputCls, "font-mono")} value={form.id} onChange={(e) => set("id", e.target.value)} placeholder="nas" autoCapitalize="off" autoCorrect="off" spellCheck={false} data-autofocus />
            </Field>
          ) : (
            <Field label="What it's for">
              <input className={inputCls} value={form.use} onChange={(e) => set("use", e.target.value)} placeholder="backups and media" />
            </Field>
          )}
          <Field label="Type">
            <select className={inputCls} value={form.kind} onChange={(e) => set("kind", e.target.value as NodeKind | "")}>
              <option value="">{detectedKind ? `Detected: ${kindLabel(detectedKind)}` : "Detect automatically"}</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {kindLabel(k)}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div id="machine-connection" className="grid grid-cols-[1fr_120px] gap-3 sm:grid-cols-[1fr_140px_88px]">
          <Field label="Host" className="col-span-2 sm:col-span-1">
            <input className={clsx(inputCls, "font-mono")} value={form.host} onChange={(e) => set("host", e.target.value)} placeholder="192.168.1.20 or nas.local" autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url" />
          </Field>
          <Field label="User">
            <input className={clsx(inputCls, "font-mono")} value={form.user} onChange={(e) => set("user", e.target.value)} placeholder="user" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          </Field>
          <Field label="Port">
            <input className={clsx(inputCls, "font-mono")} value={form.port} onChange={(e) => set("port", e.target.value.replace(/\D/g, ""))} placeholder="22" inputMode="numeric" />
          </Field>
        </div>
        <div className="-mt-1.5 text-[11.5px] leading-relaxed text-fg-4">
          The panel connects as user@host with its own ssh key; leave the host empty for a machine it can&apos;t reach.{" "}
          <button type="button" className="cursor-pointer text-blue hover:underline" onClick={() => setOpen((o) => ({ ...o, key: !o.key }))}>
            {open.key ? "Hide the panel's key" : "Show the panel's key"}
          </button>
          {open.key && (
            <div className="mt-2">
              <SshKeyHelp user={form.user || undefined} />
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_200px]">
          {isAdd && (
            <Field label="What it's for">
              <input className={inputCls} value={form.use} onChange={(e) => set("use", e.target.value)} placeholder="backups and media" />
            </Field>
          )}
          <Field label="Location" className={isAdd ? "" : "sm:col-span-2"}>
            <input className={inputCls} value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="home, office, Hetzner…" />
          </Field>
        </div>

        <Field label="Notes" hint={<>Gotchas, history, how things are set up. `code`, **bold** and links render.</>}>
          <textarea id="machine-notes" className={clsx(textareaCls, "font-sans")} rows={4} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Login shell is fish, so pipe scripts through bash -s" />
        </Field>

        <Section
          id="machine-addresses"
          title="Extra addresses"
          count={form.addresses.length}
          open={open.addresses}
          onToggle={() => setOpen((o) => ({ ...o, addresses: !o.addresses }))}
          action={
            <Button type="button" size="xs" variant="subtle" icon={Plus} onClick={() => set("addresses", [...form.addresses, { label: "", address: "", notes: "" }])}>
              Add
            </Button>
          }
        >
          <p className="mb-2.5 text-[11.5px] text-fg-4">Addresses on the machine&apos;s interfaces are detected. Add others (a DNS name, a forwarded port) or notes on a detected one by entering the same address.</p>
          {form.addresses.length === 0 && <p className="py-2 text-center text-[12px] text-fg-5">None.</p>}
          <div className="space-y-2">
            {form.addresses.map((a, i) => (
              <div key={i} className="rounded-lg border border-line-2 bg-void/30 p-2">
                <div className="flex gap-2">
                  <input className={clsx(inputCls, "h-8 w-28")} value={a.label} placeholder="Label" aria-label="Label" onChange={(e) => set("addresses", form.addresses.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  <input className={clsx(inputCls, "h-8 flex-1 font-mono")} value={a.address} placeholder="Address" aria-label="Address" onChange={(e) => set("addresses", form.addresses.map((x, j) => (j === i ? { ...x, address: e.target.value } : x)))} />
                  <button type="button" aria-label="Remove address" onClick={() => set("addresses", form.addresses.filter((_, j) => j !== i))} className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-fg-4 hover:bg-red/10 hover:text-red pointer-coarse:size-11">
                    <Trash2 size={14} />
                  </button>
                </div>
                <input className={clsx(inputCls, "mt-2 h-8 text-[12px]")} value={a.notes} placeholder="Notes" aria-label="Notes" onChange={(e) => set("addresses", form.addresses.map((x, j) => (j === i ? { ...x, notes: e.target.value } : x)))} />
              </div>
            ))}
          </div>
        </Section>

        <Section
          id="machine-update"
          title="Update"
          tag={[form.updateOs && updateOsInfo(form.updateOs)?.label, form.updateScript.trim() && `script runs ${form.updateScriptWhen}`].filter(Boolean).join(" · ") || undefined}
          open={open.update}
          onToggle={() => setOpen((o) => ({ ...o, update: !o.update }))}
        >
          <div className="mb-1 text-[12px] font-medium text-fg-3">System update</div>
          <p className="mb-2 text-[11.5px] leading-relaxed text-fg-4">
            {detectedOs ? (
              <>
                Detected <span className="text-fg-3">{updateOsInfo(detectedOs)?.label}</span>, so Update runs <span className="font-mono">{updateOsInfo(form.updateOs || detectedOs)?.command}</span>. Pick another OS only if that&apos;s wrong.
              </>
            ) : (
              <>Its OS couldn&apos;t be detected{node?.os ? <> from &ldquo;{node.os}&rdquo;</> : node ? " (not indexed yet)" : " until it's indexed"}. Pick it here, or Update will ask.</>
            )}
          </p>
          <div className="mb-4 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Which OS the system update is for">
            {[{ id: "" as const, label: detectedOs ? `Auto (${updateOsInfo(detectedOs)?.label})` : "Auto", command: "" }, ...UPDATE_OSES].map((o) => (
              <button
                key={o.id || "auto"}
                type="button"
                role="radio"
                aria-checked={form.updateOs === o.id}
                title={o.command ? `Runs ${o.command}` : "Detect it from the indexed OS"}
                onClick={() => set("updateOs", o.id)}
                className={clsx(
                  "min-h-8 cursor-pointer rounded-md border px-2.5 text-[12px] font-medium transition-colors pointer-coarse:min-h-10",
                  form.updateOs === o.id ? "border-blue/50 bg-blue/[0.12] text-fg" : "border-line-2 bg-void/40 text-fg-3 hover:border-line-3 hover:text-fg-2",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          <div className="mb-1 text-[12px] font-medium text-fg-3">Update script</div>
          <p className="mb-2.5 text-[11.5px] leading-relaxed text-fg-4">
            Your own update steps, like pulling new container images. <span className="text-fg-3">Update</span> runs them in the same terminal tab as the system update, with bash. If one step fails, the next one is skipped. <span className="font-mono">$FLEET_UPDATE_AUTO</span> is 1 when prompts are auto-answered.
          </p>
          <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-fg-3">
            Run it
            <div className="inline-flex h-8 rounded-md border border-line-2 bg-void/40 p-0.5 pointer-coarse:h-10" role="radiogroup" aria-label="When the update script runs">
              {(["before", "after"] as const).map((w) => (
                <button
                  key={w}
                  type="button"
                  role="radio"
                  aria-checked={form.updateScriptWhen === w}
                  onClick={() => set("updateScriptWhen", w)}
                  className={clsx(
                    "cursor-pointer rounded-[5px] px-2.5 text-[12px] font-medium transition-colors",
                    form.updateScriptWhen === w ? "bg-hl text-fg" : "text-fg-4 hover:text-fg-2",
                  )}
                >
                  {w === "before" ? "Before" : "After"}
                </button>
              ))}
            </div>
            the system update
          </div>
          <textarea
            className={clsx(textareaCls, "font-mono text-[12px]")}
            rows={Math.min(14, Math.max(5, form.updateScript.split("\n").length + 1))}
            value={form.updateScript}
            onChange={(e) => set("updateScript", e.target.value)}
            placeholder={"cd ~/stacks/media\ndocker compose pull\ndocker compose up -d\ndocker image prune -f"}
            aria-label="Update script"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </Section>

        <Section id="machine-advanced" title="Advanced" open={open.advanced} onToggle={() => setOpen((o) => ({ ...o, advanced: !o.advanced }))}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="ssh alias" hint="Shown as “ssh alias” in the skill. Used to connect only when Host is empty, from ~/.ssh/config on the panel's machine.">
              <input className={clsx(inputCls, "font-mono")} value={form.alias} onChange={(e) => set("alias", e.target.value)} placeholder="nas" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            </Field>
            <Field label="Wake-on-LAN MAC" hint={detectedMac ? <>Detected: <span className="font-mono">{detectedMac}</span>. Fill in only to use another.</> : "Detected from the wired interface when indexed."}>
              <input className={clsx(inputCls, "font-mono")} value={form.mac} onChange={(e) => set("mac", e.target.value)} placeholder={detectedMac ?? "aa:bb:cc:dd:ee:ff"} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            </Field>
          </div>
        </Section>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
