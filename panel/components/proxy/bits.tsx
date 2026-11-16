"use client";

import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { HoldButton, Modal } from "../ui";

/** Each provider keeps one accent everywhere in the proxy pages. */
const PROVIDER_STYLE: Record<string, { label: string; text: string; bg: string; ring: string; hex: string; mark: string }> = {
  claude: { label: "Claude", text: "text-orange", bg: "bg-orange/12", ring: "ring-orange/25", hex: "#ff9e64", mark: "C" },
  anthropic: { label: "Claude", text: "text-orange", bg: "bg-orange/12", ring: "ring-orange/25", hex: "#ff9e64", mark: "C" },
  codex: { label: "Codex", text: "text-teal", bg: "bg-teal/12", ring: "ring-teal/25", hex: "#73daca", mark: "X" },
  openai: { label: "OpenAI", text: "text-teal", bg: "bg-teal/12", ring: "ring-teal/25", hex: "#73daca", mark: "O" },
  "openai-compatibility": { label: "OpenAI-compatible", text: "text-cyan", bg: "bg-cyan/12", ring: "ring-cyan/25", hex: "#7dcfff", mark: "⇄" },
  gemini: { label: "Gemini", text: "text-blue", bg: "bg-blue/12", ring: "ring-blue/25", hex: "#7aa2f7", mark: "G" },
  "gemini-cli": { label: "Gemini CLI", text: "text-blue", bg: "bg-blue/12", ring: "ring-blue/25", hex: "#7aa2f7", mark: "G" },
  vertex: { label: "Vertex", text: "text-blue", bg: "bg-blue/12", ring: "ring-blue/25", hex: "#7aa2f7", mark: "V" },
  aistudio: { label: "AI Studio", text: "text-blue", bg: "bg-blue/12", ring: "ring-blue/25", hex: "#7aa2f7", mark: "A" },
  antigravity: { label: "Antigravity", text: "text-magenta", bg: "bg-magenta/12", ring: "ring-magenta/25", hex: "#bb9af7", mark: "◆" },
  xai: { label: "Grok", text: "text-fg-2", bg: "bg-hl", ring: "ring-line-3/60", hex: "#a9b1d6", mark: "𝕏" },
  kimi: { label: "Kimi", text: "text-green", bg: "bg-green/12", ring: "ring-green/25", hex: "#9ece6a", mark: "K" },
  "kimi-ai": { label: "Kimi", text: "text-green", bg: "bg-green/12", ring: "ring-green/25", hex: "#9ece6a", mark: "K" },
  devin: { label: "Devin", text: "text-sky", bg: "bg-sky/12", ring: "ring-sky/25", hex: "#2ac3de", mark: "D" },
  meta: { label: "Meta AI", text: "text-purple", bg: "bg-purple/12", ring: "ring-purple/25", hex: "#9d7cd8", mark: "M" },
  qwen: { label: "Qwen", text: "text-purple", bg: "bg-purple/12", ring: "ring-purple/25", hex: "#9d7cd8", mark: "Q" },
  iflow: { label: "iFlow", text: "text-yellow", bg: "bg-yellow/12", ring: "ring-yellow/25", hex: "#e0af68", mark: "i" },
};
const FALLBACK = { label: "", text: "text-fg-3", bg: "bg-hl", ring: "ring-line-3/60", hex: "#8f98c4", mark: "?" };

export function providerStyle(id: string | null | undefined) {
  const key = (id ?? "").toLowerCase();
  // CPA names OpenAI-compatible upstreams "openai-compatible-<name>"
  if (key.startsWith("openai-compatible-")) return { ...PROVIDER_STYLE["openai-compatibility"], label: key.slice("openai-compatible-".length) };
  const s = PROVIDER_STYLE[key];
  return s ?? { ...FALLBACK, label: id ?? "Unknown", mark: (id ?? "?").slice(0, 1).toUpperCase() };
}

export function ProviderMark({ provider, size = 30 }: { provider: string | null | undefined; size?: number }) {
  const s = providerStyle(provider);
  return (
    <span
      className={clsx("grid shrink-0 place-items-center rounded-lg font-semibold ring-1 ring-inset", s.bg, s.text, s.ring)}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
      aria-hidden
    >
      {s.mark}
    </span>
  );
}

export function Section({
  title,
  hint,
  right,
  children,
  className,
}: {
  title: string;
  hint?: React.ReactNode;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={clsx("mb-8", className)}>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[11px] font-semibold tracking-[0.09em] text-fg-4 uppercase">{title}</h2>
          {hint && <p className="mt-1 text-[12.5px] text-fg-4">{hint}</p>}
        </div>
        {right && <div className="flex flex-wrap items-center gap-2">{right}</div>}
      </div>
      {children}
    </section>
  );
}

export function Stat({ icon: Icon, iconClass, label, value, sub }: { icon: LucideIcon; iconClass: string; label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="card flex min-h-[104px] flex-col rounded-xl px-4 pt-3.5 pb-3">
      <div className="flex items-center gap-2 text-[11.5px] font-medium text-fg-3">
        <Icon size={13} className={iconClass} />
        {label}
      </div>
      <div className="figure mt-2 text-[26px] leading-none font-semibold text-fg">{value}</div>
      {sub && <div className="mt-1.5 truncate text-[11.5px] text-fg-4">{sub}</div>}
    </div>
  );
}

/** "sk-abc…wxyz" — enough to tell keys apart. */
export function mask(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "••••••";
  return `${key.slice(0, Math.min(10, key.length - 8))}…${key.slice(-4)}`;
}

/** A remove dialog that needs a hold, like the panel's other destructive actions. */
export function ConfirmRemove({
  open,
  onClose,
  title,
  description,
  onConfirm,
  label = "Hold to remove",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: React.ReactNode;
  onConfirm: () => Promise<void> | void;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      tone="red"
      title={title}
      description={description}
      footer={
        <HoldButton
          onConfirm={async () => {
            setBusy(true);
            try {
              await onConfirm();
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Removing…" : label}
        </HoldButton>
      }
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-fg-3">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-fg-4">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "h-9 w-full rounded-md border border-line-2 bg-void/50 px-3 text-[13px] text-fg placeholder:text-fg-5 transition-colors focus:border-blue/60 pointer-coarse:h-11";
export const textareaCls =
  "w-full rounded-md border border-line-2 bg-void/50 px-3 py-2 font-mono text-[12.5px] leading-relaxed text-fg placeholder:text-fg-5 transition-colors focus:border-blue/60";

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        "relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors disabled:cursor-default disabled:opacity-50",
        checked ? "bg-blue" : "bg-line-3",
      )}
    >
      <span className={clsx("absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]", checked ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

/** Tiny success/failure bars for the last N time buckets. */
export function RequestBars({ buckets, height = 18 }: { buckets: { success?: number; failed?: number }[]; height?: number }) {
  const max = Math.max(1, ...buckets.map((b) => (b.success ?? 0) + (b.failed ?? 0)));
  if (!buckets.some((b) => (b.success ?? 0) + (b.failed ?? 0) > 0)) return <span className="text-[11px] text-fg-5">no requests yet</span>;
  return (
    <span className="flex items-end gap-[2px]" style={{ height }} aria-hidden>
      {buckets.map((b, i) => {
        const ok = b.success ?? 0;
        const bad = b.failed ?? 0;
        const h = ((ok + bad) / max) * height;
        return (
          <span key={i} className="flex w-[4px] flex-col-reverse overflow-hidden rounded-[1.5px] bg-hl/70" style={{ height }}>
            <span className="bg-green/80" style={{ height: (ok / Math.max(1, ok + bad)) * h }} />
            <span className="bg-red" style={{ height: (bad / Math.max(1, ok + bad)) * h }} />
          </span>
        );
      })}
    </span>
  );
}
