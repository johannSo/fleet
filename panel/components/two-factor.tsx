"use client";

import { Check, Copy, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { Button, Spinner, useCopy } from "./ui";

/** POSTs JSON to the auth API; throws the server's error message. */
export async function authPost<T = { ok: true }>(path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `HTTP ${res.status}`), { data });
  return data as T;
}

/** Keeps only digits, at most six, for a one-time code field. */
export const sixDigits = (v: string) => v.replace(/\D/g, "").slice(0, 6);

export const fieldClass =
  "h-11 w-full rounded-xl border border-line-2 bg-void/70 px-3.5 text-[15px] text-fg placeholder:text-fg-5 transition-colors focus:border-blue/60 focus:outline-none";

/**
 * Turns on two-factor sign-in: shows a QR code for an authenticator app
 * (Google Authenticator, 1Password, Aegis…) and asks for one code from it.
 * `password` is the current password; without it, the user types it here.
 */
export function TotpEnroll({ password, askPassword, onDone, onCancel, cancelLabel = "Cancel" }: { password?: string; askPassword?: boolean; onDone: () => void; onCancel: () => void; cancelLabel?: string }) {
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { copied, copy } = useCopy();

  useEffect(() => {
    authPost<{ secret: string; uri: string; qr: string }>("/api/auth/totp/start")
      .then(setSetup)
      .catch((e: Error) => setError(e.message));
  }, []);

  const enable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await authPost("/api/auth/totp/enable", { code, password: password ?? pw });
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  if (!setup) {
    return <div className="grid h-48 place-items-center">{error ? <p className="text-[13px] text-red">{error}</p> : <Spinner className="text-fg-4" size={18} />}</div>;
  }
  const grouped = setup.secret.match(/.{1,4}/g)!.join(" ");
  return (
    <form onSubmit={enable} className="space-y-4">
      <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        <div
          role="img"
          aria-label="QR code for your authenticator app"
          className="size-[168px] shrink-0 overflow-hidden rounded-xl bg-white [&_svg]:h-full [&_svg]:w-full"
          dangerouslySetInnerHTML={{ __html: setup.qr }}
        />
        <div className="min-w-0 text-[12.5px] leading-relaxed text-fg-3">
          <p>Scan this with an authenticator app (Google Authenticator, 1Password, Aegis, Bitwarden…). Can&apos;t scan? Enter this key instead:</p>
          <button
            type="button"
            onClick={() => copy(setup.secret)}
            className="mt-2 flex max-w-full cursor-pointer items-center gap-2 rounded-md bg-void/60 px-2.5 py-1.5 text-left font-mono text-[12px] break-all text-fg-2 ring-1 ring-line-2 hover:ring-line-3"
            title="Copy the key"
          >
            {grouped}
            {copied === setup.secret ? <Check size={13} className="shrink-0 text-green" /> : <Copy size={13} className="shrink-0 text-fg-4" />}
          </button>
        </div>
      </div>
      {askPassword && (
        <input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Current password" aria-label="Current password" className={fieldClass} />
      )}
      <input
        data-autofocus
        inputMode="numeric"
        autoComplete="one-time-code"
        value={code}
        onChange={(e) => setCode(sixDigits(e.target.value))}
        placeholder="6-digit code from the app"
        aria-label="Code from the app"
        className={`${fieldClass} font-mono tracking-[0.3em] placeholder:font-sans placeholder:tracking-normal`}
      />
      {error && <p className="text-[13px] leading-snug text-red">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button type="submit" variant="primary" icon={ShieldCheck} loading={busy} disabled={code.length !== 6 || (askPassword && !pw)}>
          Turn on
        </Button>
      </div>
    </form>
  );
}
