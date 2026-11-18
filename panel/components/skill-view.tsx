"use client";

import clsx from "clsx";
import { Check, Copy, Download, FileArchive, KeyRound, Puzzle, RefreshCw, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ago } from "@/lib/format";
import { FLEET_CHANGED_EVENT } from "./fleet-provider";
import { Field, api } from "./machine-editor";
import { inputCls, textareaCls } from "./proxy/bits";
import { Button, Spinner, useCopy } from "./ui";

interface SkillData {
  markdown: string;
  settings: { live: boolean; panelUrl: string; customUrl: boolean; defaultUrl: string; extra: string };
  token: { preview: string; createdAt: number | null } | null;
}

function Card({ title, icon: Icon, children, right, className }: { title: string; icon: typeof Puzzle; children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <section className={clsx("card rounded-xl", className)}>
      <div className="flex min-h-11 items-center gap-2 border-b border-line px-4 py-1.5">
        <Icon size={14} className="text-fg-4" />
        <h2 className="text-[12.5px] font-semibold text-fg-2">{title}</h2>
        <div className="ml-auto">{right}</div>
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={clsx("relative inline-flex h-[20px] w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors", on ? "bg-blue" : "bg-hl ring-1 ring-line-3 ring-inset")}
    >
      <span className={clsx("absolute size-4 rounded-full shadow transition-transform", on ? "translate-x-[18px] bg-[#11131c]" : "translate-x-0.5 bg-fg-2")} />
    </button>
  );
}

export function SkillView() {
  const [data, setData] = useState<SkillData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [url, setUrl] = useState("");
  const [extra, setExtra] = useState("");
  const [saving, setSaving] = useState(false);
  const [install, setInstall] = useState<{ command: string; expiresAt: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const { copy, copied } = useCopy();

  const load = useCallback(async (reset: boolean) => {
    try {
      const d = await api<SkillData>("GET", "/api/skill");
      setData(d);
      setError(null);
      if (reset) {
        setLive(d.settings.live);
        setUrl(d.settings.customUrl ? d.settings.panelUrl : "");
        setExtra(d.settings.extra);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => load(true), 0);
    // Machines change: the preview follows.
    const onChange = () => load(false);
    window.addEventListener(FLEET_CHANGED_EVENT, onChange);
    return () => {
      clearTimeout(t);
      window.removeEventListener(FLEET_CHANGED_EVENT, onChange);
    };
  }, [load]);

  useEffect(() => {
    if (!install) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [install]);

  const dirty = !!data && (live !== data.settings.live || url !== (data.settings.customUrl ? data.settings.panelUrl : "") || extra !== data.settings.extra);

  const save = async () => {
    setSaving(true);
    try {
      await api("PUT", "/api/skill", { live, panelUrl: url, extra });
      setInstall(null);
      await load(true);
      toast.success("Saved", { description: "Install or download the skill again so Claude gets the change." });
    } catch (err) {
      toast.error("Couldn't save", { description: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const getCommand = async () => {
    try {
      setInstall(await api("POST", "/api/skill/install"));
      setNow(Date.now());
    } catch (err) {
      toast.error("Couldn't make an install command", { description: (err as Error).message });
    }
  };

  const newToken = async () => {
    if (!confirm("Make a new access token? Copies of the skill installed before lose live access until you install it again.")) return;
    try {
      await api("POST", "/api/skill/token");
      setInstall(null);
      await load(false);
      toast.success("New token made", { description: "Install the skill again wherever you use it." });
    } catch (err) {
      toast.error("Couldn't make a new token", { description: (err as Error).message });
    }
  };

  const left = install ? Math.max(0, Math.round((install.expiresAt - now) / 1000)) : 0;
  const size = data ? new Blob([data.markdown]).size : 0;

  return (
    <div className="mx-auto max-w-[1280px] px-4 pt-5 pb-10 sm:px-6 sm:pt-7 lg:px-8">
      <div className="mb-5 max-sm:hidden">
        <h1 className="text-[20px] font-semibold tracking-tight text-fg sm:text-[22px]">Claude skill</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-fg-4">
          Teaches Claude your machines: what each is for, its hardware, addresses, how to ssh in and what runs on it. Generated from the inventory, so it&apos;s always as current as the panel.
        </p>
      </div>

      {error && <p className="mb-4 rounded-lg border border-red/25 bg-red/[0.06] px-4 py-2.5 text-[12.5px] text-red">{error}</p>}

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="space-y-4 lg:order-2">
          <Card title="Install" icon={Download}>
            <div className="space-y-4">
              <div>
                <h3 className="text-[13px] font-medium text-fg">Claude Code</h3>
                <p className="mt-1 text-[12px] leading-relaxed text-fg-4">
                  One command, on any machine you run Claude Code on. It writes <span className="font-mono text-fg-3">~/.claude/skills/fleet/SKILL.md</span>; run a new one to update.
                </p>
                {install && left > 0 ? (
                  <div className="mt-2.5 space-y-1.5">
                    <div className="flex items-start gap-2 rounded-lg border border-line-2 bg-void/50 p-2.5">
                      <code className="min-w-0 flex-1 font-mono text-[11.5px] leading-relaxed break-all text-fg-2">{install.command}</code>
                      <button
                        onClick={() => copy(install.command)}
                        aria-label="Copy command"
                        className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-3 hover:bg-hover hover:text-fg pointer-coarse:size-10"
                      >
                        {copied === install.command ? <Check size={14} className="text-green" /> : <Copy size={14} />}
                      </button>
                    </div>
                    <p className="text-[11.5px] text-fg-4 tabular">
                      Works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} more.
                    </p>
                  </div>
                ) : (
                  <Button variant="primary" size="sm" icon={SquareTerminal} className="mt-2.5" onClick={getCommand} disabled={!data}>
                    Get install command
                  </Button>
                )}
              </div>
              <div className="border-t border-line pt-4">
                <h3 className="text-[13px] font-medium text-fg">Download</h3>
                <p className="mt-1 text-[12px] leading-relaxed text-fg-4">
                  The file to put in <span className="font-mono text-fg-3">~/.claude/skills/fleet/</span>, or a .zip to upload in claude.ai (Settings → Capabilities → Skills).
                </p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <a href="/api/skill/download" download="SKILL.md">
                    <Button size="sm" icon={Download} tabIndex={-1}>
                      SKILL.md
                    </Button>
                  </a>
                  <a href="/api/skill/download?format=zip" download="fleet-skill.zip">
                    <Button size="sm" icon={FileArchive} tabIndex={-1}>
                      fleet-skill.zip
                    </Button>
                  </a>
                </div>
              </div>
            </div>
          </Card>

          <Card title="Settings" icon={KeyRound}>
            {!data ? (
              <Spinner size={14} className="text-fg-4" />
            ) : (
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-fg">Live access</div>
                    <p className="mt-1 text-[12px] leading-relaxed text-fg-4">
                      Claude reads the current inventory from the panel and can add and edit machines. It uses a token that only opens the inventory, not terminals or the proxy. Off: the skill is a snapshot.
                    </p>
                  </div>
                  <Toggle on={live} onChange={setLive} label="Live access" />
                </div>
                {data.settings.live && data.token && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg bg-void/40 px-3 py-2 text-[12px] text-fg-4">
                    <span className="font-mono text-fg-3">{data.token.preview}</span>
                    {data.token.createdAt && <span>made {ago(data.token.createdAt)}</span>}
                    <Button size="xs" variant="ghost" icon={RefreshCw} className="ml-auto" onClick={newToken}>
                      New token
                    </Button>
                  </div>
                )}
                <Field label="Panel address" hint="Where Claude reaches the panel. It has to work from the machines you run Claude Code on.">
                  <input className={clsx(inputCls, "font-mono")} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={data.settings.defaultUrl} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
                </Field>
                <Field label="More instructions" hint="Added to the end of the skill as they are: conventions, what to ask first, anything fleet-wide.">
                  <textarea className={clsx(textareaCls, "font-sans")} rows={4} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Deploy with ./deploy.sh from my laptop. Never reboot the NAS without asking." />
                </Field>
                <div className="flex justify-end">
                  <Button variant="primary" size="sm" disabled={!dirty} loading={saving} onClick={save}>
                    Save
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>

        <Card
          title="SKILL.md"
          icon={Puzzle}
          className="lg:order-1"
          right={
            data ? (
              <span className="flex items-center gap-2 text-[11px] text-fg-4">
                {(size / 1024).toFixed(1)} KB
                <Button size="xs" variant="ghost" icon={copied === data.markdown ? Check : Copy} onClick={() => copy(data.markdown)}>
                  Copy
                </Button>
              </span>
            ) : null
          }
        >
          {!data ? (
            <div className="space-y-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="skeleton h-4 rounded" style={{ width: `${90 - i * 12}%` }} />
              ))}
            </div>
          ) : (
            <pre className="-m-4 max-h-[75vh] overflow-auto p-4 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-fg-2 [overflow-wrap:anywhere]">{data.markdown}</pre>
          )}
        </Card>
      </div>
    </div>
  );
}
