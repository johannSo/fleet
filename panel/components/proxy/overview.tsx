"use client";

import clsx from "clsx";
import { ArrowUpCircle, Check, CircleAlert, Copy, LogIn, Play, RotateCcw, Square, Users } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import type { Credential, UsageReport } from "@/lib/cpa-types";
import { bytes, duration } from "@/lib/format";
import { Badge, Button, HoldButton, Modal, useCopy } from "../ui";
import { mgmt, proxyApi, useNow, useProxyData } from "./api";
import { credentialHealth } from "./accounts";
import { ProviderMark, mask } from "./bits";
import { loadKeys } from "./keys";
import { proxyState, useProxyStatus } from "./shell";
import { BarChart, RequestLog, UsageKpis } from "./usage";

export function ProxyOverview() {
  const { status } = useProxyStatus();
  const usage = useProxyData(() => proxyApi.get<UsageReport>("/usage", { range: "24h", source: "proxy" }), []);
  const creds = useProxyData(() => mgmt.get<{ files: Credential[] }>("/credentials").then((r) => r.files ?? []), [], 20_000);
  const keys = useProxyData(loadKeys, []);
  const attention = (creds.data ?? []).filter((c) => !c.disabled && credentialHealth(c).tone !== "green");
  const r = usage.data;

  return (
    <>
      <UsageKpis report={r} />

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="card rounded-xl p-4">
          <div className="mb-3 flex items-center justify-between text-[12.5px]">
            <span className="font-medium text-fg-2">Requests, last 24 hours</span>
            <Link href="/proxy/usage" className="text-fg-4 hover:text-fg-2">
              Usage ›
            </Link>
          </div>
          {r ? (
            <BarChart
              height={130}
              bucket={r.bucket}
              data={r.series.map((b) => ({ t: b.t, ok: b.requests - b.errors, failed: b.errors }))}
              series={[
                { key: "ok", label: "Succeeded", color: "#7aa2f7" },
                { key: "failed", label: "Failed", color: "#f7768e" },
              ]}
            />
          ) : (
            <div className="skeleton h-[150px] rounded-md opacity-40" />
          )}
        </div>
        <ServiceCard />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <AccountsSummary creds={creds.data} attention={attention} />
        <ConnectCard keys={keys.data ?? []} urls={status?.urls ?? []} />
      </div>

      <RequestLog limit={8} compact source="proxy" />
    </>
  );
}

/* ---------------- service ---------------- */

function ServiceCard() {
  const { status, reload } = useProxyStatus();
  const st = proxyState(status);
  const [busy, setBusy] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [journal, setJournal] = useState<string | null>(null);
  const svc = status?.service;
  const now = useNow();
  const update = status?.version && status.latest && status.latest !== status.version && !status.version.startsWith(status.latest) ? status.latest : null;

  const act = async (action: "start" | "stop" | "restart") => {
    setBusy(action);
    try {
      await proxyApi.post("/service", { action });
      toast.success(action === "stop" ? "Proxy stopped" : action === "start" ? "Proxy started" : "Proxy restarted");
    } catch (err) {
      toast.error(`Couldn't ${action} the proxy`, { description: (err as Error).message });
    } finally {
      setBusy(null);
      setTimeout(() => void reload(), 800);
    }
  };

  const rows: [string, React.ReactNode][] = [
    ["Service", <span key="s" className="font-mono">fleet-proxy</span>],
    ["Version", status?.version ? <span key="v" className="font-mono">{status.version}</span> : "–"],
    ["Port", status ? <span key="p" className="font-mono">{status.port}</span> : "–"],
    ["Up for", svc?.since && svc.active === "active" ? duration((now - svc.since) / 1000) : "–"],
    ["Memory", svc?.memory ? bytes(svc.memory) : "–"],
  ];

  return (
    <div className="card flex flex-col rounded-xl p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[12.5px] font-medium text-fg-2">Server</span>
        <Badge tone={st.tone === "neutral" ? "neutral" : st.tone}>{st.label}</Badge>
      </div>
      <dl className="grid grid-cols-[90px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[12.5px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-fg-4">{k}</dt>
            <dd className="text-fg-2">{v}</dd>
          </div>
        ))}
      </dl>
      {status?.error && !status.reachable && <p className="mt-3 text-[12px] break-words text-yellow">{status.error}</p>}
      {update && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-blue/25 bg-blue/[0.06] px-3 py-2 text-[12px] text-fg-3">
          <ArrowUpCircle size={14} className="mt-0.5 shrink-0 text-blue" />
          <span>
            <span className="font-medium text-fg-2">{update}</span> is out. Update with{" "}
            <span className="font-mono text-fg-2">git submodule update --remote proxy/cliproxyapi && ./proxy/install.sh</span>
          </span>
        </div>
      )}
      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        {svc?.active === "active" ? (
          <>
            <Button size="sm" variant="secondary" icon={RotateCcw} loading={busy === "restart"} onClick={() => act("restart")}>
              Restart
            </Button>
            <Button size="sm" variant="ghost" icon={Square} onClick={() => setStopping(true)}>
              Stop
            </Button>
          </>
        ) : (
          <Button size="sm" variant="primary" icon={Play} loading={busy === "start"} onClick={() => act("start")}>
            Start
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={async () => setJournal(await proxyApi.text("/journal?lines=300"))}>
          Service output
        </Button>
      </div>
      <Modal
        open={stopping}
        onClose={() => setStopping(false)}
        tone="yellow"
        title="Stop the proxy?"
        description="Every client using it gets connection errors until you start it again. It starts again on its own at the next login."
        footer={
          <HoldButton
            tone="yellow"
            onConfirm={() => {
              setStopping(false);
              void act("stop");
            }}
          >
            Hold to stop
          </HoldButton>
        }
      />
      <Modal open={journal != null} onClose={() => setJournal(null)} width={860} title="fleet-proxy.service" description="systemd journal: startup errors land here.">
        <pre className="mb-3 max-h-[60vh] overflow-auto rounded-lg border border-line-2 bg-void/70 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-3">{journal}</pre>
      </Modal>
    </div>
  );
}

/* ---------------- accounts at a glance ---------------- */

function AccountsSummary({ creds, attention }: { creds: Credential[] | null; attention: Credential[] }) {
  const byProvider = useMemo(() => {
    const m = new Map<string, { total: number; ok: number }>();
    for (const c of creds ?? []) {
      const p = (c.provider || c.type || "unknown").toLowerCase();
      const x = m.get(p) ?? { total: 0, ok: 0 };
      x.total++;
      if (!c.disabled && credentialHealth(c).tone === "green") x.ok++;
      m.set(p, x);
    }
    return [...m.entries()];
  }, [creds]);

  return (
    <div className="card rounded-xl p-4">
      <div className="mb-3 flex items-center justify-between text-[12.5px]">
        <span className="font-medium text-fg-2">Accounts</span>
        <Link href="/proxy/accounts" className="text-fg-4 hover:text-fg-2">
          Manage ›
        </Link>
      </div>
      {!creds ? (
        <div className="skeleton h-20 rounded-md opacity-40" />
      ) : creds.length === 0 ? (
        <div className="flex flex-col items-start gap-3 py-2">
          <p className="text-[12.5px] text-fg-3">No subscriptions signed in yet. The proxy has nothing to forward requests to.</p>
          <Link href="/proxy/accounts">
            <Button size="sm" variant="primary" icon={LogIn}>
              Sign in to an account
            </Button>
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {byProvider.map(([p, x]) => (
              <div key={p} className="flex items-center gap-2 rounded-lg border border-line-2 bg-raised/40 py-1.5 pr-3 pl-1.5">
                <ProviderMark provider={p} size={24} />
                <span className="text-[12.5px] text-fg-2 tabular">
                  <span className={clsx("font-semibold", x.ok === x.total ? "text-green" : x.ok ? "text-yellow" : "text-red")}>{x.ok}</span>
                  <span className="text-fg-4">/{x.total} active</span>
                </span>
              </div>
            ))}
          </div>
          {attention.length > 0 ? (
            <ul className="mt-3 space-y-1.5">
              {attention.slice(0, 5).map((c) => {
                const h = credentialHealth(c);
                return (
                  <li key={c.name} className="flex items-center gap-2 text-[12.5px]">
                    <CircleAlert size={13} className={h.tone === "red" ? "text-red" : "text-yellow"} />
                    <span className="truncate text-fg-2">{c.email || c.label || c.name}</span>
                    <span className="ml-auto shrink-0">
                      <Badge tone={h.tone}>{h.label}</Badge>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-3 flex items-center gap-1.5 text-[12.5px] text-fg-4">
              <Users size={13} className="text-green" /> Every account is healthy.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------- connect a client ---------------- */

const CLIENTS = [
  {
    id: "claude",
    label: "Claude Code",
    snippet: (url: string, key: string) => `export ANTHROPIC_BASE_URL=${url}
export ANTHROPIC_AUTH_TOKEN=${key}
claude`,
  },
  {
    id: "codex",
    label: "Codex CLI",
    snippet: (url: string, key: string) => `# ~/.codex/config.toml
model_provider = "fleet"

[model_providers.fleet]
name = "Fleet proxy"
base_url = "${url}/v1"
env_key = "FLEET_PROXY_KEY"
wire_api = "responses"

# then: FLEET_PROXY_KEY=${key} codex`,
  },
  {
    id: "openai",
    label: "OpenAI SDK",
    snippet: (url: string, key: string) => `export OPENAI_BASE_URL=${url}/v1
export OPENAI_API_KEY=${key}`,
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    snippet: (url: string, key: string) => `export GOOGLE_GEMINI_BASE_URL=${url}
export GEMINI_API_KEY=${key}
gemini`,
  },
  {
    id: "curl",
    label: "curl",
    snippet: (url: string, key: string) => `curl ${url}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "claude-sonnet-4-5", "messages": [{"role": "user", "content": "Hi"}]}'`,
  },
];

function ConnectCard({ keys, urls }: { keys: string[]; urls: string[] }) {
  const [client, setClient] = useState("claude");
  const [urlIdx, setUrlIdx] = useState(0);
  const [keyIdx, setKeyIdx] = useState(0);
  const { copied, copy } = useCopy();
  const url = urls[urlIdx] ?? urls[0] ?? "http://localhost:8317";
  const key = keys[keyIdx] ?? keys[0] ?? "<api key>";
  const c = CLIENTS.find((x) => x.id === client)!;
  const text = c.snippet(url, key);
  const shown = c.snippet(url, keys.length ? mask(key) : key);

  return (
    <div className="card flex min-w-0 flex-col rounded-xl p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
        <span className="font-medium text-fg-2">Connect a client</span>
        <div className="flex gap-2">
          {urls.length > 1 && (
            <select value={urlIdx} onChange={(e) => setUrlIdx(Number(e.target.value))} className="h-7 max-w-[180px] rounded-md border border-line-2 bg-panel px-1.5 text-[11.5px] text-fg-3" aria-label="Address">
              {urls.map((u, i) => (
                <option key={u} value={i}>
                  {u.replace(/^https?:\/\//, "")}
                </option>
              ))}
            </select>
          )}
          {keys.length > 1 && (
            <select value={keyIdx} onChange={(e) => setKeyIdx(Number(e.target.value))} className="h-7 max-w-[150px] rounded-md border border-line-2 bg-panel px-1.5 font-mono text-[11.5px] text-fg-3" aria-label="API key">
              {keys.map((k, i) => (
                <option key={k} value={i}>
                  {mask(k)}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className="rail mb-2 flex gap-1 overflow-x-auto">
        {CLIENTS.map((x) => (
          <button
            key={x.id}
            onClick={() => setClient(x.id)}
            className={clsx("h-7 shrink-0 cursor-pointer rounded-md px-2.5 text-[12px] font-medium transition-colors pointer-coarse:h-9", client === x.id ? "bg-hl text-fg" : "text-fg-4 hover:bg-hover hover:text-fg-2")}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className="relative min-w-0">
        <pre className="overflow-x-auto rounded-lg border border-line-2 bg-void/70 p-3 pr-10 font-mono text-[11.5px] leading-relaxed text-fg-2">{shown}</pre>
        <button onClick={() => copy(text)} aria-label="Copy" className="absolute top-2 right-2 grid size-7 cursor-pointer place-items-center rounded-md text-fg-4 hover:bg-hover hover:text-fg">
          {copied === text ? <Check size={14} className="text-green" /> : <Copy size={14} />}
        </button>
      </div>
      <p className="mt-2 text-[11.5px] text-fg-4">Copy includes the real key. Any model name from the Models tab works, from any of these clients.</p>
    </div>
  );
}
