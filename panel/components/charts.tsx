"use client";

import { useId, useMemo, useRef, useState } from "react";

type Pt = [number, number];

/** Monotone cubic path through points (no overshoot, keeps charts honest). */
function smoothPath(pts: Pt[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const n = pts.length;
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    m[i] = dx[i] === 0 ? 0 : (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  const t: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  t[n - 1] = m[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i] / m[i];
    const b = t[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      t[i] = k * a * m[i];
      t[i + 1] = k * b * m[i];
    }
  }
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${(pts[i][0] + h).toFixed(2)},${(pts[i][1] + h * t[i]).toFixed(2)} ${(pts[i + 1][0] - h).toFixed(2)},${(
      pts[i + 1][1] -
      h * t[i + 1]
    ).toFixed(2)} ${pts[i + 1][0].toFixed(2)},${pts[i + 1][1].toFixed(2)}`;
  }
  return d;
}

/**
 * Small trend line. Stretches whatever history exists across the full width,
 * and draws nothing until there are enough points to be meaningful.
 */
export function Sparkline({
  values,
  color,
  height = 32,
  max = 100,
  width = 120,
  minPoints = 4,
}: {
  values: (number | null)[];
  color: string;
  height?: number;
  max?: number;
  width?: number;
  minPoints?: number;
}) {
  const id = useId();
  const clean = values.filter((v): v is number => v != null);
  if (clean.length < minPoints) return null;
  const top = Math.max(max, ...clean);
  const step = width / (clean.length - 1);
  const pts: Pt[] = clean.map((v, i) => [i * step, height - 1.5 - (v / top) * (height - 3)]);
  const line = smoothPath(pts);
  const last = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="block h-full w-full" aria-hidden>
      <defs>
        <linearGradient id={`g${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.28" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L${last[0]},${height}L0,${height}Z`} fill={`url(#g${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export interface Series {
  label: string;
  color: string;
  values: (number | null)[];
}

/** Multi-series live area chart with a hover crosshair readout. */
export function AreaChart({
  series,
  times,
  height = 160,
  max,
  format,
  slots = 100,
  interval = 3,
}: {
  series: Series[];
  times: number[];
  height?: number;
  max?: number;
  format: (v: number) => string;
  slots?: number;
  interval?: number;
}) {
  const id = useId();
  const W = 600;
  const H = height;
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
  const top = useMemo(() => {
    if (max != null) return max;
    const m = Math.max(1, ...all);
    // round up to a "nice" ceiling so gridlines land on readable values
    const p = 10 ** Math.floor(Math.log10(m));
    const n = m / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
  }, [all, max]);

  // Rates have no value for the first sample; start the window at the first real one.
  const first = Math.min(...series.map((s) => {
    const i = s.values.findIndex((v) => v != null);
    return i < 0 ? Infinity : i;
  }));
  if (Number.isFinite(first) && first > 0) {
    series = series.map((s) => ({ ...s, values: s.values.slice(first) }));
    times = times.slice(first);
  }
  const n = Math.max(...series.map((s) => s.values.length), 0);
  // Until the window fills, stretch what we have instead of leaving the left side blank.
  const window = Math.max(Math.min(slots, n), 2);
  const step = W / (window - 1);
  const offset = Math.max(0, window - n) * step;
  const y = (v: number) => H - 1 - (v / top) * (H - 6);

  const onMove = (e: React.PointerEvent) => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r || n === 0) return;
    const x = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round((x - offset) / step);
    setHover(i < 0 || i >= n ? null : i);
  };

  const hx = hover != null ? offset + hover * step : null;
  const span = n > 1 && times[0] && times[n - 1] ? (times[n - 1] - times[0]) / 1000 : 0;
  const collecting = n < 2;

  return (
    <div
      ref={wrap}
      className="relative mb-[18px] select-none"
      style={{ height: H }}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
        <defs>
          {series.map((s, si) => (
            <linearGradient key={si} id={`a${id}${si}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1="0"
            x2={W}
            y1={y(top * f)}
            y2={y(top * f)}
            stroke="#292e42"
            strokeDasharray="2 4"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} stroke="#2a2e44" vectorEffect="non-scaling-stroke" />
        {series.map((s, si) => {
          const pts: Pt[] = [];
          s.values.forEach((v, i) => {
            if (v != null) pts.push([offset + i * step, y(v)]);
          });
          if (pts.length < 2) return null;
          const line = smoothPath(pts);
          return (
            <g key={si}>
              <path d={`${line}L${pts[pts.length - 1][0]},${H}L${pts[0][0]},${H}Z`} fill={`url(#a${id}${si})`} />
              <path
                d={line}
                fill="none"
                stroke={s.color}
                strokeWidth="1.75"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            </g>
          );
        })}
        {hx != null && <line x1={hx} x2={hx} y1="0" y2={H} stroke="#565f89" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
      </svg>
      {/* y-axis labels sit on the quiet left edge, knocked out from the grid */}
      <div className="pointer-events-none absolute top-0 left-0 font-mono text-[10px] leading-none text-fg-5" style={{ transform: `translateY(${y(top) - 5}px)` }}>
        <span className="bg-panel pr-1.5">{format(top)}</span>
      </div>
      <div className="pointer-events-none absolute top-0 left-0 font-mono text-[10px] leading-none text-fg-5" style={{ transform: `translateY(${y(top / 2) - 5}px)` }}>
        <span className="bg-panel pr-1.5">{format(top / 2)}</span>
      </div>
      <div className="pointer-events-none absolute right-0 -bottom-[17px] left-0 flex justify-between font-mono text-[10px] text-fg-5">
        <span>{span > 0 ? `−${span >= 120 ? `${Math.round(span / 60)}m` : `${Math.round(span)}s`}` : ""}</span>
        <span>now</span>
      </div>
      {collecting && (
        <div className="absolute top-1 right-1">
          <div className="flex items-center gap-2 rounded-full border border-line-2 bg-panel/90 px-2.5 py-0.5 text-[11px] text-fg-4">
            <span className="size-1.5 animate-pulse-dot rounded-full bg-blue text-blue" />
            Collecting samples…
          </div>
        </div>
      )}
      {hover != null && hx != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-md border border-line-3/60 bg-[#0f1017]/95 px-2.5 py-1.5 text-[11px] shadow-xl backdrop-blur"
          style={{
            left: `${(hx / W) * 100}%`,
            transform: hx > W * 0.6 ? "translateX(calc(-100% - 10px))" : "translateX(10px)",
          }}
        >
          <div className="mb-1 font-mono text-[10px] text-fg-4">
            {times[hover] && times[n - 1] ? (times[n - 1] === times[hover] ? "latest" : `${Math.round((times[n - 1] - times[hover]) / 1000)}s earlier`) : ""}
          </div>
          {series.map((s) => (
            <div key={s.label} className="flex items-center gap-2 whitespace-nowrap">
              <span className="size-1.5 rounded-full" style={{ background: s.color }} />
              <span className="text-fg-3">{s.label}</span>
              <span className="ml-auto pl-3 font-mono text-fg tabular">
                {s.values[hover] != null ? format(s.values[hover] as number) : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
      <span className="sr-only">Live chart, one sample every {interval} seconds</span>
    </div>
  );
}

/** Circular utilisation gauge. */
export function Ring({
  value,
  color,
  size = 56,
  stroke = 5,
  children,
}: {
  value: number | null;
  color: string;
  size?: number;
  stroke?: number;
  children?: React.ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#292e42" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
          style={{ transition: "stroke-dashoffset 0.7s ease-out, stroke 0.3s", filter: `drop-shadow(0 0 4px ${color}66)` }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center">{children}</div>
    </div>
  );
}
