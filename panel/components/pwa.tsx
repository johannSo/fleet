"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// Chrome fires this once, possibly before React mounts, so catch it at module load.
let deferred: BeforeInstallPromptEvent | null = null;
const listeners = new Set<() => void>();
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    listeners.forEach((l) => l());
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    listeners.forEach((l) => l());
  });
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useInstallPrompt() {
  const available = useSyncExternalStore(
    subscribe,
    () => deferred !== null,
    () => false,
  );
  const [ios, setIos] = useState(false);
  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
    const t = setTimeout(() => setIos(/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone), 0);
    return () => clearTimeout(t);
  }, []);
  const prompt = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    deferred = null;
    listeners.forEach((l) => l());
  }, []);
  return { canInstall: available, iosHint: ios, prompt };
}

export interface Me {
  authed: boolean;
  local: boolean;
  device: { name: string } | null;
  /** Whether the panel's account exists yet (it's created on first start). */
  account: boolean;
  username: string | null;
  totp: boolean | null;
  hostname: string;
  tls: { port: number } | null;
  port: number;
}

export function useMe(): Me | null {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then(setMe)
      .catch(() => {});
  }, []);
  return me;
}
