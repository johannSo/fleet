import clsx from "clsx";
import { Box, CircuitBoard, Cloud, HardDrive, Laptop, Monitor, Server } from "lucide-react";
import type { NodeKind } from "@/lib/types";
import { ACCENT } from "./ui";

const ICONS: Record<NodeKind, typeof Monitor> = {
  desktop: Monitor,
  laptop: Laptop,
  server: Server,
  vps: Cloud,
  "raspberry-pi": CircuitBoard,
  nas: HardDrive,
  other: Box,
};

export function NodeIcon({
  kind,
  accent,
  size = 36,
  dim,
}: {
  kind: NodeKind;
  accent: string;
  size?: number;
  dim?: boolean;
}) {
  const Icon = ICONS[kind] ?? Box;
  const a = ACCENT[accent] ?? ACCENT.blue;
  return (
    <div
      className={clsx("relative grid shrink-0 place-items-center rounded-[10px] ring-1 ring-inset transition-opacity", a.text, a.ring, dim && "opacity-50 grayscale")}
      style={{
        width: size,
        height: size,
        background: `radial-gradient(120% 120% at 0% 0%, ${a.hex}33, ${a.hex}0d 60%)`,
      }}
    >
      <Icon size={Math.round(size * 0.47)} strokeWidth={1.8} />
    </div>
  );
}

export function kindLabel(kind: NodeKind): string {
  return kind === "raspberry-pi" ? "Raspberry Pi" : kind === "vps" ? "VPS" : kind === "nas" ? "NAS" : kind[0].toUpperCase() + kind.slice(1);
}
