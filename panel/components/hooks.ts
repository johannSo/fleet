"use client";

import { useSyncExternalStore } from "react";

function mediaStore(query: string) {
  return {
    subscribe: (cb: () => void) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    get: () => window.matchMedia(query).matches,
  };
}
const mobile = typeof window === "undefined" ? null : mediaStore("(max-width: 767px)");

/** Phone-sized layout (below Tailwind's md breakpoint). */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    mobile?.subscribe ?? (() => () => {}),
    mobile?.get ?? (() => false),
    () => false,
  );
}

let vvSnapshot = { height: 0, top: 0 };
const vvSubscribe = (cb: () => void) => {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  vv.addEventListener("resize", cb);
  vv.addEventListener("scroll", cb);
  return () => {
    vv.removeEventListener("resize", cb);
    vv.removeEventListener("scroll", cb);
  };
};
const vvGet = () => {
  const vv = window.visualViewport;
  const h = Math.round(vv?.height ?? window.innerHeight);
  const t = Math.round(vv?.offsetTop ?? 0);
  if (h !== vvSnapshot.height || t !== vvSnapshot.top) vvSnapshot = { height: h, top: t };
  return vvSnapshot;
};

/** The part of the screen not covered by the on-screen keyboard (iOS doesn't resize the layout for it). */
export function useVisualViewport(): { height: number; top: number } {
  return useSyncExternalStore(vvSubscribe, vvGet, () => vvSnapshot);
}
