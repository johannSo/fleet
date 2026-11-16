import type { Hardware, PkgManager } from "./types";

/** The OS families the Update action knows an update command for (lib/actions.ts). */
export type UpdateOs = "omarchy" | "arch" | "debian" | "fedora" | "opensuse" | "alpine";

export interface UpdateOsInfo {
  id: UpdateOs;
  label: string;
  /** Others in the family, for the picker. */
  examples: string;
  /** What the system update runs, for display. */
  command: string;
}

export const UPDATE_OSES: UpdateOsInfo[] = [
  { id: "omarchy", label: "Omarchy", examples: "", command: "omarchy-update" },
  { id: "arch", label: "Arch Linux", examples: "Manjaro, EndeavourOS, CachyOS", command: "yay / paru / pacman -Syu" },
  { id: "debian", label: "Debian / Ubuntu", examples: "Raspberry Pi OS, Mint, Pop!_OS", command: "apt full-upgrade" },
  { id: "fedora", label: "Fedora / RHEL", examples: "Rocky, Alma, CentOS Stream", command: "dnf upgrade" },
  { id: "opensuse", label: "openSUSE", examples: "Tumbleweed, Leap, SLES", command: "zypper update" },
  { id: "alpine", label: "Alpine", examples: "", command: "apk upgrade" },
];

export const UPDATE_OS_IDS = UPDATE_OSES.map((o) => o.id);

export function updateOsInfo(os: UpdateOs | null | undefined): UpdateOsInfo | undefined {
  return UPDATE_OSES.find((o) => o.id === os);
}

/** os-release IDs (ID and ID_LIKE) per family. */
const IDS: [UpdateOs, RegExp][] = [
  ["arch", /^(arch|archarm|manjaro|manjaro-arm|endeavouros|cachyos|garuda|artix)$/],
  ["debian", /^(debian|ubuntu|raspbian|linuxmint|pop|elementary|kali|zorin|neon|devuan)$/],
  ["fedora", /^(fedora|rhel|centos|rocky|almalinux|ol|amzn|nobara)$/],
  ["opensuse", /^(suse|sles|opensuse.*)$/],
  ["alpine", /^alpine$/],
];

/** Pretty names, for machines indexed before os-release IDs were kept. */
const NAMES: [UpdateOs, RegExp][] = [
  ["omarchy", /\bomarchy\b/i],
  ["arch", /\b(arch|manjaro|endeavour ?os|cachyos|garuda|artix)\b/i],
  ["debian", /\b(debian|ubuntu|raspbian|raspberry pi os|mint|pop!_os|elementary|kali|zorin|armbian|dietpi|devuan)\b/i],
  ["fedora", /\b(fedora|red hat|rhel|centos|rocky|alma ?linux|oracle linux|amazon linux|nobara)\b/i],
  ["opensuse", /\b(suse|sles)\b/i],
  ["alpine", /\balpine\b/i],
];

const BY_PKG: Partial<Record<PkgManager, UpdateOs>> = { omarchy: "omarchy", yay: "arch", paru: "arch", pacman: "arch", apt: "debian", dnf: "fedora" };

/**
 * Which OS family a machine runs, from what the indexer found: Omarchy first
 * (it's Arch, but has its own updater), then the os-release IDs, then the OS
 * name, then the package manager. Null when none of them says.
 */
export function detectUpdateOs(hw: Hardware | null, osName: string): UpdateOs | null {
  if (/^omarchy\b/i.test(hw?.os ?? osName) || hw?.pkg === "omarchy") return "omarchy";
  const ids = [hw?.osId ?? "", ...(hw?.osLike ?? "").split(/\s+/)].map((s) => s.toLowerCase()).filter(Boolean);
  for (const id of ids) for (const [os, re] of IDS) if (re.test(id)) return os;
  const name = hw?.os || osName;
  if (name) for (const [os, re] of NAMES) if (re.test(name)) return os;
  return (hw && BY_PKG[hw.pkg]) ?? null;
}
