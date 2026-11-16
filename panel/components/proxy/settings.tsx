"use client";

import clsx from "clsx";
import { FileCode2, RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button, Spinner } from "../ui";
import { mgmt, proxyApi, useProxyData } from "./api";
import { ErrorCard } from "./accounts";
import { Section, Toggle, inputCls, textareaCls } from "./bits";

type Conf = Record<string, unknown>;

function at(c: Conf | null, path: string): unknown {
  return path.split("/").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Conf)[k] : undefined), c);
}

/**
 * The settings people actually change, grouped by what they're for. Everything else
 * stays reachable in the full config.yaml editor at the bottom.
 */
interface Setting {
  path: string;
  label: string;
  hint?: React.ReactNode;
  kind: "bool" | "number" | "text" | "choice";
  def: unknown;
  choices?: { value: string; label: string }[];
  restart?: boolean;
  placeholder?: string;
}

const GROUPS: { title: string; hint: string; items: Setting[] }[] = [
  {
    title: "Network",
    hint: "Where clients reach the proxy.",
    items: [
      {
        path: "server/host",
        label: "Listen on",
        kind: "choice",
        def: "",
        choices: [
          { value: "", label: "Every network (LAN and Tailscale)" },
          { value: "127.0.0.1", label: "This machine only" },
        ],
        restart: true,
      },
      { path: "server/port", label: "Port", kind: "number", def: 8317, restart: true },
      { path: "requests/proxy-url", label: "Outbound proxy", hint: "Send upstream traffic through socks5:// or http://. Empty: direct.", kind: "text", def: "", placeholder: "socks5://host:1080" },
    ],
  },
  {
    title: "Routing",
    hint: "How requests are spread across accounts.",
    items: [
      {
        path: "routing/strategy",
        label: "Pick accounts",
        kind: "choice",
        def: "round-robin",
        choices: [
          { value: "round-robin", label: "In turn (round-robin)" },
          { value: "weighted-round-robin", label: "In turn, by weight" },
          { value: "fill-first", label: "Use one until it's limited (fill-first)" },
        ],
      },
      { path: "routing/session-affinity", label: "Keep a conversation on one account", hint: "Better prompt-cache hits for Claude Code and Codex sessions.", kind: "bool", def: false },
      { path: "routing/retry/request-retry", label: "Retry rounds", hint: "Extra rounds across accounts after 403/408/429/5xx.", kind: "number", def: 3 },
      { path: "routing/retry/max-retry-interval", label: "Longest wait between rounds (s)", hint: "Wait for a resting account at most this long; 0 never waits.", kind: "number", def: 30 },
      { path: "routing/cooldown/disable-cooling", label: "Never rest accounts", hint: "Keep using an account after it hits a limit. Usually a bad idea.", kind: "bool", def: false },
      { path: "routing/force-model-prefix", label: "Unprefixed models skip prefixed accounts", kind: "bool", def: false },
    ],
  },
  {
    title: "Streaming",
    hint: "For clients behind proxies that drop idle connections.",
    items: [
      { path: "requests/streaming/keepalive-seconds", label: "Keep-alive every (s)", hint: "0 turns it off.", kind: "number", def: 0 },
      { path: "requests/streaming/bootstrap-retries", label: "Retries before the first byte", kind: "number", def: 0 },
    ],
  },
  {
    title: "Logs",
    hint: "What CLIProxyAPI writes down. The panel's own usage history doesn't depend on these.",
    items: [
      { path: "observability/logs/logging-to-file", label: "Write the proxy log", hint: "Needed for the Logs tab.", kind: "bool", def: false },
      { path: "observability/logs/request-log", label: "Request logs", hint: "Keep full request and response bodies. Large, and contains your prompts.", kind: "bool", def: false },
      { path: "observability/logs/debug", label: "Debug output", kind: "bool", def: false },
      { path: "observability/logs/logs-max-total-size-mb", label: "Log size limit (MB)", hint: "0 means no limit.", kind: "number", def: 0 },
      { path: "observability/usage/usage-statistics-enabled", label: "Usage events", hint: "Feeds the Usage tab. Leave on.", kind: "bool", def: false },
    ],
  },
];

export function SettingsView() {
  const conf = useProxyData(() => mgmt.get<Conf>("/config"), []);
  const [restartNeeded, setRestartNeeded] = useState(false);

  const set = async (s: Setting, value: unknown) => {
    try {
      await mgmt.put(`/config/${s.path}`, value);
      toast.success(`${s.label}: saved`);
      if (s.restart) setRestartNeeded(true);
      void conf.reload();
    } catch (err) {
      toast.error("Couldn't save", { description: (err as Error).message });
    }
  };

  return (
    <>
      {restartNeeded && (
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-yellow/25 bg-yellow/[0.06] px-4 py-3 text-[12.5px] text-fg-2">
          <span className="flex-1">Network changes apply after a restart.</span>
          <Button
            size="sm"
            variant="warning"
            icon={RotateCcw}
            onClick={async () => {
              try {
                await proxyApi.post("/service", { action: "restart" });
                setRestartNeeded(false);
                toast.success("Proxy restarted");
              } catch (err) {
                toast.error("Restart failed", { description: (err as Error).message });
              }
            }}
          >
            Restart now
          </Button>
        </div>
      )}
      {conf.error && !conf.data ? (
        <ErrorCard message={conf.error} onRetry={conf.reload} />
      ) : (
        <div className="grid gap-x-6 xl:grid-cols-2">
          {GROUPS.map((g) => (
            <Section key={g.title} title={g.title} hint={g.hint}>
              <div className="card divide-y divide-line overflow-hidden rounded-xl">
                {g.items.map((s) => (
                  <SettingRow key={s.path} s={s} value={conf.data ? (at(conf.data, s.path) ?? s.def) : undefined} onSave={(v) => set(s, v)} />
                ))}
              </div>
            </Section>
          ))}
        </div>
      )}
      <YamlEditor onSaved={conf.reload} />
    </>
  );
}

function SettingRow({ s, value, onSave }: { s: Setting; value: unknown; onSave: (v: unknown) => Promise<void> }) {
  const [draft, setDraft] = useState<string>(value == null ? "" : String(value));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- follow saved value
    setDraft(value == null ? "" : String(value));
  }, [value]);
  const loaded = value !== undefined;
  const save = async (v: unknown) => {
    setBusy(true);
    try {
      await onSave(v);
    } finally {
      setBusy(false);
    }
  };
  const dirty = loaded && draft !== String(value ?? "");
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 max-sm:px-3">
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-[13px] text-fg">
          {s.label}
          {s.restart && <span className="ml-2 text-[11px] text-fg-5">restart</span>}
        </div>
        {s.hint && <div className="mt-0.5 text-[11.5px] text-fg-4">{s.hint}</div>}
      </div>
      {!loaded ? (
        <Spinner className="text-fg-5" />
      ) : s.kind === "bool" ? (
        <Toggle label={s.label} checked={value === true} disabled={busy} onChange={(v) => save(v)} />
      ) : s.kind === "choice" ? (
        <select value={String(value ?? "")} disabled={busy} onChange={(e) => save(e.target.value)} className={clsx(inputCls, "w-auto max-w-[280px]")}>
          {s.choices!.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!dirty) return;
            void save(s.kind === "number" ? Number(draft) || 0 : draft.trim());
          }}
        >
          <input
            className={clsx(inputCls, s.kind === "number" ? "w-24 text-right tabular" : "w-60 font-mono")}
            inputMode={s.kind === "number" ? "numeric" : undefined}
            value={draft}
            placeholder={s.placeholder}
            onChange={(e) => setDraft(e.target.value)}
          />
          {dirty && (
            <Button size="sm" variant="primary" loading={busy} type="submit">
              Save
            </Button>
          )}
        </form>
      )}
    </div>
  );
}

function YamlEditor({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [orig, setOrig] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);

  const load = async () => {
    try {
      const t = await mgmt.getText("/config.yaml");
      setText(t);
      setOrig(t);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const save = async () => {
    if (text == null) return;
    setSaving(true);
    try {
      await mgmt.putYaml(text);
      setOrig(text);
      toast.success("config.yaml saved", { description: "CLIProxyAPI reloads it by itself; listener changes need a restart." });
      onSaved();
    } catch (err) {
      toast.error("CLIProxyAPI rejected it", { description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="config.yaml"
      hint={
        <>
          Every option, including upstream headers, payload rules and plugins. The reference is CLIProxyAPI&apos;s <span className="font-mono">config.example.yaml</span>.
        </>
      }
      right={
        !open ? (
          <Button
            size="sm"
            variant="secondary"
            icon={FileCode2}
            onClick={() => {
              setOpen(true);
              void load();
            }}
          >
            Edit config.yaml
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => setText(orig)} disabled={text === orig}>
              Revert
            </Button>
            <Button size="sm" variant="primary" icon={Save} loading={saving} disabled={text === orig} onClick={save}>
              Save
            </Button>
          </>
        )
      }
    >
      {open &&
        (error ? (
          <ErrorCard message={error} onRetry={load} />
        ) : text == null ? (
          <div className="card skeleton h-60 rounded-xl opacity-50" />
        ) : (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            className={clsx(textareaCls, "card h-[60vh] rounded-xl bg-void/70 text-[12px]")}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                e.preventDefault();
                void save();
              }
            }}
          />
        ))}
    </Section>
  );
}
