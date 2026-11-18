"use client";

import { KeyRound, ShieldCheck, ShieldOff, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { Me } from "./pwa";
import { authPost, fieldClass, sixDigits, TotpEnroll } from "./two-factor";
import { Badge, Button, Modal, Spinner } from "./ui";

type Panel = null | "password" | "totp-on" | "totp-off";

/**
 * The panel's account: change the password, turn two-factor sign-in on or off.
 * Each needs the current password, except on the panel's own machine.
 */
export function AccountDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [next2, setNext2] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = () =>
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then(setMe)
      .catch(() => {});

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      setPanel(null);
      reload();
    }, 0);
    return () => clearTimeout(t);
  }, [open]);

  const show = (p: Panel) => {
    setPanel(p);
    setCurrent("");
    setNext("");
    setNext2("");
    setCode("");
    setError(null);
  };

  const local = !!me?.local;

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== next2) return setError("The new passwords don't match");
    setBusy(true);
    setError(null);
    try {
      await authPost("/api/auth/password", { password: current, next });
      toast.success("Password changed", { description: "Every other device was signed out." });
      show(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const turnOff = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authPost("/api/auth/totp/disable", { password: current, code });
      toast("Two-factor sign-in is off");
      show(null);
      reload();
    } catch (err) {
      setError((err as Error).message);
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const currentField = !local && (
    <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" aria-label="Current password" className={fieldClass} data-autofocus />
  );

  return (
    <Modal open={open} onClose={onClose} icon={UserRound} tone="blue" width={520} title="Account" description="The one account that signs in to this panel from other devices.">
      {!me ? (
        <div className="grid h-40 place-items-center">
          <Spinner className="text-fg-4" size={18} />
        </div>
      ) : !me.account ? (
        <div className="space-y-3 text-[13px] leading-relaxed text-fg-3">
          <p>There&apos;s no account yet, so no other device can sign in (paired devices still work).</p>
          <Button variant="primary" onClick={() => router.push("/login")}>
            Create the account
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl border border-line-2 bg-void/30 px-4 py-3">
            <UserRound size={16} className="text-fg-4" />
            <span className="font-mono text-[14px] text-fg">{me.username}</span>
            {me.totp ? (
              <Badge tone="green" icon={ShieldCheck}>
                two-factor on
              </Badge>
            ) : (
              <Badge tone="yellow" icon={ShieldOff}>
                two-factor off
              </Badge>
            )}
          </div>

          {panel === null && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" icon={KeyRound} onClick={() => show("password")}>
                Change password
              </Button>
              {me.totp ? (
                <Button variant="secondary" icon={ShieldOff} onClick={() => show("totp-off")}>
                  Turn off two-factor
                </Button>
              ) : (
                <Button variant="primary" icon={ShieldCheck} onClick={() => show("totp-on")}>
                  Turn on two-factor
                </Button>
              )}
            </div>
          )}

          {panel === "password" && (
            <form onSubmit={changePassword} className="space-y-2.5">
              {currentField}
              <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (at least 10 characters)" aria-label="New password" className={fieldClass} {...(local ? { "data-autofocus": true } : {})} />
              <input type="password" autoComplete="new-password" value={next2} onChange={(e) => setNext2(e.target.value)} placeholder="New password again" aria-label="New password again" className={fieldClass} />
              <p className="text-[12px] text-fg-4">Every other signed-in device gets signed out.</p>
              {error && <p className="text-[13px] text-red">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => show(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant="primary" loading={busy} disabled={next.length < 10 || !next2 || (!local && !current)}>
                  Change password
                </Button>
              </div>
            </form>
          )}

          {panel === "totp-on" && (
            <TotpEnroll
              askPassword={!local}
              onDone={() => {
                toast.success("Two-factor sign-in is on", { description: "Signing in now also asks for a code from the app." });
                show(null);
                reload();
              }}
              onCancel={() => show(null)}
            />
          )}

          {panel === "totp-off" && (
            <form onSubmit={turnOff} className="space-y-2.5">
              <p className="text-[12.5px] leading-relaxed text-fg-3">After this, the password alone signs in.</p>
              {currentField}
              {!local && (
                <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(sixDigits(e.target.value))} placeholder="6-digit code from the app" aria-label="Code from the app" className={`${fieldClass} font-mono tracking-[0.3em] placeholder:font-sans placeholder:tracking-normal`} />
              )}
              {error && <p className="text-[13px] text-red">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => show(null)}>
                  Cancel
                </Button>
                <Button type="submit" variant="danger" loading={busy} disabled={!local && (!current || code.length !== 6)}>
                  Turn off
                </Button>
              </div>
            </form>
          )}

          <p className="text-[11.5px] leading-relaxed text-fg-4">
            Locked out? On the panel&apos;s own machine, <span className="font-mono">http://localhost</span> never asks to sign in, so you can change the password or turn off two-factor there.
          </p>
        </div>
      )}
    </Modal>
  );
}
