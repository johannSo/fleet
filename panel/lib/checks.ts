/**
 * Built-in commands for Run command. The browser only sends the id; the panel
 * looks the command up here, so nothing typed in the panel ever reaches a shell.
 * Client-safe.
 */
export interface Check {
  id: string;
  label: string;
  /** What runs (bash), shown in the dialog and the tab. */
  cmd: string;
}

const DOCKER = `if docker info >/dev/null 2>&1; then docker ps -a; else sudo docker ps -a; fi`;

export const CHECKS: readonly Check[] = [
  { id: "uptime", label: "uptime", cmd: "uptime" },
  { id: "disk", label: "disk usage", cmd: "df -h -x tmpfs -x devtmpfs -x efivarfs" },
  { id: "memory", label: "memory", cmd: "free -h" },
  { id: "failed", label: "failed units", cmd: "systemctl --failed --no-pager" },
  { id: "errors", label: "errors this boot", cmd: "journalctl -p err -b --no-pager -n 50" },
  { id: "containers", label: "containers", cmd: DOCKER },
  { id: "top", label: "htop", cmd: "if command -v htop >/dev/null 2>&1; then htop; else top; fi" },
];

export const checkById = (id: string) => CHECKS.find((c) => c.id === id);
