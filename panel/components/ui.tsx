"use client";

import clsx from "clsx";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from "react-dom";
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import type { LucideIcon } from "lucide-react";
import { X } from "lucide-react";

/* ---------------- accent helpers ---------------- */

/** Tailwind needs literal class names, so map accents explicitly. */
export const ACCENT: Record<string, { text: string; bg: string; soft: string; ring: string; hex: string }> = {
  blue: { text: "text-blue", bg: "bg-blue", soft: "bg-blue/12", ring: "ring-blue/30", hex: "#7aa2f7" },
  magenta: { text: "text-magenta", bg: "bg-magenta", soft: "bg-magenta/12", ring: "ring-magenta/30", hex: "#bb9af7" },
  teal: { text: "text-teal", bg: "bg-teal", soft: "bg-teal/12", ring: "ring-teal/30", hex: "#73daca" },
  orange: { text: "text-orange", bg: "bg-orange", soft: "bg-orange/12", ring: "ring-orange/30", hex: "#ff9e64" },
  cyan: { text: "text-cyan", bg: "bg-cyan", soft: "bg-cyan/12", ring: "ring-cyan/30", hex: "#7dcfff" },
  yellow: { text: "text-yellow", bg: "bg-yellow", soft: "bg-yellow/12", ring: "ring-yellow/30", hex: "#e0af68" },
  green: { text: "text-green", bg: "bg-green", soft: "bg-green/12", ring: "ring-green/30", hex: "#9ece6a" },
  red: { text: "text-red", bg: "bg-red", soft: "bg-red/12", ring: "ring-red/30", hex: "#f7768e" },
  purple: { text: "text-purple", bg: "bg-purple", soft: "bg-purple/12", ring: "ring-purple/30", hex: "#9d7cd8" },
  sky: { text: "text-sky", bg: "bg-sky", soft: "bg-sky/12", ring: "ring-sky/30", hex: "#2ac3de" },
};

export const METRIC = { cpu: "#7aa2f7", mem: "#bb9af7", disk: "#73daca", swap: "#7dcfff" } as const;

/** A metric keeps its category colour until it needs attention: yellow ≥ 80%, red ≥ 90%. */
export function usageColor(metric: keyof typeof METRIC, p: number | null | undefined): string {
  if (p != null && p >= 90) return "#f7768e";
  if (p != null && p >= 80) return "#e0af68";
  return METRIC[metric];
}

/** green → yellow → orange → red as utilisation climbs. */
export function levelColor(p: number | null | undefined): string {
  if (p == null) return "#565f89";
  if (p >= 90) return "#f7768e";
  if (p >= 75) return "#ff9e64";
  if (p >= 55) return "#e0af68";
  return "#9ece6a";
}

/* ---------------- button ---------------- */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "warning" | "subtle";
type Size = "xs" | "sm" | "md";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
}

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-blue text-[#11131c] font-semibold hover:bg-[#8db0ff] shadow-[0_0_0_1px_rgba(122,162,247,0.35),0_1px_0_0_rgba(255,255,255,0.18)_inset] disabled:bg-blue/30 disabled:text-[#11131c]/70 disabled:shadow-none disabled:opacity-100 disabled:cursor-not-allowed",
  secondary: "bg-raised text-fg border border-line-2 hover:bg-hover hover:border-line-3",
  ghost: "text-fg-2 hover:bg-hover hover:text-fg",
  subtle: "bg-hl/60 text-fg-2 hover:bg-hl hover:text-fg",
  danger: "bg-red/10 text-red border border-red/25 hover:bg-red/18 hover:border-red/40",
  warning: "bg-yellow/10 text-yellow border border-yellow/25 hover:bg-yellow/18 hover:border-yellow/40",
};

const SIZES: Record<Size, string> = {
  xs: "h-6 px-2 text-[11.5px] gap-1 rounded-sm pointer-coarse:h-8 pointer-coarse:px-2.5",
  sm: "h-7.5 px-2.5 text-[12.5px] gap-1.5 rounded-md pointer-coarse:h-9 pointer-coarse:px-3",
  md: "h-9 px-3.5 text-[13px] gap-2 rounded-md pointer-coarse:h-10 pointer-coarse:px-4 pointer-coarse:text-[14px]",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", icon: Icon, iconRight: IconRight, loading, className, children, disabled, ...rest },
  ref,
) {
  const iconSize = size === "md" ? 15 : size === "sm" ? 14 : 12;
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={clsx(
        "inline-flex shrink-0 cursor-pointer items-center justify-center whitespace-nowrap font-medium transition-[background,border,color,box-shadow,transform] duration-150 select-none active:translate-y-px disabled:pointer-events-none disabled:opacity-45",
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={iconSize} /> : Icon ? <Icon size={iconSize} strokeWidth={2} /> : null}
      {children}
      {IconRight && <IconRight size={iconSize} strokeWidth={2} className="opacity-70" />}
    </button>
  );
});

export function IconButton({
  icon: Icon,
  label,
  className,
  size = 28,
  tone = "default",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; size?: number; tone?: "default" | "danger" }) {
  return (
    <Tooltip content={label}>
      <button
        aria-label={label}
        className={clsx(
          "inline-flex cursor-pointer items-center justify-center rounded-md transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40 pointer-coarse:min-h-11 pointer-coarse:min-w-11",
          tone === "danger" ? "text-fg-3 hover:bg-red/12 hover:text-red" : "text-fg-3 hover:bg-hover hover:text-fg",
          "aria-expanded:bg-hover aria-expanded:text-fg",
          className,
        )}
        style={{ width: size, height: size }}
        {...rest}
      >
        <Icon size={Math.round(size * 0.53)} strokeWidth={2} />
      </button>
    </Tooltip>
  );
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={clsx("animate-spin-slow", className)} aria-hidden>
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21.5 12a9.5 9.5 0 0 0-9.5-9.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/* ---------------- small bits ---------------- */

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={clsx(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border border-line-3/70 border-b-2 bg-hl/50 px-1 font-mono text-[10.5px] leading-none text-fg-3",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

const TONES = {
  neutral: "bg-hl/70 text-fg-2 ring-line-3/50",
  blue: "bg-blue/10 text-blue ring-blue/25",
  green: "bg-green/10 text-green ring-green/25",
  yellow: "bg-yellow/10 text-yellow ring-yellow/25",
  orange: "bg-orange/10 text-orange ring-orange/25",
  red: "bg-red/10 text-red ring-red/25",
  magenta: "bg-magenta/10 text-magenta ring-magenta/25",
  cyan: "bg-cyan/10 text-cyan ring-cyan/25",
  teal: "bg-teal/10 text-teal ring-teal/25",
};
export type Tone = keyof typeof TONES;

export function Badge({
  tone = "neutral",
  icon: Icon,
  children,
  className,
  mono,
}: {
  tone?: Tone;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <span
      className={clsx(
        "inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset",
        mono && "font-mono text-[10.5px]",
        TONES[tone],
        className,
      )}
    >
      {Icon && <Icon size={11} strokeWidth={2.25} />}
      {children}
    </span>
  );
}

export function StatusDot({ status, size = 8 }: { status: string; size?: number }) {
  const color =
    status === "online"
      ? "text-green bg-green"
      : status === "offline" || status === "powered-off"
        ? "text-red bg-red"
        : status === "rebooting" || status === "shutting-down"
          ? "text-yellow bg-yellow"
          : "text-fg-4 bg-fg-4";
  const pulse = status === "online" || status === "rebooting" || status === "shutting-down";
  return (
    <span
      className={clsx("inline-block shrink-0 rounded-full", color, pulse && "animate-pulse-dot")}
      style={{ width: size, height: size }}
      aria-hidden
    />
  );
}

export function Meter({
  value,
  color,
  className,
  height = 6,
}: {
  value: number | null | undefined;
  color?: string;
  className?: string;
  height?: number;
}) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const c = color ?? levelColor(value);
  return (
    <div className={clsx("relative w-full overflow-hidden rounded-full bg-hl/80", className)} style={{ height }}>
      <div
        className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700 ease-out"
        style={{
          width: `${v}%`,
          background: `linear-gradient(90deg, color-mix(in srgb, ${c} 70%, transparent), ${c})`,
          boxShadow: `0 0 12px -2px ${c}`,
        }}
      />
    </div>
  );
}

export function SectionTitle({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={clsx("mb-3 flex items-center justify-between gap-3", className)}>
      <h2 className="text-[11px] font-semibold tracking-[0.09em] text-fg-4 uppercase">{children}</h2>
      {right}
    </div>
  );
}

export function Empty({ icon: Icon, title, hint }: { icon: LucideIcon; title: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="mb-1 grid size-10 place-items-center rounded-xl bg-hl/60 text-fg-4 ring-1 ring-line-2">
        <Icon size={18} />
      </div>
      <div className="text-[13px] font-medium text-fg-2">{title}</div>
      {hint && <div className="max-w-sm text-[12px] text-fg-4">{hint}</div>}
    </div>
  );
}

/* ---------------- tooltip ---------------- */

export function Tooltip({
  content,
  children,
  side = "top",
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "top" | "bottom" | "right";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const show = (e: React.SyntheticEvent<HTMLElement>) => {
    // On touch screens a tap would pop the tooltip over what you just tapped.
    if (window.matchMedia("(hover: none)").matches) return;
    // The wrapper is display:contents, so measure the wrapped element.
    const el = ((e.currentTarget as HTMLElement).firstElementChild ?? e.currentTarget) as HTMLElement;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect();
      if (side === "bottom") setPos({ x: r.left + r.width / 2, y: r.bottom + 8 });
      else if (side === "right") setPos({ x: r.right + 8, y: r.top + r.height / 2 });
      else setPos({ x: r.left + r.width / 2, y: r.top - 8 });
      setOpen(true);
    }, 350);
  };
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    setOpen(false);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (!content) return children;
  return (
    <>
      <span
        className="contents"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onPointerDown={hide}
        aria-describedby={open ? id : undefined}
      >
        {children}
      </span>
      {open &&
        pos &&
        createPortal(
          <div
            id={id}
            role="tooltip"
            className="pointer-events-none fixed z-[100] animate-fade-up rounded-md border border-line-3/60 bg-[#0f1017] px-2 py-1 text-[11.5px] font-medium whitespace-nowrap text-fg-2 shadow-xl shadow-black/40"
            style={{
              left: pos.x,
              top: pos.y,
              transform:
                side === "bottom" ? "translate(-50%, 0)" : side === "right" ? "translate(0, -50%)" : "translate(-50%, -100%)",
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}

/* ---------------- modal ---------------- */

export function Modal({
  open,
  onClose,
  title,
  description,
  icon: Icon,
  tone = "blue",
  children,
  footer,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    requestAnimationFrame(() => {
      // An explicit [data-autofocus] wins over whatever field comes first in the DOM.
      const target =
        panel.current?.querySelector<HTMLElement>("[data-autofocus]") ??
        panel.current?.querySelector<HTMLElement>("input, textarea, button:not([data-close])");
      target?.focus();
    });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [open, onClose]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[80] flex items-end justify-center sm:items-start sm:overflow-y-auto sm:px-4 sm:pt-[12vh] sm:pb-10"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <div className="fixed inset-0 bg-[#0a0b10]/70 backdrop-blur-[3px]" onClick={onClose} />
          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            className="card relative w-full overflow-hidden rounded-xl shadow-[0_30px_80px_-20px_rgba(0,0,0,0.8)] max-h-[calc(100dvh-64px)] overflow-y-auto max-sm:max-h-[92dvh] max-sm:overscroll-contain max-sm:rounded-t-[22px] max-sm:rounded-b-none max-sm:border-b-0 max-sm:pb-[env(safe-area-inset-bottom)]"
            style={{ maxWidth: width }}
            initial={{ opacity: 0, y: 24, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.99 }}
            transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <div className="mx-auto mt-2.5 -mb-1 h-1 w-10 rounded-full bg-line-3 sm:hidden" aria-hidden />
            <div className="flex items-start gap-3.5 px-5 pt-5 pb-1">
              {Icon && (
                <div className={clsx("grid size-9 shrink-0 place-items-center rounded-lg ring-1 ring-inset max-sm:hidden", TONES[tone])}>
                  <Icon size={17} strokeWidth={2} />
                </div>
              )}
              <div className="min-w-0 flex-1 pt-0.5">
                <h2 className="text-[15px] font-semibold text-fg max-sm:text-[17px]">{title}</h2>
                {description && <div className="mt-1 text-[12.5px] leading-relaxed text-fg-3 max-sm:text-[14px]">{description}</div>}
              </div>
              <button
                data-close
                onClick={onClose}
                aria-label="Close"
                className="-mt-1 -mr-1 grid size-7 cursor-pointer place-items-center rounded-md text-fg-4 hover:bg-hover hover:text-fg pointer-coarse:size-10 pointer-coarse:-mt-2 pointer-coarse:-mr-2"
              >
                <X size={15} />
              </button>
            </div>
            {children && <div className="px-5 pt-3 pb-1">{children}</div>}
            {footer && (
              <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-void/40 px-5 py-3 max-sm:sticky max-sm:bottom-0 max-sm:bg-[#14151d] max-sm:pb-4">
                {footer}
              </div>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/* ---------------- dropdown menu ---------------- */

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  tone?: "default" | "danger" | "warning";
  hint?: ReactNode;
  disabled?: boolean;
  separatorBefore?: boolean;
}

export function Menu({
  trigger,
  items,
  align = "end",
}: {
  trigger: (props: { onClick: (e: React.MouseEvent) => void; "aria-expanded": boolean; "aria-haspopup": "menu" }) => ReactNode;
  items: MenuItem[];
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(0);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setFocus((f) => {
          const at = enabled.indexOf(f);
          const n = e.key === "ArrowDown" ? (at + 1) % enabled.length : (at - 1 + enabled.length) % enabled.length;
          return enabled[n];
        });
      } else if (e.key === "Enter") {
        e.preventDefault();
        const it = items[focus];
        if (it && !it.disabled) {
          close();
          it.onSelect();
        }
      }
    };
    setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, items, focus, close]);

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const up = r.bottom + 260 > window.innerHeight;
    setPos({ x: align === "end" ? r.right : r.left, y: up ? r.top - 6 : r.bottom + 6, up });
    setFocus(items.findIndex((i) => !i.disabled));
    setOpen((o) => !o);
  };

  return (
    <>
      {trigger({ onClick, "aria-expanded": open, "aria-haspopup": "menu" })}
      {open &&
        pos &&
        createPortal(
          <div
            ref={ref}
            role="menu"
            className="fixed z-[90] min-w-[200px] animate-fade-up rounded-lg border border-line-2 bg-[#171821] p-1 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.75)]"
            style={{
              left: align === "end" ? undefined : pos.x,
              right: align === "end" ? window.innerWidth - pos.x : undefined,
              top: pos.up ? undefined : pos.y,
              bottom: pos.up ? window.innerHeight - pos.y : undefined,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((it, i) => (
              <div key={it.label}>
                {it.separatorBefore && <div className="mx-1 my-1 h-px bg-line-2" />}
                <button
                  role="menuitem"
                  disabled={it.disabled}
                  onMouseEnter={() => setFocus(i)}
                  onClick={() => {
                    close();
                    it.onSelect();
                  }}
                  className={clsx(
                    "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[12.5px] disabled:cursor-default disabled:opacity-40 pointer-coarse:py-2.5 pointer-coarse:text-[14px]",
                    focus === i && "bg-hl",
                    it.tone === "danger" ? "text-red" : it.tone === "warning" ? "text-yellow" : "text-fg-2",
                  )}
                >
                  {it.icon && <it.icon size={14} strokeWidth={2} className="shrink-0 opacity-80" />}
                  <span className="flex-1">{it.label}</span>
                  {it.hint && <span className="text-[11px] text-fg-4">{it.hint}</span>}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/* ---------------- hold-to-confirm ---------------- */

/** A destructive button that fires only after being held for `ms`. */
export function HoldButton({
  onConfirm,
  children,
  icon: Icon,
  tone = "red",
  ms = 900,
  className,
  solid,
}: {
  solid?: boolean;
  onConfirm: () => void;
  children: ReactNode;
  icon?: LucideIcon;
  tone?: "red" | "yellow";
  ms?: number;
  className?: string;
}) {
  const [progress, setProgress] = useState(0);
  const raf = useRef<number | null>(null);
  const start = useRef<number | null>(null);
  const fired = useRef(false);

  const stop = () => {
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    start.current = null;
    if (!fired.current) setProgress(0);
  };
  const begin = () => {
    if (raf.current || fired.current) return;
    navigator.vibrate?.(10);
    start.current = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - (start.current ?? t)) / ms);
      setProgress(p);
      if (p >= 1) {
        fired.current = true;
        raf.current = null;
        navigator.vibrate?.([20, 40, 20]);
        onConfirm();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    },
    [],
  );

  const color = tone === "red" ? "#f7768e" : "#e0af68";
  return (
    <button
      data-autofocus
      onPointerDown={begin}
      onPointerUp={stop}
      onPointerLeave={stop}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter" || e.key === " ") stop();
      }}
      className={clsx(
        "relative inline-flex h-9 cursor-pointer touch-none items-center justify-center gap-2 overflow-hidden rounded-md px-4 text-[13px] font-semibold select-none pointer-coarse:h-11 pointer-coarse:text-[14px]",
        className,
      )}
      style={
        solid
          ? { color: "#1a1b26", background: color }
          : {
              color,
              background: `color-mix(in srgb, ${color} 12%, transparent)`,
              boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 35%, transparent)`,
            }
      }
    >
      <span
        aria-hidden
        className="absolute inset-y-0 left-0"
        style={{
          width: `${progress * 100}%`,
          background: solid ? "rgba(0,0,0,0.22)" : `color-mix(in srgb, ${color} 28%, transparent)`,
        }}
      />
      <span className="relative inline-flex items-center gap-2">
        {Icon && <Icon size={15} strokeWidth={2.2} />}
        {children}
      </span>
    </button>
  );
}

/* ---------------- copy ---------------- */

export function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      setTimeout(() => setCopied((c) => (c === text ? null : c)), 1400);
    } catch {
      /* clipboard blocked */
    }
  }, []);
  return { copied, copy };
}
