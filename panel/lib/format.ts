export function bytes(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const d = v >= 100 || i === 0 ? 0 : digits;
  return `${v.toFixed(d)} ${units[i]}`;
}

export function rate(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${bytes(n)}/s`;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.round((now - ts) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function pct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

/** Strips light markdown (bold, backticks) for plain-text contexts. */
export function plain(md: string): string {
  return md.replace(/\*\*/g, "").replace(/`/g, "");
}

/** Turns an ssh error into a plain-language reason. */
export function explainError(err: string | null | undefined): string {
  const e = (err ?? "").toLowerCase();
  if (e.includes("no route to host")) return "Off, asleep, or not on this network";
  if (e.includes("timed out") || e.includes("timeout")) return "No answer — it may be off or firewalled";
  if (e.includes("connection refused")) return "Machine is up, but ssh isn't accepting connections";
  if (e.includes("permission denied")) return "ssh rejected the key";
  if (e.includes("could not resolve")) return "Hostname doesn't resolve";
  if (e.includes("host key verification failed")) return "Host key changed — check known_hosts";
  if (e.includes("no connection set up")) return "No connection set up: edit the machine and add its host";
  return "Unreachable over ssh";
}
