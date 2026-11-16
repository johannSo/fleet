"use client";

import clsx from "clsx";
import {
  Ban,
  Boxes,
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  Gauge,
  KeyRound,
  LogIn,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Timer,
  Trash2,
  Upload,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { KEY_PROVIDERS, OAUTH_PROVIDERS, type Credential } from "@/lib/cpa-types";
import { ago } from "@/lib/format";
import { Badge, Button, Empty, IconButton, Menu, Meter, Modal, Spinner, Tooltip, useCopy, type MenuItem, type Tone } from "../ui";
import { ApiError, mgmt, useNow, useProxyData, until } from "./api";
import { ConfirmRemove, Field, ProviderMark, RequestBars, Section, inputCls, mask, providerStyle, textareaCls } from "./bits";

/* ---------------- health ---------------- */

interface Health {
  label: string;
  tone: Tone;
  detail?: string;
}

export function credentialHealth(c: Credential, now = Date.now()): Health {
  if (c.disabled) return { label: "Disabled", tone: "neutral" };
  if (c.requires_sign_in || c.next_action === "sign_in") return { label: "Sign in again", tone: "red", detail: c.recovery_hint || c.refresh_error?.message || "The token can't be renewed" };
  const cds = (c.cooldowns ?? []).filter((x) => !x.retry_at || Date.parse(x.retry_at) > now);
  const whole = cds.find((x) => x.scope === "credential");
  if (whole) return { label: `Resting · ${until(whole.retry_at, now)}`, tone: "yellow", detail: cooldownReason(whole.reason, whole.http_status) };
  if (c.status === "error" || c.unavailable) return { label: "Error", tone: "red", detail: c.status_message || c.refresh_error?.message };
  if (c.status === "refreshing" || c.status === "pending") return { label: "Refreshing", tone: "blue" };
  if (cds.length) return { label: `${cds.length} model${cds.length === 1 ? "" : "s"} resting`, tone: "yellow", detail: cds.map((x) => `${x.model_key}: ${cooldownReason(x.reason, x.http_status)} (${until(x.retry_at, now)})`).join("\n") };
  return { label: "Active", tone: "green" };
}

function cooldownReason(reason?: string, status?: number): string {
  const r: Record<string, string> = {
    credential_quota: "usage limit reached",
    quota: "usage limit reached",
    transient_rate_limit: "rate limited",
    cloudflare_challenge: "blocked by Cloudflare",
    model_not_supported: "model not available on this plan",
    invalid_grant: "sign-in expired",
    payment_required: "payment required",
  };
  return `${r[reason ?? ""] ?? reason ?? "unavailable"}${status ? ` (HTTP ${status})` : ""}`;
}

const planOf = (c: Credential) => {
  const t = c.id_token as { plan_type?: string } | undefined;
  return t?.plan_type || (typeof c.plan_type === "string" ? c.plan_type : null);
};
const who = (c: Credential) => c.email || c.label || c.account || c.project_id || c.name;

/* ---------------- page ---------------- */

export function AccountsView() {
  const creds = useProxyData(() => mgmt.get<{ files: Credential[] }>("/credentials").then((r) => r.files ?? []), [], 15_000);
  const groups = useProxyData(
    () =>
      mgmt.get<Record<string, KeyGroup[]>>("/config/api-keys").catch((e) => {
        if (e instanceof ApiError && e.status === 404) return {} as Record<string, KeyGroup[]>;
        throw e;
      }),
    [],
  );
  const [signIn, setSignIn] = useState<{ provider?: string; target?: Credential } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const upload = useRef<HTMLInputElement>(null);

  const byProvider = useMemo(() => {
    const m = new Map<string, Credential[]>();
    for (const c of creds.data ?? []) {
      const p = (c.provider || c.type || "unknown").toLowerCase();
      m.set(p, [...(m.get(p) ?? []), c]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [creds.data]);

  const refreshAll = async () => {
    setRefreshing(true);
    try {
      const r = await mgmt.post<{ results?: { id: string; success: boolean; error?: string }[] }>("/credentials/refresh", { all: true });
      const failed = (r.results ?? []).filter((x) => !x.success);
      if (failed.length) toast.error(`${failed.length} account${failed.length === 1 ? "" : "s"} couldn't refresh`, { description: failed.map((f) => `${f.id}: ${f.error ?? "failed"}`).join("\n") });
      else toast.success("Every token is fresh");
      void creds.reload();
    } catch (err) {
      toast.error("Refresh failed", { description: (err as Error).message });
    } finally {
      setRefreshing(false);
    }
  };

  const onUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    const form = new FormData();
    for (const f of files) form.append("file", f, f.name);
    try {
      await mgmt.post("/credentials", form);
      toast.success(`Imported ${files.length} account file${files.length === 1 ? "" : "s"}`);
      void creds.reload();
    } catch (err) {
      toast.error("Import failed", { description: (err as Error).message });
    }
    if (upload.current) upload.current.value = "";
  };

  return (
    <>
      <Section
        title="Subscriptions"
        hint="Accounts you signed in to. Requests rotate across every healthy account of a provider, and rest an account when it hits its limit."
        right={
          <>
            <input ref={upload} type="file" accept=".json,application/json" multiple hidden onChange={(e) => onUpload(e.target.files)} />
            <Tooltip content="Import token files from another CLIProxyAPI (auth-dir *.json)">
              <Button size="sm" variant="ghost" icon={Upload} onClick={() => upload.current?.click()}>
                Import
              </Button>
            </Tooltip>
            <Button size="sm" variant="secondary" icon={RefreshCw} loading={refreshing} onClick={refreshAll} disabled={!creds.data?.length}>
              Refresh tokens
            </Button>
            <Button size="sm" variant="primary" icon={LogIn} onClick={() => setSignIn({})}>
              Sign in
            </Button>
          </>
        }
      >
        {creds.error && !creds.data ? (
          <ErrorCard message={creds.error} onRetry={creds.reload} />
        ) : creds.loading && !creds.data ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="card skeleton h-[74px] rounded-xl opacity-50" />
            ))}
          </div>
        ) : !byProvider.length ? (
          <div className="card rounded-xl">
            <Empty
              icon={Users}
              title="No accounts yet"
              hint={
                <>
                  Sign in with a Claude, ChatGPT (Codex), Google (Antigravity) or Grok subscription. Then point any OpenAI, Anthropic or Gemini client at the proxy.
                  <div className="mt-4">
                    <Button size="sm" variant="primary" icon={LogIn} onClick={() => setSignIn({})}>
                      Sign in
                    </Button>
                  </div>
                </>
              }
            />
          </div>
        ) : (
          <div className="space-y-5">
            {byProvider.map(([provider, list]) => (
              <div key={provider}>
                <div className="mb-2 flex items-center gap-2 px-1">
                  <span className={clsx("text-[12.5px] font-semibold", providerStyle(provider).text)}>{providerStyle(provider).label || provider}</span>
                  <span className="text-[11.5px] text-fg-5 tabular">
                    {list.filter((c) => credentialHealth(c).tone === "green").length}/{list.length} active
                  </span>
                </div>
                <div className="card divide-y divide-line overflow-hidden rounded-xl">
                  {list.map((c) => (
                    <CredentialRow key={c.name} c={c} onChanged={creds.reload} onSignIn={() => setSignIn({ provider, target: c })} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      <KeyGroupsSection groups={groups.data} error={groups.error} reload={groups.reload} />

      <SignInDialog
        open={!!signIn}
        initial={signIn?.provider}
        target={signIn?.target}
        onClose={() => setSignIn(null)}
        onDone={() => {
          setSignIn(null);
          void creds.reload();
        }}
      />
    </>
  );
}

export function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="card flex items-start gap-3 rounded-xl border-red/25 p-4">
      <CircleAlert size={16} className="mt-0.5 shrink-0 text-red" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-fg">Can&apos;t reach the proxy</div>
        <div className="mt-0.5 text-[12.5px] break-words text-fg-3">{message}</div>
      </div>
      <Button size="sm" variant="secondary" icon={RotateCcw} onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

/* ---------------- one account ---------------- */

function CredentialRow({ c, onChanged, onSignIn }: { c: Credential; onChanged: () => void; onSignIn: () => void }) {
  const [open, setOpen] = useState(false);
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const h = credentialHealth(c);
  const provider = (c.provider || c.type || "").toLowerCase();
  const plan = planOf(c);
  const total = (c.success ?? 0) + (c.failed ?? 0);

  const act = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label);
    try {
      await fn();
      if (ok) toast.success(ok);
      onChanged();
    } catch (err) {
      toast.error(`${label} failed`, { description: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const items: MenuItem[] = [
    { label: "Refresh token", icon: RefreshCw, onSelect: () => act("Refresh", () => mgmt.post("/credentials/refresh", { name: c.name }), "Token refreshed") },
    {
      label: "Verify with a test request",
      icon: ShieldCheck,
      onSelect: () =>
        act("Verify", async () => {
          const r = await mgmt.post<{ verified?: boolean; error?: string }>("/credentials/verify", { name: c.name });
          if (!r.verified) throw new Error(r.error || "Not verified");
          toast.success("The account answered");
        }),
    },
    ...((c.cooldowns ?? []).length && c.auth_index != null
      ? [{ label: "End the rest early", icon: Timer, onSelect: () => act("Reset", () => mgmt.post("/routing/cooldown/reset", { auth_index: String(c.auth_index) }), "Back in rotation") }]
      : []),
    { label: "Sign in again", icon: LogIn, onSelect: onSignIn },
    { label: "Priority, weight & note…", icon: Pencil, onSelect: () => setEdit(true) },
    { label: c.disabled ? "Enable" : "Disable", icon: c.disabled ? Play : Ban, onSelect: () => act(c.disabled ? "Enable" : "Disable", () => mgmt.patch("/credentials/status", { name: c.name, disabled: !c.disabled }), c.disabled ? "Enabled" : "Disabled"), separatorBefore: true },
    { label: "Download token file", icon: Download, onSelect: () => window.open(`/api/proxy/m/credentials/download?name=${encodeURIComponent(c.name)}`, "_blank") },
    { label: "Remove", icon: Trash2, tone: "danger", onSelect: () => setRemove(true) },
  ];

  return (
    <div className={clsx(c.disabled && "opacity-60")}>
      <div className="flex items-center gap-3 px-4 py-3 max-sm:px-3">
        <ProviderMark provider={provider} size={32} />
        <button onClick={() => setOpen((o) => !o)} className="min-w-0 flex-1 cursor-pointer text-left">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-[13.5px] font-medium text-fg">{who(c)}</span>
            {plan && <Badge tone="neutral">{plan}</Badge>}
            {c.prefix && (
              <Badge tone="cyan" mono>
                {String(c.prefix)}/
              </Badge>
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-fg-4">
            <span className="font-mono text-fg-5">{c.name}</span>
            {c.last_refresh && <span>· refreshed {ago(Date.parse(c.last_refresh))}</span>}
            {total > 0 && (
              <span className="tabular">
                · {total.toLocaleString()} requests{(c.failed ?? 0) > 0 && <span className="text-red"> ({c.failed} failed)</span>}
              </span>
            )}
          </div>
        </button>
        <div className="hidden lg:block">
          <Tooltip content="Last 200 minutes, 10 minutes per bar">
            <span className="block">
              <RequestBars buckets={c.recent_requests ?? []} />
            </span>
          </Tooltip>
        </div>
        <Tooltip content={h.detail}>
          <span>
            <Badge tone={h.tone}>{h.label}</Badge>
          </span>
        </Tooltip>
        {busy ? (
          <span className="grid size-7 place-items-center text-fg-4">
            <Spinner />
          </span>
        ) : (
          <Menu items={items} trigger={(p) => <IconButton icon={MoreHorizontal} label="Account actions" {...p} />} />
        )}
        <button onClick={() => setOpen((o) => !o)} aria-label={open ? "Hide details" : "Show details"} className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-4 hover:bg-hover max-sm:hidden">
          <ChevronDown size={15} className={clsx("transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {open && <CredentialDetail c={c} />}
      <ConfirmRemove
        open={remove}
        onClose={() => setRemove(false)}
        title={`Remove ${who(c)}?`}
        description="The proxy forgets this account and deletes its token file. Signing in again brings it back."
        onConfirm={() => act("Remove", () => mgmt.del("/credentials", undefined, { names: [c.name] }), "Account removed")}
      />
      <CredentialFieldsDialog open={edit} c={c} onClose={() => setEdit(false)} onSaved={onChanged} />
    </div>
  );
}

function CredentialDetail({ c }: { c: Credential }) {
  const provider = (c.provider || c.type || "").toLowerCase();
  const models = useProxyData(() => mgmt.get<{ models: { id: string; display_name?: string }[] }>("/credentials/models", { name: c.name }).then((r) => r.models ?? []), [c.name]);
  const now = useNow();
  const cds = (c.cooldowns ?? []).filter((x) => !x.retry_at || Date.parse(x.retry_at) > now);
  const rows: [string, React.ReactNode][] = [
    ["Status", c.status_message || c.status || "–"],
    ["Token expires", c.access_token_expires_at ? `${new Date(c.access_token_expires_at).toLocaleString()} (${until(c.access_token_expires_at)})` : "–"],
    ["Next renewal", c.next_refresh_after ? until(c.next_refresh_after) : "–"],
    ["Priority / weight", `${c.priority ?? 0} / ${c.weight ?? 1}`],
  ];
  if (c.project_id) rows.push(["Project", <span key="p" className="font-mono">{c.project_id}</span>]);
  if (c.note) rows.push(["Note", c.note]);
  return (
    <div className="grid gap-4 border-t border-line bg-void/25 px-4 py-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-sm:px-3">
      <div className="space-y-4">
        <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-fg-4">{k}</dt>
              <dd className="break-words text-fg-2">{v}</dd>
            </div>
          ))}
        </dl>
        {cds.length > 0 && (
          <div>
            <div className="mb-1.5 text-[11px] font-semibold tracking-[0.08em] text-fg-4 uppercase">Resting</div>
            <ul className="space-y-1 text-[12.5px]">
              {cds.map((x, i) => (
                <li key={i} className="flex items-center gap-2 text-fg-3">
                  <Timer size={12} className="text-yellow" />
                  <span className="font-mono text-fg-2">{x.scope === "credential" ? "whole account" : x.model_key}</span>
                  <span>— {cooldownReason(x.reason, x.http_status)}, back {until(x.retry_at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {(provider === "claude" || provider === "codex") && c.auth_index != null && <Quota c={c} provider={provider} />}
      </div>
      <div>
        <div className="mb-1.5 flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-fg-4 uppercase">
          <Boxes size={12} /> Models {models.data && <span className="text-fg-5 tabular">{models.data.length}</span>}
        </div>
        {models.loading && !models.data ? (
          <Spinner className="text-fg-4" />
        ) : models.error ? (
          <div className="text-[12px] text-red">{models.error}</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {(models.data ?? []).map((m) => (
              <Tooltip key={m.id} content={m.display_name}>
                <span className="rounded-md bg-hl/70 px-1.5 py-0.5 font-mono text-[11.5px] text-fg-2">{m.id}</span>
              </Tooltip>
            ))}
            {models.data?.length === 0 && <span className="text-[12px] text-fg-4">None reported yet.</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- quota (Claude and Codex report live limits) ---------------- */

interface Window {
  label: string;
  used: number | null;
  resets: number | null;
}

async function fetchQuota(c: Credential, provider: string): Promise<{ windows: Window[]; plan?: string }> {
  const authIndex = String(c.auth_index);
  if (provider === "claude") {
    const r = await mgmt.post<{ status_code: number; body: unknown }>("/requests/api-call", {
      authIndex,
      method: "GET",
      url: "https://api.anthropic.com/api/oauth/usage",
      header: { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20", "User-Agent": "claude-cli/2.1.280 (external, cli)" },
    });
    const body = typeof r.body === "string" ? JSON.parse(r.body) : r.body;
    if (r.status_code >= 400) throw new Error(body?.error?.message ?? `HTTP ${r.status_code}`);
    const names: Record<string, string> = { five_hour: "5-hour window", seven_day: "Weekly", seven_day_opus: "Weekly · Opus", seven_day_sonnet: "Weekly · Sonnet", seven_day_oauth_apps: "Weekly · apps", iguana_necktie: "Weekly · Fable" };
    const windows: Window[] = [];
    for (const [k, label] of Object.entries(names)) {
      const w = body?.[k];
      if (w && typeof w === "object") windows.push({ label, used: typeof w.utilization === "number" ? w.utilization : null, resets: w.resets_at ? Date.parse(w.resets_at) : null });
    }
    return { windows };
  }
  const acct = (c.id_token as { chatgpt_account_id?: string } | undefined)?.chatgpt_account_id;
  const r = await mgmt.post<{ status_code: number; body: unknown }>("/requests/api-call", {
    authIndex,
    method: "GET",
    url: "https://chatgpt.com/backend-api/wham/usage",
    header: { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json", ...(acct ? { "Chatgpt-Account-Id": acct } : {}) },
  });
  const body = typeof r.body === "string" ? JSON.parse(r.body) : r.body;
  if (r.status_code >= 400) throw new Error(body?.detail ?? body?.error?.message ?? `HTTP ${r.status_code}`);
  const rl = body?.rate_limit ?? {};
  const win = (w: Record<string, unknown> | null | undefined, fallback: string): Window | null => {
    if (!w) return null;
    const secs = Number(w.limit_window_seconds);
    const label = secs >= 6 * 86_400 ? "Weekly" : secs ? `${Math.round(secs / 3600)}-hour window` : fallback;
    const resetAt = Number(w.reset_at);
    const after = Number(w.reset_after_seconds);
    return { label, used: Number(w.used_percent ?? NaN), resets: resetAt ? resetAt * 1000 : after ? Date.now() + after * 1000 : null };
  };
  return { windows: [win(rl.primary_window, "Short window"), win(rl.secondary_window, "Long window")].filter((w): w is Window => !!w), plan: body?.plan_type };
}

function Quota({ c, provider }: { c: Credential; provider: string }) {
  const [state, setState] = useState<{ loading: boolean; error?: string; windows?: Window[]; at?: number }>({ loading: false });
  const load = async () => {
    setState((s) => ({ ...s, loading: true, error: undefined }));
    try {
      const q = await fetchQuota(c, provider);
      setState({ loading: false, windows: q.windows, at: Date.now() });
    } catch (err) {
      setState({ loading: false, error: (err as Error).message });
    }
  };
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-2 text-[11px] font-semibold tracking-[0.08em] text-fg-4 uppercase">
          <Gauge size={12} /> Plan limits
        </span>
        <Button size="xs" variant="ghost" icon={RefreshCw} loading={state.loading} onClick={load}>
          {state.windows ? "Check again" : "Check"}
        </Button>
      </div>
      {state.error && <div className="text-[12px] text-red">{state.error}</div>}
      {state.windows && (
        <div className="space-y-2.5">
          {state.windows.map((w) => (
            <div key={w.label}>
              <div className="mb-1 flex justify-between text-[12px]">
                <span className="text-fg-3">{w.label}</span>
                <span className="text-fg-4 tabular">
                  <span className="text-fg-2">{w.used == null || Number.isNaN(w.used) ? "–" : `${Math.round(w.used)}% used`}</span>
                  {w.resets ? ` · resets ${until(w.resets)}` : ""}
                </span>
              </div>
              <Meter value={w.used} />
            </div>
          ))}
          {state.windows.length === 0 && <div className="text-[12px] text-fg-4">No limits reported.</div>}
        </div>
      )}
      {!state.windows && !state.error && <div className="text-[12px] text-fg-4">Asks the provider how much of this plan is left. Uses no tokens.</div>}
    </div>
  );
}

function CredentialFieldsDialog({ open, c, onClose, onSaved }: { open: boolean; c: Credential; onClose: () => void; onSaved: () => void }) {
  const [priority, setPriority] = useState(String(c.priority ?? 0));
  const [weight, setWeight] = useState(String(c.weight ?? 1));
  const [note, setNote] = useState(c.note ?? "");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await mgmt.patch("/credentials/fields", { name: c.name, priority: Number(priority) || 0, weight: Math.max(0, Number(weight) || 0), note });
      toast.success("Saved");
      onSaved();
      onClose();
    } catch (err) {
      toast.error("Couldn't save", { description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={Pencil}
      title={who(c)}
      description="How the proxy picks this account among others of the same provider."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Priority" hint="Higher is used first">
          <input className={inputCls} inputMode="numeric" value={priority} onChange={(e) => setPriority(e.target.value)} />
        </Field>
        <Field label="Weight" hint="Share under weighted round-robin">
          <input className={inputCls} inputMode="numeric" value={weight} onChange={(e) => setWeight(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3">
        <Field label="Note">
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Work account, family plan…" />
        </Field>
      </div>
    </Modal>
  );
}

/* ---------------- sign in ---------------- */

function SignInDialog({ open, initial, target, onClose, onDone }: { open: boolean; initial?: string; target?: Credential; onClose: () => void; onDone: () => void }) {
  const [provider, setProvider] = useState<string | null>(null);
  const [session, setSession] = useState<{ url: string; state: string; userCode?: string; device: boolean } | null>(null);
  const [status, setStatus] = useState<"idle" | "starting" | "waiting" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const { copied, copy } = useCopy();
  const remote = typeof window !== "undefined" && !["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

  // reset when (re)opened
  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect -- dialog opened: start from a clean slate */
    setProvider(initial ? (initial === "anthropic" ? "claude" : initial) : null);
    setSession(null);
    setStatus("idle");
    setError(null);
    setPasted("");
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [open, initial]);

  const start = async (p: string) => {
    setProvider(p);
    setStatus("starting");
    setError(null);
    try {
      const meta = OAUTH_PROVIDERS.find((x) => x.id === p);
      const r = await mgmt.get<{ url: string; state: string; user_code?: string; flow?: string }>("/oauth/auth-url", {
        provider: p,
        is_webui: meta?.webui ? true : undefined,
        name: target?.name,
      });
      setSession({ url: r.url, state: r.state, userCode: r.user_code, device: r.flow === "device" });
      setStatus("waiting");
    } catch (err) {
      setStatus("error");
      setError((err as Error).message);
    }
  };

  // poll for the result
  useEffect(() => {
    if (status !== "waiting" || !session) return;
    let stop = false;
    const tick = async () => {
      try {
        const r = await mgmt.get<{ status: string; error?: string }>("/oauth/status", { state: session.state });
        if (stop) return;
        if (r.status === "ok") {
          setStatus("done");
          toast.success("Signed in", { description: "The account is in rotation now." });
          onDone();
        } else if (r.status === "error") {
          setStatus("error");
          setError(r.error ?? "Sign-in failed");
        }
      } catch {
        /* keep polling */
      }
    };
    const t = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [status, session, onDone]);

  const cancel = () => {
    if (session && status === "waiting") void mgmt.del("/oauth/session", { state: session.state }).catch(() => {});
    onClose();
  };

  const submitPaste = async () => {
    if (!provider || !pasted.trim()) return;
    setSubmitting(true);
    try {
      await mgmt.post("/oauth/callback", { provider, redirect_url: pasted.trim() });
      toast.message("Got it — finishing sign-in…");
    } catch (err) {
      toast.error("That address didn't work", { description: (err as Error).message });
    } finally {
      setSubmitting(false);
    }
  };

  const meta = OAUTH_PROVIDERS.find((x) => x.id === provider);

  return (
    <Modal
      open={open}
      onClose={cancel}
      icon={LogIn}
      width={560}
      title={target ? `Sign in again as ${who(target)}` : meta ? `Sign in to ${meta.label}` : "Sign in to a subscription"}
      description={!provider ? "The proxy keeps the tokens on this machine and renews them by itself." : meta?.hint}
      footer={
        status === "waiting" ? (
          <Button variant="ghost" onClick={cancel}>
            Cancel sign-in
          </Button>
        ) : undefined
      }
    >
      {!provider || status === "idle" ? (
        <div className="-mx-1 grid gap-1.5 pb-2 sm:grid-cols-2">
          {OAUTH_PROVIDERS.map((p) => (
            <button key={p.id} onClick={() => start(p.id)} className="flex cursor-pointer items-center gap-3 rounded-lg border border-line-2 bg-raised/40 px-3 py-2.5 text-left transition-colors hover:border-line-3 hover:bg-hover">
              <ProviderMark provider={p.id} size={32} />
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium text-fg">{p.label}</span>
                <span className="block truncate text-[11.5px] text-fg-4">{p.hint}</span>
              </span>
            </button>
          ))}
        </div>
      ) : status === "starting" ? (
        <div className="flex items-center gap-2 py-6 text-[13px] text-fg-3">
          <Spinner /> Starting sign-in…
        </div>
      ) : status === "error" ? (
        <div className="space-y-3 pb-3">
          <div className="flex items-start gap-2 rounded-lg border border-red/25 bg-red/[0.06] px-3 py-2.5 text-[13px] text-red">
            <CircleAlert size={15} className="mt-0.5 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
          <Button variant="secondary" icon={RotateCcw} onClick={() => start(provider)}>
            Try again
          </Button>
        </div>
      ) : session ? (
        <div className="space-y-4 pb-3">
          <Step n={1} title={session.device ? "Open the page and enter the code" : "Open the sign-in page and approve"}>
            {session.userCode && (
              <button onClick={() => copy(session.userCode!)} className="mb-2 flex cursor-pointer items-center gap-2 rounded-lg border border-line-2 bg-void/60 px-3 py-2 font-mono text-[18px] font-semibold tracking-[0.2em] text-fg">
                {session.userCode}
                {copied === session.userCode ? <Check size={14} className="text-green" /> : <Copy size={14} className="text-fg-4" />}
              </button>
            )}
            <div className="flex flex-wrap gap-2">
              <a href={session.url} target="_blank" rel="noreferrer noopener">
                <Button variant="primary" icon={ExternalLink}>
                  Open {meta?.label ?? "sign-in"}
                </Button>
              </a>
              <Button variant="ghost" icon={copied === session.url ? Check : Copy} onClick={() => copy(session.url)}>
                Copy link
              </Button>
            </div>
          </Step>
          {!session.device && (
            <Step n={2} title={remote ? "Paste the address you land on" : "Come back here"}>
              <p className="mb-2 text-[12.5px] leading-relaxed text-fg-3">
                {remote ? (
                  <>
                    After approving, the browser goes to a <span className="font-mono text-fg-2">localhost</span> page that won&apos;t load on this device. That&apos;s expected: copy the whole address
                    from the address bar and paste it here.
                  </>
                ) : (
                  <>The proxy catches the redirect on this machine and finishes by itself. If the page doesn&apos;t load, paste its address here instead.</>
                )}
              </p>
              <div className="flex gap-2">
                <input className={inputCls} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://localhost:…/callback?code=…" />
                <Button variant="secondary" loading={submitting} disabled={!pasted.trim()} onClick={submitPaste}>
                  Submit
                </Button>
              </div>
            </Step>
          )}
          <div className="flex items-center gap-2 text-[12.5px] text-fg-4">
            <Spinner size={12} /> Waiting for {meta?.label ?? "the provider"}…
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="grid size-6 shrink-0 place-items-center rounded-full bg-blue/15 text-[12px] font-semibold text-blue">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="mb-2 text-[13.5px] font-medium text-fg">{title}</div>
        {children}
      </div>
    </div>
  );
}

/* ---------------- API-key upstreams (config api-keys.<provider>) ---------------- */

export interface KeyGroup {
  name?: string;
  "base-url"?: string;
  prefix?: string;
  disabled?: boolean;
  priority?: number;
  "proxy-url"?: string;
  headers?: Record<string, string>;
  keys?: { "api-key": string; weight?: number; [k: string]: unknown }[];
  models?: { name: string; alias?: string; [k: string]: unknown }[];
  "excluded-models"?: string[];
  [k: string]: unknown;
}

function KeyGroupsSection({ groups, error, reload }: { groups: Record<string, KeyGroup[]> | null; error: string | null; reload: () => void }) {
  const [editing, setEditing] = useState<{ provider: string; index: number | null } | null>(null);
  const [removing, setRemoving] = useState<{ provider: string; index: number } | null>(null);
  const entries = Object.entries(groups ?? {}).flatMap(([provider, list]) => (Array.isArray(list) ? list.map((g, index) => ({ provider, g, index })) : []));

  const save = async (provider: string, list: KeyGroup[]) => {
    await mgmt.put(`/config/api-keys/${provider}`, list);
    reload();
  };

  return (
    <Section
      title="API keys for upstreams"
      hint="Pay-as-you-go keys and other endpoints (OpenRouter, a local model server). They join the same rotation as subscriptions."
      right={
        <Menu
          items={KEY_PROVIDERS.map((p) => ({ label: p.label, hint: p.id === "openai-compatibility" ? "any" : undefined, onSelect: () => setEditing({ provider: p.id, index: null }) }))}
          trigger={(p) => (
            <Button size="sm" variant="secondary" icon={Plus} {...p}>
              Add endpoint
            </Button>
          )}
        />
      }
    >
      {error && !groups ? (
        <ErrorCard message={error} onRetry={reload} />
      ) : entries.length === 0 ? (
        <div className="card rounded-xl px-4 py-5 text-[12.5px] text-fg-4">None. Subscriptions are usually all you need.</div>
      ) : (
        <div className="card divide-y divide-line overflow-hidden rounded-xl">
          {entries.map(({ provider, g, index }) => {
            const meta = KEY_PROVIDERS.find((p) => p.id === provider);
            return (
              <div key={`${provider}-${index}`} className={clsx("flex items-center gap-3 px-4 py-3 max-sm:px-3", g.disabled && "opacity-60")}>
                <ProviderMark provider={provider} size={32} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13.5px] font-medium text-fg">{g.name || meta?.label || provider}</span>
                    <Badge tone="neutral">{meta?.label ?? provider}</Badge>
                    {g.prefix && (
                      <Badge tone="cyan" mono>
                        {g.prefix}/
                      </Badge>
                    )}
                    {g.disabled && <Badge tone="neutral">off</Badge>}
                  </div>
                  <div className="mt-0.5 truncate text-[11.5px] text-fg-4">
                    <span className="font-mono">{g["base-url"] || meta?.baseUrl || "default endpoint"}</span>
                    {" · "}
                    {(g.keys ?? []).length} key{(g.keys ?? []).length === 1 ? "" : "s"}
                    {(g.models ?? []).length > 0 && ` · ${(g.models ?? []).length} models`}
                  </div>
                </div>
                <div className="hidden gap-1 md:flex">
                  {(g.keys ?? []).slice(0, 2).map((k, i) => (
                    <span key={i} className="rounded bg-hl/70 px-1.5 py-0.5 font-mono text-[11px] text-fg-3">
                      {mask(k["api-key"])}
                    </span>
                  ))}
                </div>
                <IconButton icon={Pencil} label="Edit" onClick={() => setEditing({ provider, index })} />
                <IconButton icon={Trash2} label="Remove" tone="danger" onClick={() => setRemoving({ provider, index })} />
              </div>
            );
          })}
        </div>
      )}
      {editing && (
        <KeyGroupDialog
          provider={editing.provider}
          group={editing.index == null ? null : (groups?.[editing.provider]?.[editing.index] ?? null)}
          onClose={() => setEditing(null)}
          onSave={async (g) => {
            const list = [...(groups?.[editing.provider] ?? [])];
            if (editing.index == null) list.push(g);
            else list[editing.index] = g;
            await save(editing.provider, list);
            setEditing(null);
            toast.success("Saved");
          }}
        />
      )}
      <ConfirmRemove
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remove this endpoint?"
        description="Its keys are deleted from the proxy's config."
        onConfirm={async () => {
          if (!removing) return;
          const list = (groups?.[removing.provider] ?? []).filter((_, i) => i !== removing.index);
          await save(removing.provider, list);
          toast.success("Removed");
        }}
      />
    </Section>
  );
}

function KeyGroupDialog({ provider, group, onClose, onSave }: { provider: string; group: KeyGroup | null; onClose: () => void; onSave: (g: KeyGroup) => Promise<void> }) {
  const meta = KEY_PROVIDERS.find((p) => p.id === provider);
  const [name, setName] = useState(group?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(group?.["base-url"] ?? (provider === "openai-compatibility" ? "" : ""));
  const [prefix, setPrefix] = useState(group?.prefix ?? "");
  const [keys, setKeys] = useState((group?.keys ?? []).map((k) => k["api-key"]).join("\n"));
  const [models, setModels] = useState((group?.models ?? []).map((m) => (m.alias && m.alias !== m.name ? `${m.name} = ${m.alias}` : m.name)).join("\n"));
  const [disabled, setDisabled] = useState(!!group?.disabled);
  const [saving, setSaving] = useState(false);
  const compat = provider === "openai-compatibility";

  const submit = async () => {
    const keyList = keys
      .split(/\n+/)
      .map((k) => k.trim())
      .filter(Boolean);
    if (!keyList.length) return toast.error("Add at least one key");
    if (compat && !baseUrl.trim()) return toast.error("An OpenAI-compatible endpoint needs a base URL");
    if (compat && !name.trim()) return toast.error("Give it a name");
    const prevKeys = new Map((group?.keys ?? []).map((k) => [k["api-key"], k]));
    const prevModels = new Map((group?.models ?? []).map((m) => [m.name, m]));
    const g: KeyGroup = {
      ...(group ?? {}),
      ...(name.trim() ? { name: name.trim() } : {}),
      ...(baseUrl.trim() ? { "base-url": baseUrl.trim() } : {}),
      keys: keyList.map((k) => ({ ...(prevKeys.get(k) ?? {}), "api-key": k })),
    };
    if (!baseUrl.trim()) delete g["base-url"];
    if (prefix.trim()) g.prefix = prefix.trim().replace(/\/+$/, "");
    else delete g.prefix;
    const modelList = models
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [n, a] = l.split("=").map((x) => x.trim());
        return { ...(prevModels.get(n) ?? {}), name: n, ...(a ? { alias: a } : {}) };
      });
    if (modelList.length) g.models = modelList;
    else delete g.models;
    if (disabled) g.disabled = true;
    else delete g.disabled;
    setSaving(true);
    try {
      await onSave(g);
    } catch (err) {
      toast.error("Couldn't save", { description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      icon={KeyRound}
      width={560}
      title={group ? `Edit ${group.name || meta?.label}` : `Add ${meta?.label ?? provider}`}
      description={meta?.hint}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={compat ? "Name" : "Name (optional)"} hint={compat ? "Shown in logs; also the model prefix if you set none" : undefined}>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={compat ? "openrouter" : meta?.label} />
          </Field>
          <Field label="Prefix (optional)" hint={<>Only answer models asked for as <span className="font-mono">prefix/model</span></>}>
            <input className={inputCls} value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="work" />
          </Field>
        </div>
        <Field label={compat ? "Base URL" : "Base URL (optional)"}>
          <input className={inputCls} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={meta?.baseUrl || "https://…"} />
        </Field>
        <Field label="Keys" hint="One per line. Several keys share this endpoint and rotate.">
          <textarea className={textareaCls} rows={3} value={keys} onChange={(e) => setKeys(e.target.value)} placeholder="sk-…" spellCheck={false} />
        </Field>
        <Field label={compat ? "Models" : "Models (optional)"} hint={<>One per line: <span className="font-mono">upstream-name</span> or <span className="font-mono">upstream-name = alias</span></>}>
          <textarea className={textareaCls} rows={4} value={models} onChange={(e) => setModels(e.target.value)} placeholder={compat ? "moonshotai/kimi-k2 = kimi-k2" : "leave empty for the provider's catalog"} spellCheck={false} />
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-fg-3">
          <input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} className="accent-blue" />
          Keep it, but don&apos;t use it for now
        </label>
      </div>
    </Modal>
  );
}
