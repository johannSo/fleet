import { createHash } from "node:crypto";

/** Line endings and surrounding blank lines don't count; the rest is hashed byte for byte. */
export function normalizeScript(s: string): string {
  return s.replace(/\r\n?/g, "\n").replace(/^\s*\n|\s+$/g, "");
}

/** What a machine approves (lib/approval.ts): the sha256 of the script exactly as it runs. */
export function scriptHash(script: string): string {
  return createHash("sha256").update(script, "utf8").digest("hex");
}
