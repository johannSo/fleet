"use client";

import clsx from "clsx";
import { BarChart3, Boxes, Check, Copy, KeyRound, LayoutDashboard, ScrollText, Settings2, Users, Waves } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext } from "react";
import type { ProxyStatus } from "@/lib/cpa-types";
import { Tooltip, useCopy } from "../ui";
import { proxyApi, useProxyData } from "./api";

export const TABS = [
  { href: "/proxy", label: "Overview", icon: LayoutDashboard },
  { href: "/proxy/accounts", label: "Accounts", icon: Users },
  { href: "/proxy/keys", label: "API keys", icon: KeyRound },
  { href: "/proxy/models", label: "Models", icon: Boxes },
  { href: "/proxy/usage", label: "Usage", icon: BarChart3 },
  { href: "/proxy/traffic", label: "Traffic", icon: Waves },
  { href: "/proxy/logs", label: "Logs", icon: ScrollText },
  { href: "/proxy/settings", label: "Settings", icon: Settings2 },
] as const;

interface StatusCtx {
  status: ProxyStatus | null;
  error: string | null;
  reload: () => Promise<void>;
}
const Ctx = createContext<StatusCtx>({ status: null, error: null, reload: async () => {} });
export const useProxyStatus = () => useContext(Ctx);

export function proxyState(s: ProxyStatus | null): { label: string; tone: "green" | "red" | "yellow" | "neutral" } {
  if (!s) return { label: "Checking…", tone: "neutral" };
  if (!s.service.installed) return { label: "Not installed", tone: "neutral" };
  if (s.reachable) return { label: "Running", tone: "green" };
  if (s.service.active === "activating" || s.service.active === "reloading") return { label: "Starting…", tone: "yellow" };
  if (s.service.active === "active") return { label: "Not answering", tone: "yellow" };
  if (s.service.active === "failed") return { label: "Crashed", tone: "red" };
  return { label: "Stopped", tone: "red" };
}

const DOT = { green: "bg-green text-green animate-pulse-dot", red: "bg-red", yellow: "bg-yellow text-yellow animate-pulse-dot", neutral: "bg-fg-5" } as const;
const TEXT = { green: "text-green", red: "text-red", yellow: "text-yellow", neutral: "text-fg-4" } as const;

export function ProxyShell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { data: status, error, reload } = useProxyData(() => proxyApi.get<ProxyStatus>("/status"), [], 10_000);
  const st = proxyState(status);
  const { copied, copy } = useCopy();
  const endpoint = status?.urls[0] ? `${status.urls[0]}/v1` : null;

  return (
    <Ctx.Provider value={{ status, error, reload }}>
      <div className="mx-auto max-w-[1440px] px-4 pt-5 pb-8 sm:px-6 sm:pt-7 lg:px-8">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-x-6 gap-y-3 max-sm:mb-3">
          <div className="min-w-0">
            <h1 className="text-[20px] font-semibold tracking-tight text-fg max-sm:hidden sm:text-[22px]">AI proxy</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-fg-4 max-sm:mt-0">
              <span className={clsx("inline-flex items-center gap-1.5 font-medium", TEXT[st.tone])}>
                <span className={clsx("size-1.5 rounded-full", DOT[st.tone])} />
                {st.label}
              </span>
              <span className="text-fg-5">·</span>
              <span>
                CLIProxyAPI{status?.version ? <span className="font-mono text-fg-3"> {status.version}</span> : null}
              </span>
              <span className="text-fg-5 max-sm:hidden">·</span>
              <span className="max-sm:hidden">One OpenAI, Anthropic and Gemini compatible endpoint for your subscriptions</span>
            </p>
          </div>
          {endpoint && (
            <Tooltip content={copied === endpoint ? "Copied" : "Copy the base URL"}>
              <button
                onClick={() => copy(endpoint)}
                className="group flex h-8 max-w-full cursor-pointer items-center gap-2 rounded-md border border-line-2 bg-panel/80 pr-2.5 pl-3 font-mono text-[12px] text-fg-2 transition-colors hover:border-line-3"
              >
                <span className="truncate">{endpoint}</span>
                {copied === endpoint ? <Check size={13} className="text-green" /> : <Copy size={13} className="text-fg-4 group-hover:text-fg-2" />}
              </button>
            </Tooltip>
          )}
        </div>

        <nav className="rail -mx-4 mb-5 flex gap-1 overflow-x-auto border-b border-line px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8" aria-label="AI proxy">
          {TABS.map((t) => {
            const active = t.href === "/proxy" ? path === "/proxy" : path.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={clsx(
                  "relative flex h-10 shrink-0 items-center gap-2 px-2.5 text-[13px] font-medium transition-colors",
                  active ? "text-fg" : "text-fg-4 hover:text-fg-2",
                )}
              >
                <t.icon size={14} className={active ? "text-blue" : "text-fg-5"} />
                {t.label}
                {active && <span className="absolute inset-x-1.5 -bottom-px h-[2px] rounded-full bg-blue" />}
              </Link>
            );
          })}
        </nav>

        {status && !status.service.installed ? <NotInstalled /> : children}
      </div>
    </Ctx.Provider>
  );
}

function NotInstalled() {
  const { copied, copy } = useCopy();
  const cmd = "./proxy/install.sh";
  return (
    <div className="card mx-auto mt-6 max-w-xl rounded-xl p-6">
      <h2 className="text-[15px] font-semibold text-fg">The proxy isn&apos;t installed on this machine</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-fg-3">
        It&apos;s CLIProxyAPI, built from the <span className="font-mono text-fg-2">proxy/cliproxyapi</span> submodule and run as the{" "}
        <span className="font-mono text-fg-2">fleet-proxy</span> user service. From the fleet repository, run:
      </p>
      <button onClick={() => copy(cmd)} className="mt-4 flex w-full cursor-pointer items-center justify-between rounded-md border border-line-2 bg-void/60 px-3 py-2.5 font-mono text-[13px] text-fg-2 hover:border-line-3">
        {cmd}
        {copied === cmd ? <Check size={14} className="text-green" /> : <Copy size={14} className="text-fg-4" />}
      </button>
      <p className="mt-3 text-[12px] text-fg-4">It needs Go. This page picks the service up as soon as it&apos;s running.</p>
    </div>
  );
}
