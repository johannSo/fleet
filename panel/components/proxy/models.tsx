"use client";

import clsx from "clsx";
import { ArrowRight, Boxes, Check, Copy, EyeOff, FlaskConical, Plus, Search, Send, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { Credential } from "@/lib/cpa-types";
import { Badge, Button, Empty, IconButton, Modal, Tooltip, useCopy } from "../ui";
import { ApiError, mgmt, ms, proxyApi, useProxyData } from "./api";
import { ErrorCard } from "./accounts";
import { Field, ProviderMark, Section, inputCls, providerStyle, textareaCls } from "./bits";

interface Model {
  id: string;
  owned_by?: string;
}
interface Alias {
  name: string;
  alias: string;
  fork?: boolean;
  [k: string]: unknown;
}

const orEmpty =
  <T,>(fallback: T) =>
  (e: unknown): T => {
    if (e instanceof ApiError && e.status === 404) return fallback;
    throw e;
  };

export function ModelsView() {
  const models = useProxyData(() => proxyApi.get<{ models: Model[] }>("/models").then((r) => r.models), []);
  const aliases = useProxyData(() => mgmt.get<Record<string, Alias[]>>("/config/oauth/model-alias").catch(orEmpty({} as Record<string, Alias[]>)), []);
  const excluded = useProxyData(() => mgmt.get<Record<string, string[]>>("/config/oauth/excluded-models").catch(orEmpty({} as Record<string, string[]>)), []);
  const creds = useProxyData(() => mgmt.get<{ files: Credential[] }>("/credentials").then((r) => r.files ?? []), []);
  const channels = useMemo(() => [...new Set((creds.data ?? []).map((c) => (c.provider || c.type || "").toLowerCase()).filter(Boolean))].sort(), [creds.data]);
  const [query, setQuery] = useState("");
  const [test, setTest] = useState<string | null>(null);
  const { copied, copy } = useCopy();

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const m = new Map<string, Model[]>();
    for (const x of models.data ?? []) {
      if (q && !x.id.toLowerCase().includes(q)) continue;
      const owner = (x.owned_by || "other").toLowerCase();
      m.set(owner, [...(m.get(owner) ?? []), x]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models.data, query]);

  return (
    <>
      <Section
        title="Available models"
        hint="What clients can ask for right now: models of every signed-in account and upstream, plus your aliases."
        right={
          <div className="relative">
            <Search size={13} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-4" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter models" className="h-7.5 w-52 rounded-md border border-line-2 bg-panel/80 pr-2 pl-8 text-[12.5px] text-fg placeholder:text-fg-5 focus:border-blue/60 pointer-coarse:h-9" />
          </div>
        }
      >
        {models.error && !models.data ? (
          <ErrorCard message={models.error} onRetry={models.reload} />
        ) : !models.data ? (
          <div className="card skeleton h-32 rounded-xl opacity-50" />
        ) : models.data.length === 0 ? (
          <div className="card rounded-xl">
            <Empty icon={Boxes} title="No models yet" hint="Sign in to an account on the Accounts tab and its models appear here." />
          </div>
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {groups.map(([owner, list]) => (
              <div key={owner} className="card rounded-xl p-3">
                <div className="mb-2 flex items-center gap-2 px-1">
                  <ProviderMark provider={owner} size={20} />
                  <span className="text-[12.5px] font-medium text-fg-2">{providerStyle(owner).label || owner}</span>
                  <span className="text-[11.5px] text-fg-5 tabular">{list.length}</span>
                </div>
                <ul>
                  {list.map((m) => (
                    <li key={m.id} className="group flex items-center gap-1 rounded-md px-1 hover:bg-hover/60">
                      <span className="min-w-0 flex-1 truncate py-1.5 font-mono text-[12.5px] text-fg-2">{m.id}</span>
                      <IconButton icon={copied === m.id ? Check : Copy} label="Copy name" size={26} onClick={() => copy(m.id)} className="opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100" />
                      <IconButton icon={FlaskConical} label="Try it" size={26} onClick={() => setTest(m.id)} className="opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100" />
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      <AliasSection data={aliases.data} error={aliases.error} reload={aliases.reload} channels={channels} />
      <ExcludedSection data={excluded.data} error={excluded.error} reload={excluded.reload} channels={channels} />
      <TestDialog model={test} models={(models.data ?? []).map((m) => m.id)} onClose={() => setTest(null)} />
    </>
  );
}

/* ---------------- aliases ---------------- */

function AliasSection({ data, error, reload, channels }: { data: Record<string, Alias[]> | null; error: string | null; reload: () => void; channels: string[] }) {
  const [adding, setAdding] = useState(false);
  const rows = Object.entries(data ?? {}).flatMap(([ch, list]) => (Array.isArray(list) ? list.map((a, i) => ({ ch, a, i })) : []));
  const save = async (ch: string, list: Alias[]) => {
    if (list.length) await mgmt.put(`/config/oauth/model-alias/${ch}`, list);
    else await mgmt.del(`/config/oauth/model-alias/${ch}`);
    reload();
  };
  return (
    <Section
      title="Aliases"
      hint="Give a subscription model another name, e.g. let a client that only knows gpt-4o use Claude. Keep the original also listed, or replace it."
      right={
        <Button size="sm" variant="secondary" icon={Plus} onClick={() => setAdding(true)} disabled={!channels.length}>
          Add alias
        </Button>
      }
    >
      {error && !data ? (
        <ErrorCard message={error} onRetry={reload} />
      ) : rows.length === 0 ? (
        <div className="card rounded-xl px-4 py-5 text-[12.5px] text-fg-4">No aliases. Models keep their own names.</div>
      ) : (
        <div className="card divide-y divide-line overflow-hidden rounded-xl">
          {rows.map(({ ch, a, i }) => (
            <div key={`${ch}-${i}`} className="flex items-center gap-3 px-4 py-2.5 max-sm:px-3">
              <ProviderMark provider={ch} size={22} />
              <span className="font-mono text-[12.5px] text-fg">{a.alias}</span>
              <ArrowRight size={13} className="text-fg-5" />
              <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-fg-3">{a.name}</span>
              {a.fork ? <Badge tone="neutral">both listed</Badge> : <Badge tone="yellow">replaces</Badge>}
              <IconButton
                icon={Trash2}
                label="Remove alias"
                tone="danger"
                onClick={async () => {
                  try {
                    await save(
                      ch,
                      (data?.[ch] ?? []).filter((_, j) => j !== i),
                    );
                    toast.success("Alias removed");
                  } catch (err) {
                    toast.error("Couldn't remove it", { description: (err as Error).message });
                  }
                }}
              />
            </div>
          ))}
        </div>
      )}
      {adding && (
        <AddAliasDialog
          channels={channels}
          onClose={() => setAdding(false)}
          onAdd={async (ch, a) => {
            await save(ch, [...(data?.[ch] ?? []), a]);
            toast.success(`${a.alias} now goes to ${a.name}`);
            setAdding(false);
          }}
        />
      )}
    </Section>
  );
}

function AddAliasDialog({ channels, onClose, onAdd }: { channels: string[]; onClose: () => void; onAdd: (ch: string, a: Alias) => Promise<void> }) {
  const [ch, setCh] = useState(channels[0] ?? "claude");
  const [name, setName] = useState("");
  const [alias, setAlias] = useState("");
  const [fork, setFork] = useState(true);
  const [saving, setSaving] = useState(false);
  const defs = useProxyData(() => mgmt.get<{ models: { id: string; display_name?: string }[] }>(`/routing/model-definitions/${ch}`).then((r) => r.models ?? []).catch(() => []), [ch]);
  const submit = async () => {
    if (!name.trim() || !alias.trim()) return toast.error("Fill in both names");
    setSaving(true);
    try {
      await onAdd(ch, { name: name.trim(), alias: alias.trim(), ...(fork ? { fork: true } : {}) });
    } catch (err) {
      toast.error("Couldn't add it", { description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      icon={ArrowRight}
      title="Add an alias"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={submit}>
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Provider">
          <div className="flex flex-wrap gap-1.5">
            {channels.map((c) => (
              <button key={c} onClick={() => setCh(c)} className={clsx("flex h-8 cursor-pointer items-center gap-2 rounded-md border px-2 text-[12.5px]", ch === c ? "border-blue/50 bg-blue/10 text-fg" : "border-line-2 text-fg-3 hover:bg-hover")}>
                <ProviderMark provider={c} size={18} />
                {providerStyle(c).label || c}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Model it goes to">
          <input className={`${inputCls} font-mono`} list="alias-defs" value={name} onChange={(e) => setName(e.target.value)} placeholder="claude-sonnet-4-5-20250929" spellCheck={false} />
          <datalist id="alias-defs">
            {(defs.data ?? []).map((d) => (
              <option key={d.id} value={d.id}>
                {d.display_name}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Name clients use">
          <input className={`${inputCls} font-mono`} value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="sonnet" spellCheck={false} />
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-fg-3">
          <input type="checkbox" checked={fork} onChange={(e) => setFork(e.target.checked)} className="accent-blue" />
          Keep the original name available too
        </label>
      </div>
    </Modal>
  );
}

/* ---------------- excluded ---------------- */

function ExcludedSection({ data, error, reload, channels }: { data: Record<string, string[]> | null; error: string | null; reload: () => void; channels: string[] }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const all = [...new Set([...channels, ...Object.keys(data ?? {})])].sort();
  const save = async (ch: string, list: string[]) => {
    try {
      if (list.length) await mgmt.put(`/config/oauth/excluded-models/${ch}`, list);
      else await mgmt.del(`/config/oauth/excluded-models/${ch}`);
      reload();
    } catch (err) {
      toast.error("Couldn't save", { description: (err as Error).message });
    }
  };
  return (
    <Section title="Hidden models" hint={<>Models a provider&apos;s accounts won&apos;t serve. Wildcards work: <span className="font-mono">*-preview</span>, <span className="font-mono">gpt-5*</span>.</>}>
      {error && !data ? (
        <ErrorCard message={error} onRetry={reload} />
      ) : all.length === 0 ? (
        <div className="card rounded-xl px-4 py-5 text-[12.5px] text-fg-4">Sign in to an account first.</div>
      ) : (
        <div className="card divide-y divide-line overflow-hidden rounded-xl">
          {all.map((ch) => {
            const list = data?.[ch] ?? [];
            const add = () => {
              const v = (draft[ch] ?? "").trim();
              if (!v || list.includes(v)) return;
              void save(ch, [...list, v]);
              setDraft((d) => ({ ...d, [ch]: "" }));
            };
            return (
              <div key={ch} className="flex flex-wrap items-center gap-2 px-4 py-2.5 max-sm:px-3">
                <span className="flex w-36 items-center gap-2 text-[12.5px] text-fg-2">
                  <ProviderMark provider={ch} size={20} />
                  {providerStyle(ch).label || ch}
                </span>
                {list.map((p) => (
                  <span key={p} className="flex items-center gap-1 rounded-md bg-hl/70 py-0.5 pr-1 pl-2 font-mono text-[11.5px] text-fg-2">
                    <EyeOff size={11} className="text-fg-4" />
                    {p}
                    <button aria-label={`Show ${p} again`} onClick={() => save(ch, list.filter((x) => x !== p))} className="grid size-4 cursor-pointer place-items-center rounded text-fg-4 hover:bg-hover hover:text-red">
                      <X size={11} />
                    </button>
                  </span>
                ))}
                <input
                  value={draft[ch] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, [ch]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && add()}
                  placeholder="hide a model…"
                  className="h-7 w-40 rounded-md border border-transparent bg-transparent px-2 font-mono text-[12px] text-fg placeholder:text-fg-5 hover:border-line-2 focus:border-blue/60"
                />
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

/* ---------------- try a model ---------------- */

function TestDialog({ model, models, onClose }: { model: string | null; models: string[]; onClose: () => void }) {
  const [prompt, setPrompt] = useState("In one sentence: what model are you?");
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; status: number; ms: number; text: string } | null>(null);
  const current = pick ?? model ?? "";
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await proxyApi.post("/test", { model: current, prompt }));
    } catch (err) {
      setResult({ ok: false, status: 0, ms: 0, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={!!model}
      onClose={() => {
        setResult(null);
        setPick(null);
        onClose();
      }}
      icon={FlaskConical}
      width={600}
      title="Try a model"
      description="Sends one short chat completion through the proxy, exactly like a client would."
      footer={
        <Button variant="primary" icon={Send} loading={busy} onClick={run}>
          Send
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label="Model">
          <select value={current} onChange={(e) => setPick(e.target.value)} className={`${inputCls} font-mono`}>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </Field>
        <Field label="Prompt">
          <textarea className={textareaCls} rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>
        {result && (
          <div className={clsx("rounded-lg border p-3", result.ok ? "border-line-2 bg-void/50" : "border-red/25 bg-red/[0.05]")}>
            <div className="mb-1.5 flex items-center gap-2 text-[11.5px] text-fg-4">
              {result.ok ? <Badge tone="green">ok</Badge> : <Badge tone="red">{result.status || "error"}</Badge>}
              {result.ms > 0 && <span className="tabular">{ms(result.ms)}</span>}
            </div>
            <Tooltip content={null}>
              <p className={clsx("text-[13px] leading-relaxed whitespace-pre-wrap", result.ok ? "text-fg-2" : "text-red")}>{result.text || "(empty reply)"}</p>
            </Tooltip>
          </div>
        )}
      </div>
    </Modal>
  );
}
