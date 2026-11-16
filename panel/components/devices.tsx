"use client";

import clsx from "clsx";
import { Check, ChevronDown, KeyRound, Laptop, LogOut, RefreshCw, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ago } from "@/lib/format";
import { Button, Modal, Spinner, useCopy } from "./ui";

interface PairHost {
  host: string;
  httpUrl: string;
  httpQr: string;
  httpsUrl: string | null;
  httpsQr: string | null;
  caUrl: string | null;
  caQr: string | null;
}
interface Pair {
  expiresAt: number;
  hosts: PairHost[];
  tls: boolean;
}
interface DeviceRow {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number;
  ip: string;
  mobile?: boolean;
  current: boolean;
}

function Qr({ svg, size = 188, label }: { svg: string; size?: number; label: string }) {
  return (
    <div
      role="img"
      aria-label={label}
      className="shrink-0 overflow-hidden rounded-xl bg-white shadow-[0_8px_30px_-10px_rgba(192,202,245,0.35)] [&_svg]:h-full [&_svg]:w-full"
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function useCountdown(until: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  const s = Math.max(0, Math.round((until - now) / 1000));
  return { left: s, label: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` };
}

export function DevicesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [pair, setPair] = useState<Pair | null>(null);
  const [hostIdx, setHostIdx] = useState(1);
  const [secure, setSecure] = useState(true);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [newPw, setNewPw] = useState<string | null>(null);
  const [help, setHelp] = useState<"ios" | "android" | null>(null);
  const { copy, copied } = useCopy();
  const countdown = useCountdown(pair?.expiresAt ?? null);

  const refresh = useCallback(async () => {
    const [p, d] = await Promise.all([
      fetch("/api/auth/pair", { method: "POST" }).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/auth/devices").then((r) => (r.ok ? r.json() : { devices: [] })),
    ]);
    if (p) setPair(p);
    setDevices(d.devices);
  }, []);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      setNewPw(null);
      refresh();
    }, 0);
    // keep the device list fresh so a phone appears the moment it pairs
    const i = setInterval(() => fetch("/api/auth/devices").then((r) => r.json()).then((d) => setDevices(d.devices)).catch(() => {}), 3000);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
  }, [open, refresh]);

  const host = pair?.hosts[Math.min(hostIdx, pair.hosts.length - 1)];
  const useTls = !!pair?.tls && secure;
  const pairUrl = host ? (useTls ? host.httpsUrl! : host.httpUrl) : null;
  const pairQr = host ? (useTls ? host.httpsQr! : host.httpQr) : null;
  const expired = countdown?.left === 0;

  const revoke = async (d: DeviceRow) => {
    await fetch(`/api/auth/devices?id=${d.id}`, { method: "DELETE" });
    if (d.current) window.location.replace("/login");
    setDevices((list) => list.filter((x) => x.id !== d.id));
    toast(`Signed out ${d.name}`);
  };

  const reset = async () => {
    const r = await fetch("/api/auth/password", { method: "POST" });
    if (r.ok) setNewPw((await r.json()).password);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={Smartphone}
      tone="cyan"
      width={720}
      title="Add a device"
      description="Point your phone's camera at the code. It signs that phone in once; the code expires after 5 minutes."
    >
      {!pair || !host ? (
        <div className="grid h-64 place-items-center">
          <Spinner className="text-fg-4" size={20} />
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] text-fg-4">Address</span>
            {pair.hosts.map((h, i) => (
              <button
                key={h.host}
                onClick={() => setHostIdx(i)}
                className={clsx(
                  "h-7 cursor-pointer rounded-full px-3 font-mono text-[12px] ring-1 ring-inset transition-colors",
                  i === Math.min(hostIdx, pair.hosts.length - 1) ? "bg-cyan/10 text-cyan ring-cyan/30" : "text-fg-3 ring-line-2 hover:text-fg",
                )}
              >
                {h.host}
              </button>
            ))}
            {pair.tls && (
              <div className="ml-auto flex rounded-md bg-void/60 p-0.5 ring-1 ring-line-2">
                {[
                  { v: true, l: "App (HTTPS)" },
                  { v: false, l: "Browser only" },
                ].map((o) => (
                  <button
                    key={o.l}
                    onClick={() => setSecure(o.v)}
                    className={clsx("h-6 cursor-pointer rounded px-2.5 text-[11.5px]", secure === o.v ? "bg-hl text-fg" : "text-fg-4 hover:text-fg-2")}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {useTls && host.caQr && (
              <div className="rounded-xl border border-line-2 bg-void/30 p-4">
                <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-fg">
                  <span className="grid size-5 place-items-center rounded-full bg-hl text-[11px] text-fg-2">1</span>
                  Trust the panel <span className="font-normal text-fg-4">· once per phone</span>
                </div>
                <div className="flex flex-col items-center gap-3 text-center">
                  <Qr svg={host.caQr} size={200} label="QR code for the certificate download" />
                  <div className="min-w-0 text-[12px] leading-relaxed text-fg-3">
                    Download the certificate, then install it as a trusted CA. It only works for your own network&apos;s addresses.
                    <div className="mt-2 flex justify-center gap-4">
                      {(["ios", "android"] as const).map((p) => (
                        <button key={p} onClick={() => setHelp(help === p ? null : p)} className="flex cursor-pointer items-center gap-1 text-blue hover:underline">
                          <ChevronDown size={12} className={clsx("transition-transform", help === p && "rotate-180")} />
                          {p === "ios" ? "iPhone / iPad steps" : "Android steps"}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {help && (
                  <ol className="mt-3 list-decimal space-y-1 rounded-lg bg-void/50 py-2.5 pr-3 pl-7 text-[12px] leading-relaxed text-fg-3">
                    {help === "ios" ? (
                      <>
                        <li>Open the link in Safari and allow the profile download.</li>
                        <li>Settings → General → VPN &amp; Device Management → install the profile.</li>
                        <li>Settings → General → About → Certificate Trust Settings → switch it on.</li>
                      </>
                    ) : (
                      <>
                        <li>Open the link in Chrome to download the certificate.</li>
                        <li>Settings → Security &amp; privacy → More → Encryption &amp; credentials → Install a certificate → CA certificate.</li>
                        <li>Pick the downloaded file. Restart Chrome.</li>
                      </>
                    )}
                  </ol>
                )}
              </div>
            )}

            <div className={clsx("rounded-xl border border-line-2 bg-void/30 p-4", !useTls && "sm:col-span-2")}>
              <div className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-fg">
                {useTls && <span className="grid size-5 place-items-center rounded-full bg-hl text-[11px] text-fg-2">2</span>}
                Sign in this phone
              </div>
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="relative">
                  {pairQr && <Qr svg={pairQr} size={200} label="QR code that signs a phone in" />}
                  {expired && (
                    <button onClick={refresh} className="absolute inset-0 grid cursor-pointer place-items-center rounded-xl bg-void/90 text-[12.5px] font-medium text-blue backdrop-blur-sm">
                      <span className="flex items-center gap-1.5">
                        <RefreshCw size={14} /> New code
                      </span>
                    </button>
                  )}
                </div>
                <div className="min-w-0 max-w-sm text-[12px] leading-relaxed text-fg-3">
                  {useTls ? "Then scan this. Open it in the browser, and use Add to Home Screen to install Fleet." : "Works in any browser right away. To install Fleet as an app, use App (HTTPS)."}
                  <div className="mt-2.5 flex flex-wrap items-center justify-center gap-2">
                    <span className={clsx("font-mono text-[12px] tabular", expired ? "text-yellow" : "text-fg-4")}>
                      {expired ? "expired" : countdown?.label}
                    </span>
                    <Button size="xs" variant="secondary" icon={RefreshCw} onClick={refresh}>
                      New code
                    </Button>
                    {pairUrl && (
                      <Button size="xs" variant="secondary" onClick={() => copy(pairUrl)}>
                        {copied === pairUrl ? "Copied" : "Copy link"}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold tracking-[0.09em] text-fg-4 uppercase">Signed-in devices</h3>
              <span className="text-[11px] text-fg-4">this machine never needs to sign in</span>
            </div>
            <div className="max-h-[232px] divide-y divide-line overflow-y-auto overscroll-contain rounded-xl border border-line-2">
              {devices.length === 0 && <div className="px-4 py-3 text-[12.5px] text-fg-4">No other devices yet.</div>}
              {devices.map((d) => (
                <div key={d.id} className="flex items-center gap-3 px-4 py-2.5">
                  {d.mobile || /iPhone|Android|iPad/.test(d.name) ? <Smartphone size={16} className="text-fg-4" /> : <Laptop size={16} className="text-fg-4" />}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[13px] text-fg-2">
                      {d.name}
                      {d.current && <span className="rounded-full bg-green/10 px-1.5 text-[10px] font-semibold text-green">this device</span>}
                    </div>
                    <div className="font-mono text-[11px] text-fg-4">
                      {d.ip} · active {ago(d.lastSeen)} · added {ago(d.createdAt)}
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" icon={d.current ? LogOut : Trash2} onClick={() => revoke(d)}>
                    {d.current ? "Sign out" : "Revoke"}
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line-2 bg-void/30 px-4 py-3">
            <KeyRound size={15} className="text-fg-4" />
            {newPw ? (
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-[12.5px] text-fg-3">
                New password:
                <button onClick={() => copy(newPw)} className="cursor-pointer rounded-md bg-hl px-2 py-0.5 font-mono text-[13px] text-fg hover:bg-line-3">
                  {newPw}
                </button>
                {copied === newPw ? <Check size={13} className="text-green" /> : <span className="text-[11px] text-fg-4">tap to copy · shown once</span>}
              </div>
            ) : (
              <>
                <span className="flex-1 text-[12.5px] text-fg-3">
                  Or sign in with the password. Lost it? Make a new one; signed-in devices stay signed in.
                </span>
                <Button size="sm" variant="secondary" icon={ShieldCheck} onClick={reset}>
                  New password
                </Button>
              </>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
