/**
 * Two-factor codes as authenticator apps make them (RFC 6238 TOTP: SHA-1,
 * 6 digits, 30 seconds), so Google Authenticator, 1Password, Aegis and the rest
 * all work. Server-only.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;

export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("Not base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 160 random bits, base32 as the apps expect. */
export function newTotpSecret(): string {
  return base32(randomBytes(20));
}

/** The code for one 30-second step. */
export function hotp(secret: Buffer, step: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits;
  return String(n).padStart(digits, "0");
}

export const currentStep = (now = Date.now()) => Math.floor(now / STEP_MS);

/**
 * Checks a code against the current step and one either side (clock drift).
 * Returns the matching step, or null. Steps at or before `usedStep` are
 * refused, so a code someone watched you type can't be used again.
 */
export function verifyTotp(secret: string, code: string, usedStep = -1, now = Date.now()): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const key = fromBase32(secret);
  const want = Buffer.from(digits);
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= usedStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(key, s)), want)) return s;
  }
  return null;
}

/** The otpauth:// link a QR code carries into the app. */
export function totpUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
