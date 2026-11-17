#!/usr/bin/env node
// Renders the README's images (docs/readme/*.webp) in Tokyo Night (dark) and Tokyo Night Day (light).
//
//   node docs/readme/build.mjs
//
// Needs rsvg-convert (librsvg), ImageMagick (`magick`) and cwebp on PATH, and the panel's fonts,
// Inter / Inter Display and JetBrains Mono, installed or reachable through FONTCONFIG_FILE.
// The mock-ups use made-up machines; nothing here comes from a real inventory.
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
const SCALE = 2;

// folke/tokyonight.nvim: night (as in panel/app/globals.css) and day.
const THEMES = {
  dark: {
    page: "#16161e", bg: "#1a1b26", raised: "#1f2335", hover: "#24283b", hl: "#292e42", sel: "#283457",
    line: "#2a2e44", line3: "#3b4261", fg: "#c0caf5", fg2: "#a9b1d6", fg4: "#8088b0", fg5: "#646d96", fg6: "#414868",
    blue: "#7aa2f7", cyan: "#7dcfff", magenta: "#bb9af7", green: "#9ece6a", yellow: "#e0af68",
    orange: "#ff9e64", red: "#f7768e", teal: "#73daca", onAccent: "#16161e", glow: 0.22,
  },
  light: {
    page: "#d0d5e3", bg: "#e1e2e7", raised: "#e9e9ed", hover: "#dfe1ea", hl: "#d5d8e4", sel: "#b7c1e3",
    line: "#c4c8da", line3: "#a8aecb", fg: "#3760bf", fg2: "#6172b0", fg4: "#7b84ad", fg5: "#8990b3", fg6: "#a8aecb",
    blue: "#2e7de9", cyan: "#007197", magenta: "#9854f1", green: "#587539", yellow: "#8c6c3e",
    orange: "#b15c00", red: "#f52a65", teal: "#118c74", onAccent: "#ffffff", glow: 0.16,
  },
};

const SANS = "Inter, sans-serif";
const DISPLAY = "'Inter Display', Inter, sans-serif";
const MONO = "'JetBrains Mono', monospace";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- primitives ----------

const text = (x, y, s, { size = 14, fill, font = SANS, weight = 400, anchor = "start", opacity, ls } = {}) =>
  `<text x="${x}" y="${y}" font-family="${font}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${opacity ? ` opacity="${opacity}"` : ""}${ls ? ` letter-spacing="${ls}"` : ""}>${s}</text>`;
const rect = (x, y, w, h, { rx = 0, fill = "none", stroke, sw = 1, opacity } = {}) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ""}${opacity ? ` opacity="${opacity}"` : ""}/>`;
const circle = (cx, cy, r, fill, extra = "") => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" ${extra}/>`;

function defs(t, w, h) {
  return `<defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.blue}"/><stop offset="1" stop-color="${t.magenta}"/></linearGradient>
    <radialGradient id="glowA" cx="0.18" cy="0.0" r="0.75"><stop offset="0" stop-color="${t.blue}" stop-opacity="${t.glow}"/><stop offset="1" stop-color="${t.blue}" stop-opacity="0"/></radialGradient>
    <radialGradient id="glowB" cx="0.9" cy="0.15" r="0.6"><stop offset="0" stop-color="${t.magenta}" stop-opacity="${t.glow * 0.8}"/><stop offset="1" stop-color="${t.magenta}" stop-opacity="0"/></radialGradient>
    <linearGradient id="edge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.blue}" stop-opacity=".45"/><stop offset="0.5" stop-color="${t.line3}" stop-opacity=".5"/><stop offset="1" stop-color="${t.magenta}" stop-opacity=".35"/></linearGradient>
    <linearGradient id="fadeDown" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.page}" stop-opacity="0"/><stop offset="1" stop-color="${t.page}" stop-opacity="1"/></linearGradient>
    <linearGradient id="spark" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.blue}" stop-opacity=".35"/><stop offset="1" stop-color="${t.blue}" stop-opacity="0"/></linearGradient>
    <linearGradient id="sparkM" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.magenta}" stop-opacity=".35"/><stop offset="1" stop-color="${t.magenta}" stop-opacity="0"/></linearGradient>
    <linearGradient id="sparkG" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.teal}" stop-opacity=".35"/><stop offset="1" stop-color="${t.teal}" stop-opacity="0"/></linearGradient>
    <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="${t.fg6}" opacity=".35"/></pattern>
    <clipPath id="card"><rect width="${w}" height="${h}" rx="24"/></clipPath>
  </defs>`;
}

// The rounded backdrop every illustration sits on.
function backdrop(t, w, h) {
  return `<g clip-path="url(#card)">
    ${rect(0, 0, w, h, { fill: t.page })}
    ${rect(0, 0, w, h, { fill: "url(#dots)" })}
    ${rect(0, 0, w, h, { fill: "url(#glowA)" })}
    ${rect(0, 0, w, h, { fill: "url(#glowB)" })}
  </g>
  ${rect(0.75, 0.75, w - 1.5, h - 1.5, { rx: 23.25, stroke: "url(#edge)", sw: 1.5 })}`;
}

// The panel's icon: a `>_` prompt in the accent gradient.
function logo(t, x, y, size) {
  const k = size / 512;
  return `<g transform="translate(${x} ${y}) scale(${k})">
    <rect x="16" y="16" width="480" height="480" rx="112" fill="${t.raised}"/>
    <rect x="17.5" y="17.5" width="477" height="477" rx="110.5" fill="none" stroke="url(#edge)" stroke-width="6"/>
    <path d="M160 176 L240 256 L160 336" fill="none" stroke="url(#accent)" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M276 336 H360" stroke="${t.cyan}" stroke-width="44" stroke-linecap="round"/>
  </g>`;
}

function windowFrame(t, x, y, w, h, title) {
  return `<g>
    ${rect(x, y + 6, w, h, { rx: 14, fill: "#000", opacity: t === THEMES.dark ? 0.35 : 0.08 })}
    ${rect(x, y, w, h, { rx: 14, fill: t.bg, stroke: t.line3, sw: 1 })}
    <path d="M${x} ${y + 14} a14 14 0 0 1 14 -14 h${w - 28} a14 14 0 0 1 14 14 v26 h-${w} z" fill="${t.raised}"/>
    <line x1="${x}" y1="${y + 40}" x2="${x + w}" y2="${y + 40}" stroke="${t.line}"/>
    ${circle(x + 20, y + 20, 5.5, t.red)}${circle(x + 38, y + 20, 5.5, t.yellow)}${circle(x + 56, y + 20, 5.5, t.green)}
    ${title ? rect(x + w / 2 - 130, y + 9, 260, 22, { rx: 7, fill: t.bg, stroke: t.line }) + text(x + w / 2, y + 24.5, esc(title), { size: 11.5, fill: t.fg4, font: MONO, anchor: "middle" }) : ""}
  </g>`;
}

// Deterministic wiggle for sparklines.
function series(seed, n, base, amp) {
  let s = seed;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const out = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    v += (rnd() - 0.5) * amp;
    v = Math.max(0.06, Math.min(0.94, v * 0.85 + base * 0.15));
    out.push(v);
  }
  return out;
}
function sparkline(x, y, w, h, vals, stroke, fillId) {
  const pts = vals.map((v, i) => [x + (i * w) / (vals.length - 1), y + h - v * h]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  return `<path d="${line} L${x + w} ${y + h} L${x} ${y + h} Z" fill="url(#${fillId})"/><path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round"/>`;
}

function pill(t, x, y, label, color, { mono = false, size = 10.5 } = {}) {
  const w = label.length * (mono ? 6.6 : 6.2) + 16;
  return {
    w,
    svg: `${rect(x, y, w, 20, { rx: 10, fill: color, opacity: 0.14 })}${rect(x + 0.5, y + 0.5, w - 1, 19, { rx: 9.5, stroke: color, sw: 1, opacity: 0.45 })}${text(x + w / 2, y + 14, esc(label), { size, fill: color, anchor: "middle", weight: 600, font: mono ? MONO : SANS })}`,
  };
}

function bar(t, x, y, w, label, pct, color) {
  return `${text(x, y, label, { size: 10.5, fill: t.fg4, font: MONO })}
    ${rect(x + 40, y - 7, w - 82, 6, { rx: 3, fill: t.hl })}
    ${rect(x + 40, y - 7, Math.max(6, (w - 82) * pct), 6, { rx: 3, fill: color })}
    ${text(x + w, y, `${Math.round(pct * 100)}%`, { size: 10.5, fill: t.fg2, font: MONO, anchor: "end" })}`;
}

function machineCard(t, x, y, w, h, m) {
  const online = !m.offline;
  let s = rect(x, y, w, h, { rx: 12, fill: t.raised, stroke: t.line, sw: 1 });
  s += circle(x + 20, y + 24, 4.5, online ? t.green : t.fg5);
  if (online) s += `<circle cx="${x + 20}" cy="${y + 24}" r="8" fill="none" stroke="${t.green}" stroke-opacity=".3" stroke-width="2"/>`;
  s += text(x + 34, y + 28.5, esc(m.name), { size: 14, fill: online ? t.fg : t.fg4, weight: 600 });
  s += text(x + 20, y + 48, esc(m.os), { size: 10.5, fill: t.fg5, font: MONO });
  let px = x + w - 16;
  for (const p of (m.pills || []).slice().reverse()) {
    const pl = pill(t, 0, 0, p[0], t[p[1]]);
    px -= pl.w;
    s += `<g transform="translate(${px} ${y + 14})">${pl.svg}</g>`;
    px -= 6;
  }
  if (online) {
    s += bar(t, x + 20, y + 74, w - 40, "cpu", m.cpu, t.blue);
    s += bar(t, x + 20, y + 94, w - 40, "mem", m.mem, t.magenta);
    s += bar(t, x + 20, y + 114, w - 40, "disk", m.disk, m.disk > 0.85 ? t.orange : t.teal);
    s += sparkline(x + 1, y + h - 38, w - 2, 30, series(m.seed, 28, m.cpu, 0.35), t.blue, "spark");
    s += text(x + w - 16, y + 48, esc(m.up), { size: 10.5, fill: t.fg5, font: MONO, anchor: "end" });
  } else {
    s += text(x + 20, y + 78, "offline · last seen 2h ago", { size: 11.5, fill: t.fg4 });
    s += rect(x + 20, y + 92, 64, 26, { rx: 7, fill: t.hover, stroke: t.line3 }) + text(x + 52, y + 109, "Retry", { size: 11.5, fill: t.fg2, anchor: "middle", weight: 500 });
    s += rect(x + 92, y + 92, 64, 26, { rx: 7, fill: t.blue, opacity: 0.16 }) + rect(x + 92.5, y + 92.5, 63, 25, { rx: 6.5, stroke: t.blue, opacity: 0.5 }) + text(x + 124, y + 109, "Wake", { size: 11.5, fill: t.blue, anchor: "middle", weight: 600 });
    s += rect(x + 20, y + h - 36, w - 40, 24, { rx: 6, fill: t.bg, stroke: t.line }) + text(x + 30, y + h - 19.5, esc(m.ssh), { size: 10.5, fill: t.fg2, font: MONO });
    s += text(x + w - 30, y + h - 19.5, "⧉", { size: 11, fill: t.fg5, anchor: "end" });
  }
  return s;
}

const MACHINES = [
  { name: "homeserver", os: "Debian 13 · 6.12 · x86_64", cpu: 0.18, mem: 0.46, disk: 0.62, seed: 7, up: "up 41d", pills: [["panel", "cyan"]] },
  { name: "workstation", os: "Arch Linux · 6.17 · x86_64", cpu: 0.57, mem: 0.71, disk: 0.48, seed: 21, up: "up 3d", pills: [["12 updates", "yellow"]] },
  { name: "thinkpad", os: "Fedora 43 · laptop", offline: true, ssh: "ssh me@thinkpad.local" },
  { name: "rpi-5", os: "Raspberry Pi OS · aarch64", cpu: 0.31, mem: 0.38, disk: 0.91, seed: 3, up: "up 9d", pills: [["reboot", "orange"]] },
  { name: "vps-fra1", os: "Ubuntu 24.04 · 2 vCPU", cpu: 0.09, mem: 0.52, disk: 0.34, seed: 11, up: "up 128d", pills: [["agent", "magenta"]] },
  { name: "nas", os: "Debian 12 · 4 disks", cpu: 0.04, mem: 0.22, disk: 0.77, seed: 5, up: "up 63d" },
];

function sidebar(t, x, y, h, active) {
  const items = ["Overview", "Machines", "Activity", "AI chat", "AI proxy", "Claude skill"];
  let s = rect(x, y, 188, h, { fill: t.bg });
  s += `<line x1="${x + 188}" y1="${y}" x2="${x + 188}" y2="${y + h}" stroke="${t.line}"/>`;
  s += logo(t, x + 18, y + 18, 26) + text(x + 52, y + 36, "fleet", { size: 15, fill: t.fg, font: MONO, weight: 700 });
  items.forEach((it, i) => {
    const iy = y + 70 + i * 34;
    if (it === active) s += rect(x + 10, iy - 17, 168, 28, { rx: 7, fill: t.sel });
    s += rect(x + 22, iy - 8, 10, 10, { rx: 3, fill: "none", stroke: it === active ? t.blue : t.fg5, sw: 1.5 });
    s += text(x + 42, iy + 1.5, it, { size: 12.5, fill: it === active ? t.fg : t.fg4, weight: it === active ? 600 : 400 });
  });
  s += rect(x + 12, y + 290, 164, 30, { rx: 7, fill: t.raised, stroke: t.line });
  s += text(x + 24, y + 309.5, "Search", { size: 12, fill: t.fg5 }) + rect(x + 126, y + 297, 40, 16, { rx: 4, fill: t.hl }) + text(x + 146, y + 308.5, "⌃K", { size: 10, fill: t.fg4, anchor: "middle", font: MONO });
  return s;
}

// ---------- images ----------

function hero(t) {
  const W = 1280, H = 720;
  let s = backdrop(t, W, H);
  s += logo(t, 466, 62, 68);
  s += text(550, 117, "fleet", { size: 68, fill: t.fg, font: MONO, weight: 800, ls: -2 });
  s += text(W / 2, 176, "A control panel for the computers you run.", { size: 24, fill: t.fg2, font: DISPLAY, weight: 600, anchor: "middle" });
  const tags = [["ssh", t.blue], ["fleet-agent", t.magenta], ["terminal", t.cyan], ["ai chat", t.green], ["ai proxy", t.orange], ["claude skill", t.yellow]];
  let tw = tags.reduce((a, [l]) => a + l.length * 7.2 + 34, 0);
  let tx = W / 2 - tw / 2;
  for (const [l, c] of tags) {
    s += circle(tx + 5, 211, 3.5, c) + text(tx + 14, 215.5, l, { size: 12.5, fill: t.fg4, font: MONO });
    tx += l.length * 7.2 + 34;
  }
  // panel window
  const wx = 110, wy = 252, ww = 1060, wh = 520;
  s += `<g clip-path="url(#card)">`;
  s += windowFrame(t, wx, wy, ww, wh, "http://homeserver:4747");
  s += sidebar(t, wx + 1, wy + 41, wh - 42, "Overview");
  const mx = wx + 189 + 26, my = wy + 41;
  s += text(mx, my + 40, "Overview", { size: 20, fill: t.fg, font: DISPLAY, weight: 700 });
  let px = mx + 112;
  for (const [l, c] of [["5 online", "green"], ["1 offline", "fg4"], ["12 updates", "yellow"], ["1 reboot", "orange"]]) {
    const pl = pill(t, px, my + 25, l, t[c]);
    s += pl.svg;
    px += pl.w + 8;
  }
  s += rect(wx + ww - 150, my + 22, 124, 28, { rx: 7, fill: t.blue }) + text(wx + ww - 88, my + 40.5, "+ Add machine", { size: 12, fill: t.onAccent, anchor: "middle", weight: 600 });
  const cw = 262, ch = 168, gap = 16;
  MACHINES.forEach((m, i) => {
    const cx = mx + (i % 3) * (cw + gap), cy = my + 70 + Math.floor(i / 3) * (ch + gap);
    s += machineCard(t, cx, cy, cw, ch, m);
  });
  s += rect(0, H - 120, W, 120, { fill: "url(#fadeDown)" });
  s += `</g>`;
  s += rect(0.75, 0.75, W - 1.5, H - 1.5, { rx: 23.25, stroke: "url(#edge)", sw: 1.5 });
  return { W, H, s };
}

function terminal(t) {
  const W = 1280, H = 560;
  let s = backdrop(t, W, H);
  const wx = 90, wy = 56, ww = 1100, wh = 470;
  s += windowFrame(t, wx, wy, ww, wh, "");
  // tabs
  const tabs = [["update", "thinkpad", true], ["shell", "workstation"], ["logs", "nginx · vps-fra1"], ["exec", "3 machines"]];
  let tx = wx + 80;
  for (const [k, n, act] of tabs) {
    const label = `${k} · ${n}`;
    const tw = label.length * 7.4 + 44;
    if (act) s += rect(tx, wy + 7, tw, 27, { rx: 7, fill: t.bg, stroke: t.line3 });
    s += circle(tx + 14, wy + 20.5, 3.5, act ? t.green : k === "logs" ? t.cyan : t.fg5);
    s += text(tx + 24, wy + 25, esc(label), { size: 12, fill: act ? t.fg : t.fg4, font: MONO, weight: act ? 600 : 400 });
    s += text(tx + tw - 13, wy + 25, "×", { size: 13, fill: t.fg5, anchor: "middle" });
    tx += tw + 6;
  }
  s += text(wx + ww - 20, wy + 25, "⌃`", { size: 12, fill: t.fg5, font: MONO, anchor: "end" });
  const L = [
    [[t.green, "me@thinkpad"], [t.fg5, ":"], [t.blue, "~"], [t.fg, " $ sudo dnf upgrade --refresh"]],
    [[t.fg4, "Updating and loading repositories:"]],
    [[t.fg2, " Fedora 43 - x86_64 - Updates      "], [t.green, "100% "], [t.fg4, "| 4.1 MiB/s |  12.3 MiB |  00m03s"]],
    [[t.fg2, " Fedora 43 - x86_64                "], [t.green, "100% "], [t.fg4, "| 0.0 B/s   |   0.0 B   |  00m00s"]],
    [[t.fg4, "Repositories loaded."]],
    [[t.fg, "Package                  Arch    Version              Repository      Size"]],
    [[t.magenta, "Upgrading:"]],
    [[t.fg2, " kernel                  x86_64  "], [t.cyan, "6.17.8-300.fc43       "], [t.fg4, "updates     0.0   B"]],
    [[t.fg2, " mesa-dri-drivers        x86_64  "], [t.cyan, "25.2.6-1.fc43         "], [t.fg4, "updates    46.9 MiB"]],
    [[t.fg2, " firefox                 x86_64  "], [t.cyan, "145.0-1.fc43          "], [t.fg4, "updates   281.0 MiB"]],
    [[t.fg5, "   … 9 more"]],
    [[t.fg, "Transaction Summary:"]],
    [[t.fg2, " Upgrading:        "], [t.yellow, "12 packages"]],
    [[t.fg, "Is this ok [y/N]: "], [t.blue, "█"]],
  ];
  L.forEach((line, i) => {
    let lx = wx + 28;
    const y = wy + 76 + i * 25;
    s += `<text x="${lx}" y="${y}" font-family="${MONO}" font-size="13.5" xml:space="preserve">${line.map(([c, str]) => `<tspan fill="${c}">${esc(str)}</tspan>`).join("")}</text>`;
  });
  // status line
  s += `<line x1="${wx}" y1="${wy + wh - 34}" x2="${wx + ww}" y2="${wy + wh - 34}" stroke="${t.line}"/>`;
  s += text(wx + 20, wy + wh - 13, "● running on thinkpad over ssh · you can type into it", { size: 11.5, fill: t.fg4, font: MONO });
  s += text(wx + ww - 20, wy + wh - 13, "sessions survive a reload", { size: 11.5, fill: t.fg5, font: MONO, anchor: "end" });
  return { W, H, s };
}

function chat(t) {
  const W = 1280, H = 600;
  let s = backdrop(t, W, H);
  const wx = 190, wy = 48, ww = 900, wh = 520;
  s += windowFrame(t, wx, wy, ww, wh, "");
  s += text(wx + 80, wy + 25.5, "AI chat", { size: 13, fill: t.fg, weight: 600 }) + text(wx + 136, wy + 25.5, "· vps-fra1", { size: 13, fill: t.fg4, font: MONO });
  // mode toggle
  s += rect(wx + ww - 196, wy + 8, 180, 25, { rx: 7, fill: t.bg, stroke: t.line });
  s += rect(wx + ww - 194, wy + 10, 92, 21, { rx: 5.5, fill: t.sel }) + text(wx + ww - 148, wy + 25, "Ask first", { size: 11.5, fill: t.fg, anchor: "middle", weight: 600 });
  s += text(wx + ww - 59, wy + 25, "Auto", { size: 11.5, fill: t.fg5, anchor: "middle" });
  const cx = wx + 36;
  // user message
  const um = "nginx keeps failing on vps-fra1. Why?";
  s += rect(wx + ww - 36 - 330, wy + 66, 330, 40, { rx: 12, fill: t.sel }) + text(wx + ww - 36 - 16, wy + 91, um, { size: 13.5, fill: t.fg, anchor: "end" });
  s += text(cx, wy + 140, "Checking the unit first.", { size: 13.5, fill: t.fg2 });
  // done command card
  let y = wy + 158;
  s += rect(cx, y, ww - 72, 76, { rx: 10, fill: t.raised, stroke: t.line });
  s += text(cx + 16, y + 22, "run_command", { size: 11, fill: t.fg5, font: MONO }) + text(cx + 110, y + 22, "vps-fra1", { size: 11, fill: t.cyan, font: MONO });
  s += text(cx + ww - 88, y + 22, "exit 3", { size: 11, fill: t.red, font: MONO, anchor: "end" });
  s += text(cx + 16, y + 44, "$ systemctl status nginx --no-pager", { size: 12.5, fill: t.fg, font: MONO });
  s += text(cx + 16, y + 64, "Active: failed (Result: exit-code) · bind() to 0.0.0.0:443 failed (98: Address in use)", { size: 11.5, fill: t.fg4, font: MONO });
  s += text(cx, y + 108, "Something else holds port 443. Let me see what.", { size: 13.5, fill: t.fg2 });
  // pending command card
  y += 128;
  s += rect(cx, y, ww - 72, 112, { rx: 10, fill: t.raised, stroke: t.blue, sw: 1.5 });
  s += text(cx + 16, y + 22, "run_command", { size: 11, fill: t.fg5, font: MONO }) + text(cx + 110, y + 22, "vps-fra1", { size: 11, fill: t.cyan, font: MONO });
  const wp = pill(t, cx + ww - 72 - 16 - 140, y + 9, "waiting for you", t.yellow);
  s += `<g transform="translate(${ww - 72 - 16 - wp.w - (ww - 72 - 16 - 140)} 0)">${wp.svg}</g>`;
  s += text(cx + 16, y + 48, "$ sudo ss -ltnp 'sport = :443'", { size: 12.5, fill: t.fg, font: MONO });
  s += rect(cx + 16, y + 66, 92, 30, { rx: 8, fill: t.blue }) + text(cx + 62, y + 85.5, "Approve", { size: 12.5, fill: t.onAccent, anchor: "middle", weight: 600 });
  s += rect(cx + 116, y + 66, 72, 30, { rx: 8, fill: t.hover, stroke: t.line3 }) + text(cx + 152, y + 85.5, "Deny", { size: 12.5, fill: t.fg2, anchor: "middle", weight: 500 });
  s += text(cx + 204, y + 85.5, "Every command and file write waits for a yes in Ask first.", { size: 11.5, fill: t.fg5 });
  // input
  y = wy + wh - 66;
  s += rect(cx, y, ww - 72, 44, { rx: 12, fill: t.bg, stroke: t.line3 });
  s += text(cx + 18, y + 27, "Ask about vps-fra1…", { size: 13.5, fill: t.fg5 });
  s += rect(cx + ww - 72 - 40, y + 8, 28, 28, { rx: 8, fill: t.blue }) + `<path d="M${cx + ww - 72 - 26} ${y + 28} v-12 m-5 5 l5 -5 l5 5" stroke="${t.onAccent}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
  return { W, H, s };
}

function phone(t, x, y, inner) {
  const w = 300, h = 560;
  return `${rect(x, y + 8, w, h, { rx: 44, fill: "#000", opacity: t === THEMES.dark ? 0.35 : 0.1 })}
    ${rect(x, y, w, h, { rx: 44, fill: t.raised, stroke: t.line3, sw: 1.5 })}
    ${rect(x + 10, y + 10, w - 20, h - 20, { rx: 35, fill: t.bg })}
    <clipPath id="ph${x}"><rect x="${x + 10}" y="${y + 10}" width="${w - 20}" height="${h - 20}" rx="35"/></clipPath>
    <g clip-path="url(#ph${x})">${inner(x + 10, y + 10, w - 20, h - 20)}</g>
    ${rect(x + w / 2 - 48, y + 20, 96, 26, { rx: 13, fill: "#000" })}`;
}

function phones(t) {
  const W = 1280, H = 640;
  let s = backdrop(t, W, H);
  // left phone: overview list
  s += phone(t, 300, 40, (x, y, w) => {
    let r = text(x + 26, y + 46, "9:41", { size: 13, fill: t.fg, weight: 600 });
    r += logo(t, x + 20, y + 70, 24) + text(x + 52, y + 87, "Overview", { size: 17, fill: t.fg, font: DISPLAY, weight: 700 });
    MACHINES.forEach((m, i) => {
      const cy = y + 112 + i * 66;
      r += rect(x + 14, cy, w - 28, 58, { rx: 12, fill: t.raised, stroke: t.line });
      r += circle(x + 32, cy + 22, 4.5, m.offline ? t.fg5 : t.green);
      r += text(x + 44, cy + 26.5, esc(m.name), { size: 13.5, fill: m.offline ? t.fg4 : t.fg, weight: 600 });
      if (m.offline) {
        r += rect(x + w - 86, cy + 15, 58, 26, { rx: 7, fill: t.blue, opacity: 0.16 }) + text(x + w - 57, cy + 32, "Wake", { size: 11.5, fill: t.blue, anchor: "middle", weight: 600 });
        r += text(x + 32, cy + 45, "offline", { size: 10.5, fill: t.fg5, font: MONO });
      } else {
        r += text(x + 32, cy + 45, `cpu ${Math.round(m.cpu * 100)}% · mem ${Math.round(m.mem * 100)}%`, { size: 10.5, fill: t.fg5, font: MONO });
        r += sparkline(x + w - 112, cy + 12, 84, 30, series(m.seed, 18, m.cpu, 0.4), t.blue, "spark");
      }
    });
    return r;
  });
  // right phone: full-screen terminal with the extra-keys row
  s += phone(t, 680, 40, (x, y, w, h) => {
    let r = text(x + 26, y + 46, "9:41", { size: 13, fill: t.fg, weight: 600 });
    r += rect(x, y + 62, w, 36, { fill: t.raised }) + circle(x + 20, y + 80, 3.5, t.green) + text(x + 30, y + 84.5, "shell · rpi-5", { size: 12, fill: t.fg, font: MONO, weight: 600 });
    const lines = [
      [[t.green, "pi@rpi-5"], [t.fg, " $ df -h /"]],
      [[t.fg4, "Filesystem  Size Used Avail Use%"]],
      [[t.fg2, "/dev/sda2   117G 106G  6.0G "], [t.orange, " 95%"]],
      [[t.green, "pi@rpi-5"], [t.fg, " $ docker system prune"]],
      [[t.fg4, "WARNING! This will remove:"]],
      [[t.fg4, "  - all stopped containers"]],
      [[t.fg4, "  - all dangling images"]],
      [[t.fg, "Are you sure? [y/N] "], [t.blue, "█"]],
    ];
    lines.forEach((line, i) => {
      r += `<text x="${x + 16}" y="${y + 124 + i * 21}" font-family="${MONO}" font-size="11.5" xml:space="preserve">${line.map(([c, str]) => `<tspan fill="${c}">${esc(str)}</tspan>`).join("")}</text>`;
    });
    // extra keys + keyboard hint
    const ky = y + h - 214;
    r += rect(x, ky, w, 214, { fill: t.raised });
    const keys = ["esc", "tab", "ctrl", "alt", "↑", "↓", "←", "→"];
    const kw = (w - 16 - 7 * 4) / 8;
    keys.forEach((k, i) => {
      r += rect(x + 8 + i * (kw + 4), ky + 10, kw, 30, { rx: 6, fill: k === "ctrl" ? t.sel : t.hover, stroke: t.line });
      r += text(x + 8 + i * (kw + 4) + kw / 2, ky + 29.5, k, { size: 11, fill: k === "ctrl" ? t.fg : t.fg2, font: MONO, anchor: "middle" });
    });
    for (let row = 0; row < 3; row++) {
      const n = [10, 9, 7][row];
      const bw = (w - 16 - (n - 1) * 5) / n;
      const off = (w - 16 - (n * bw + (n - 1) * 5)) / 2;
      for (let i = 0; i < n; i++) r += rect(x + 8 + off + i * (bw + 5), ky + 54 + row * 46, bw, 38, { rx: 6, fill: t.hl, opacity: 0.7 });
    }
    return r;
  });
  return { W, H, s };
}

// Section headings: one line of display type, the last words in the accent gradient.
function heading(t, plain, accent) {
  const size = 54;
  const est = (plain.length + accent.length) * size * 0.56 + 40;
  const W = Math.ceil(est + 120), H = 100;
  const s = `<defs><linearGradient id="hg" gradientUnits="userSpaceOnUse" x1="${plain.length * size * 0.5}" y1="0" x2="${est}" y2="0"><stop offset="0" stop-color="${t.blue}"/><stop offset="1" stop-color="${t.magenta}"/></linearGradient></defs>
    <text x="10" y="70" font-family="${DISPLAY}" font-size="${size}" font-weight="800" letter-spacing="-1.2" xml:space="preserve"><tspan fill="${t.fg}">${esc(plain)}</tspan><tspan fill="url(#hg)">${esc(accent)}</tspan></text>`;
  return { W, H, s, raw: true, trim: true };
}

function button(t, label, icon, primary) {
  const W = 600, H = 120;
  const tw = label.length * 10.4 + 92;
  const fill = primary ? t.blue : t.raised;
  const fg = primary ? t.onAccent : t.fg;
  const icons = {
    term: `<path d="M-8 -7 L-1 0 L-8 7" fill="none" stroke="${fg}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 7 H9" stroke="${fg}" stroke-width="2.6" stroke-linecap="round"/>`,
    book: `<path d="M-9 -8 h6 a3 3 0 0 1 3 3 v14 a2.5 2.5 0 0 0 -2.5 -2.5 h-6.5 z M9 -8 h-6 a3 3 0 0 0 -3 3 v14 a2.5 2.5 0 0 1 2.5 -2.5 h6.5 z" fill="none" stroke="${fg}" stroke-width="2" stroke-linejoin="round"/>`,
    agent: `<circle r="3" fill="${fg}"/><path d="M-6 -6 a8.5 8.5 0 0 0 0 12 M6 -6 a8.5 8.5 0 0 1 0 12 M-10 -10 a14 14 0 0 0 0 20 M10 -10 a14 14 0 0 1 0 20" fill="none" stroke="${fg}" stroke-width="2" stroke-linecap="round"/>`,
  };
  const s = `<defs><linearGradient id="bedge" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.blue}" stop-opacity=".6"/><stop offset="1" stop-color="${t.magenta}" stop-opacity=".4"/></linearGradient></defs>
    ${rect(0, 0, tw, 56, { rx: 14, fill })}
    ${primary ? "" : rect(0.75, 0.75, tw - 1.5, 54.5, { rx: 13.25, stroke: "url(#bedge)", sw: 1.5 })}
    <g transform="translate(34 28)">${icons[icon]}</g>
    ${text(58, 35.5, esc(label), { size: 18, fill: fg, weight: 600 })}`;
  return { W, H, s, raw: true, trim: true };
}

// ---------- render ----------

const IMAGES = {
  hero,
  terminal,
  chat,
  phones,
  "heading-glance": (t) => heading(t, "Health and action, ", "side by side"),
  "heading-everything": (t) => heading(t, "One panel, ", "every job"),
  "heading-network": (t) => heading(t, "Your network, ", "your rules"),
  "heading-hood": (t) => heading(t, "Under the ", "hood"),
  "heading-answers": (t) => heading(t, "Straight ", "answers"),
  "heading-get": (t) => heading(t, "Get ", "Fleet"),
  "heading-build": (t) => heading(t, "Hack ", "on it"),
  "button-docker": (t) => button(t, "Run it in Docker", "term", true),
  "button-docs": (t) => button(t, "Read the docs", "book", false),
  "button-agent": (t) => button(t, "fleet-agent", "agent", false),
};

const tmp = mkdtempSync(join(tmpdir(), "fleet-readme-"));
const only = process.argv.slice(2);
try {
  for (const [name, make] of Object.entries(IMAGES)) {
    if (only.length && !only.some((o) => name.startsWith(o))) continue;
    for (const [mode, t] of Object.entries(THEMES)) {
      const { W, H, s, trim } = make(t);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs(t, W, H)}${s}</svg>`;
      const base = join(tmp, `${name}-${mode}`);
      writeFileSync(`${base}.svg`, svg);
      execFileSync("rsvg-convert", ["-z", String(SCALE), "-o", `${base}.png`, `${base}.svg`]);
      if (trim) execFileSync("magick", [`${base}.png`, "-trim", "+repage", `${base}.png`]);
      execFileSync("cwebp", ["-quiet", "-q", "92", "-alpha_q", "100", `${base}.png`, "-o", join(OUT, `${name}-${mode}.webp`)]);
      const dims = execFileSync("magick", ["identify", "-format", "%wx%h", `${base}.png`]).toString();
      console.log(`${name}-${mode}.webp  ${dims}`);
    }
  }
} finally {
  if (process.env.KEEP_SVG) console.log("svgs in", tmp, readdirSync(tmp).length);
  else rmSync(tmp, { recursive: true, force: true });
}
