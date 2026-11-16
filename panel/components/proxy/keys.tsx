"use client";

import { Check, Copy, Eye, EyeOff, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { keyPreview, type UsageReport } from "@/lib/cpa-types";
import { Button, Empty, IconButton, Modal, Tooltip, useCopy } from "../ui";
import { ApiError, mgmt, proxyApi, tokens, useProxyData } from "./api";
import { ErrorCard } from "./accounts";
import { ConfirmRemove, Field, Section, inputCls, mask } from "./bits";

export function newClientKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return `sk-fleet-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function loadKeys(): Promise<string[]> {
  try {
    const r = await mgmt.get<unknown>("/config/access/api-keys");
    return Array.isArray(r) ? r.map(String) : [];
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return [];
    throw err;
  }
}

export function KeysView() {
  const keys = useProxyData(loadKeys, []);
  const usage = useProxyData(() => proxyApi.get<UsageReport>("/usage", { range: "30d" }), []);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [shown, setShown] = useState<Set<string>>(new Set());
  const { copied, copy } = useCopy();

  const save = async (list: string[]) => {
    await mgmt.put("/config/access/api-keys", list);
    await keys.reload();
  };
  const byKey = new Map((usage.data?.byKey ?? []).map((g) => [g.name, g]));

  return (
    <Section
      title="API keys"
      hint="What clients send as their API key (Authorization: Bearer, x-api-key or ?key=). Give each device or app its own, so usage shows who's who."
      right={
        <Button size="sm" variant="primary" icon={Plus} onClick={() => setAdding(true)}>
          New key
        </Button>
      }
    >
      {keys.error && !keys.data ? (
        <ErrorCard message={keys.error} onRetry={keys.reload} />
      ) : !keys.data ? (
        <div className="card skeleton h-24 rounded-xl opacity-50" />
      ) : keys.data.length === 0 ? (
        <div className="card rounded-xl">
          <Empty icon={KeyRound} title="No keys" hint="Without a key no client can use the proxy." />
        </div>
      ) : (
        <div className="card divide-y divide-line overflow-hidden rounded-xl">
          {keys.data.map((k) => {
            const u = byKey.get(keyPreview(k));
            const visible = shown.has(k);
            return (
              <div key={k} className="flex items-center gap-3 px-4 py-3 max-sm:flex-wrap max-sm:px-3">
                <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-yellow/10 text-yellow ring-1 ring-yellow/25 ring-inset">
                  <KeyRound size={15} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[13px] text-fg">{visible ? k : mask(k)}</div>
                  <div className="mt-0.5 text-[11.5px] text-fg-4 tabular">
                    {u ? (
                      <>
                        {u.requests.toLocaleString()} requests · {tokens(u.input + u.output)} tokens in 30 days
                        {u.errors > 0 && <span className="text-red"> · {u.errors} failed</span>}
                      </>
                    ) : (
                      "Not used in the last 30 days"
                    )}
                  </div>
                </div>
                <IconButton icon={visible ? EyeOff : Eye} label={visible ? "Hide" : "Show"} onClick={() => setShown((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; })} />
                <IconButton icon={copied === k ? Check : Copy} label={copied === k ? "Copied" : "Copy"} onClick={() => copy(k)} />
                <IconButton icon={Trash2} label="Remove" tone="danger" onClick={() => setRemoving(k)} />
              </div>
            );
          })}
        </div>
      )}

      <AddKeyDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdd={async (k) => {
          if (keys.data?.includes(k)) throw new Error("That key already exists");
          await save([...(keys.data ?? []), k]);
          void copy(k);
          toast.success("Key added and copied");
        }}
      />
      <ConfirmRemove
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remove this key?"
        description={
          <>
            Clients using <span className="font-mono text-fg-2">{removing ? mask(removing) : ""}</span> stop working right away.
            {keys.data?.length === 1 && " It's the last key: nothing will be able to use the proxy."}
          </>
        }
        onConfirm={async () => {
          await save((keys.data ?? []).filter((k) => k !== removing));
          toast.success("Key removed");
        }}
      />
    </Section>
  );
}

function AddKeyDialog({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (k: string) => Promise<void> }) {
  const [key, setKey] = useState(newClientKey);
  const [saving, setSaving] = useState(false);
  const submit = async () => {
    if (key.trim().length < 8) return toast.error("Use at least 8 characters");
    setSaving(true);
    try {
      await onAdd(key.trim());
      setKey(newClientKey());
      onClose();
    } catch (err) {
      toast.error("Couldn't add the key", { description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={KeyRound}
      tone="yellow"
      title="New API key"
      description="A random key is filled in. You can also paste one a client already uses."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={submit}>
            Add key
          </Button>
        </>
      }
    >
      <Field label="Key">
        <div className="flex gap-2">
          <input className={`${inputCls} font-mono`} value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} data-autofocus />
          <Tooltip content="Generate another">
            <Button variant="secondary" onClick={() => setKey(newClientKey())}>
              New
            </Button>
          </Tooltip>
        </div>
      </Field>
    </Modal>
  );
}
