"use client";

import { ArrowUpCircle, Check, Copy, ExternalLink } from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
import type { VersionInfo } from "@/lib/release";
import { Button, Modal, useCopy } from "./ui";

const UPGRADE = {
  docker: "docker compose pull && docker compose up -d",
  service: "git pull && ./deploy.sh <panel-host>",
} as const;

const Ctx = createContext<{ info: VersionInfo | null; open: () => void }>({ info: null, open: () => {} });
export const useVersion = () => useContext(Ctx);

/** Fetches /api/version now and every 30 minutes; the dialog lives here so every indicator can open it. */
export function VersionProvider({ children }: { children: React.ReactNode }) {
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = () =>
      fetch("/api/version", { cache: "no-store" })
        .then((r) => (r.ok ? (r.json() as Promise<VersionInfo>) : null))
        .then((v) => !stop && v && setInfo(v))
        .catch(() => {});
    load();
    const t = setInterval(load, 30 * 60_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);
  return (
    <Ctx.Provider value={{ info, open: () => setShown(true) }}>
      {children}
      {info && <UpdateDialog info={info} open={shown} onClose={() => setShown(false)} />}
    </Ctx.Provider>
  );
}

function UpdateDialog({ info, open, onClose }: { info: VersionInfo; open: boolean; onClose: () => void }) {
  const { copy, copied } = useCopy();
  const cmd = UPGRADE[info.install];
  const latest = info.latest;
  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={ArrowUpCircle}
      tone={info.updateAvailable ? "green" : "neutral"}
      title={info.updateAvailable && latest ? `Fleet v${latest.version} is out` : `Fleet v${info.current}`}
      description={
        info.updateAvailable
          ? `This panel runs v${info.current}${info.commit ? ` (${info.commit})` : ""}.${latest?.publishedAt ? ` Released ${new Date(latest.publishedAt).toLocaleDateString()}.` : ""}`
          : latest
            ? "This is the latest release."
            : info.error
              ? `Couldn't check for a new release: ${info.error}`
              : "No release published yet."
      }
      footer={
        latest && (
          <a href={latest.url} target="_blank" rel="noreferrer">
            <Button size="sm" variant="secondary" iconRight={ExternalLink}>
              Release notes
            </Button>
          </a>
        )
      }
    >
      {info.updateAvailable && (
        <div className="space-y-2 text-[13px] text-fg-3">
          <p>{info.install === "docker" ? "Update where compose.yml is (your data stays in its volumes):" : "Update from your checkout of the repo:"}</p>
          <div className="flex items-center gap-2 rounded-lg border border-line-2 bg-void/50 py-1.5 pr-1.5 pl-3">
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-fg-2">{cmd}</code>
            <Button size="xs" variant="ghost" icon={copied === cmd ? Check : Copy} onClick={() => copy(cmd)}>
              {copied === cmd ? "Copied" : "Copy"}
            </Button>
          </div>
          {info.install === "docker" && <p className="text-[12px] text-fg-4">With FLEET_TAG pinned in .env, set it to v{latest?.version} first.</p>}
        </div>
      )}
    </Modal>
  );
}

/** A green pill when a newer release is out; nothing otherwise. */
export function VersionIndicator() {
  const { info, open } = useVersion();
  if (!info?.updateAvailable || !info.latest) return null;
  return (
    <button
      onClick={open}
      className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md bg-green/10 px-2 text-[12.5px] font-medium text-green ring-1 ring-green/25 transition-colors ring-inset hover:bg-green/15"
    >
      <span className="relative grid place-items-center">
        <ArrowUpCircle size={14} />
        <span className="absolute -top-0.5 -right-0.5 size-1.5 animate-pulse rounded-full bg-green" />
      </span>
      <span className="flex-1 truncate text-left">Fleet v{info.latest.version} available</span>
    </button>
  );
}

/** The running version, quietly; opens the same dialog. */
export function VersionLabel() {
  const { info, open } = useVersion();
  if (!info) return null;
  return (
    <button onClick={open} className="shrink-0 cursor-pointer font-mono text-[10.5px] text-fg-5 transition-colors hover:text-fg-3" title="Fleet version">
      v{info.current}
    </button>
  );
}
