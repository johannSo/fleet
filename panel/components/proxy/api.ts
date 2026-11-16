"use client";

/**
 * Talking to the AI proxy from the browser. Everything goes through the panel
 * (/api/proxy/*), which holds the management key and logs changes.
 *  - mgmt.*: CLIProxyAPI's v8 Management API, unchanged (/api/proxy/m/<path>)
 *  - proxyApi.*: the panel's own additions (status, service, usage history, tests)
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PROXY_CHANGED_EVENT } from "../terminal-provider";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown, raw?: boolean): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body !== undefined) {
    if (body instanceof FormData) init.body = body;
    else if (typeof body === "string" && raw) {
      init.body = body;
      (init.headers as Record<string, string>)["content-type"] = "application/yaml";
    } else {
      init.body = JSON.stringify(body);
      (init.headers as Record<string, string>)["content-type"] = "application/json";
    }
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* plain text */
  }
  if (!res.ok) {
    const d = data as { error?: unknown; message?: unknown } | null;
    const msg = (d && typeof d === "object" && (d.error ?? d.message)) || (typeof data === "string" && data) || `HTTP ${res.status}`;
    throw new ApiError(res.status, typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data as T;
}

const q = (params?: Record<string, string | number | boolean | undefined | null>) => {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== "" && v !== false) sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
};

/** CLIProxyAPI's Management API (v8), through the panel. */
export const mgmt = {
  get: <T>(path: string, params?: Record<string, string | number | boolean | undefined | null>) => call<T>("GET", `/api/proxy/m${path}${q(params)}`),
  put: <T>(path: string, body: unknown) => call<T>("PUT", `/api/proxy/m${path}`, body),
  patch: <T>(path: string, body: unknown) => call<T>("PATCH", `/api/proxy/m${path}`, body),
  post: <T>(path: string, body?: unknown, params?: Record<string, string | number | boolean | undefined | null>) => call<T>("POST", `/api/proxy/m${path}${q(params)}`, body ?? {}),
  del: <T>(path: string, params?: Record<string, string | number | boolean | undefined | null>, body?: unknown) => call<T>("DELETE", `/api/proxy/m${path}${q(params)}`, body),
  putYaml: (text: string) => call<unknown>("PUT", "/api/proxy/m/config.yaml", text, true),
  getText: async (path: string) => {
    const res = await fetch(`/api/proxy/m${path}`);
    if (!res.ok) throw new ApiError(res.status, (await res.text()) || `HTTP ${res.status}`);
    return res.text();
  },
};

export const proxyApi = {
  get: <T>(path: string, params?: Record<string, string | number | boolean | undefined | null>) => call<T>("GET", `/api/proxy${path}${q(params)}`),
  post: <T>(path: string, body: unknown) => call<T>("POST", `/api/proxy${path}`, body),
  text: async (path: string) => {
    const res = await fetch(`/api/proxy${path}`);
    return res.text();
  },
};

/**
 * Loads something and keeps it fresh: again whenever the proxy reports a change,
 * every `every` ms while the tab is visible, and on demand via reload().
 */
export function useProxyData<T>(load: () => Promise<T>, deps: unknown[] = [], every = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  });
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const n = ++seq.current;
    try {
      const d = await loader.current();
      if (n !== seq.current) return;
      setData(d);
      setError(null);
    } catch (err) {
      if (n !== seq.current) return;
      setError((err as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- (re)load when inputs change
    setLoading(true);
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    const onChange = () => void reload();
    window.addEventListener(PROXY_CHANGED_EVENT, onChange);
    let t: ReturnType<typeof setInterval> | null = null;
    if (every > 0) t = setInterval(() => document.visibilityState === "visible" && void reload(), every);
    return () => {
      window.removeEventListener(PROXY_CHANGED_EVENT, onChange);
      if (t) clearInterval(t);
    };
  }, [reload, every]);

  return { data, error, loading, reload, setData };
}

/* ---------------- formatting ---------------- */

export function tokens(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  return `${(n / 1_000_000_000).toFixed(2)}B`;
}

export function ms(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "–";
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`;
}

/** "in 4m", "in 2h" for a future time. */
export function until(ts: number | string | null | undefined, now = Date.now()): string {
  const t = typeof ts === "string" ? Date.parse(ts) : ts;
  if (!t || !Number.isFinite(t)) return "";
  const s = Math.round((t - now) / 1000);
  if (s <= 0) return "now";
  if (s < 60) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)}m`;
  if (s < 86_400) return `in ${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `in ${Math.round(s / 86_400)}d`;
}

const subscribeNow = (cb: () => void) => {
  const t = setInterval(cb, 15_000);
  return () => clearInterval(t);
};
/** The time, refreshed every 15 seconds (for "in 4m" labels); 0 during SSR. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribeNow,
    () => Math.floor(Date.now() / 15_000) * 15_000,
    () => 0,
  );
}
