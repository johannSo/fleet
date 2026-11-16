"use client";

import clsx from "clsx";
import { ArrowRight, Eye, EyeOff, KeyRound, QrCode } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Spinner } from "./ui";

export function LoginView() {
  const params = useSearchParams();
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get("e") === "pair" ? "That pairing code has expired or was already used. Make a new one on the panel." : null);
  const [shake, setShake] = useState(0);
  const [host, setHost] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((me) => {
        if (me.authed) location.replace(safeNext(params.get("next")));
        else setHost(me.hostname);
      })
      .catch(() => {});
  }, [params]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      if (res.ok) {
        location.replace(safeNext(params.get("next")));
        return;
      }
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Couldn't sign in");
      setShake((s) => s + 1);
      input.current?.select();
    } catch {
      setError("Can't reach the panel");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="canvas-grid relative flex min-h-dvh items-center justify-center overflow-hidden px-5 pt-[max(24px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
      <div
        className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[680px] -translate-x-1/2 rounded-full opacity-60 blur-3xl"
        style={{ background: "radial-gradient(closest-side, rgba(122,162,247,0.18), rgba(187,154,247,0.08), transparent)" }}
      />
      <div className="relative w-full max-w-[380px] animate-fade-up">
        <div className="mb-8 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/icon-192.png" alt="" width={72} height={72} className="mb-5 size-[72px] rounded-[20px] shadow-[0_20px_50px_-15px_rgba(122,162,247,0.45)]" />
          <h1 className="text-[24px] font-semibold tracking-tight text-fg">Fleet</h1>
          <p className="mt-1 text-[14px] text-fg-4">
            Control panel{host && (
              <>
                {" "}
                on <span className="font-mono text-fg-3">{host}</span>
              </>
            )}
          </p>
        </div>

        <form onSubmit={submit} className="card rounded-2xl p-5" key={shake} style={shake ? { animation: "shake 0.35s" } : undefined}>
          <label htmlFor="pw" className="mb-2 flex items-center gap-2 text-[13px] font-medium text-fg-2">
            <KeyRound size={14} className="text-blue" />
            Password
          </label>
          <div
            className={clsx(
              "flex h-12 items-center rounded-xl border bg-void/70 pr-1 transition-colors focus-within:border-blue/60",
              error ? "border-red/50" : "border-line-2",
            )}
          >
            <input
              ref={input}
              id="pw"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              placeholder="word-word-word-00"
              className="h-full min-w-0 flex-1 bg-transparent px-4 font-mono text-[16px] text-fg placeholder:text-fg-5"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? "Hide password" : "Show password"}
              className="grid size-10 cursor-pointer place-items-center rounded-lg text-fg-4 hover:text-fg"
            >
              {show ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
          {error && <p className="mt-2.5 text-[13px] leading-snug text-red">{error}</p>}
          <button
            type="submit"
            disabled={!pw.trim() || busy}
            className="mt-4 flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue text-[15px] font-semibold text-[#11131c] transition-[background,opacity] hover:bg-[#8db0ff] active:translate-y-px disabled:cursor-not-allowed disabled:bg-hl disabled:text-fg-4"
          >
            {busy ? <Spinner size={16} /> : <>Sign in <ArrowRight size={16} /></>}
          </button>
        </form>

        <div className="mt-5 flex items-start gap-3 rounded-2xl border border-line bg-panel/50 px-4 py-3.5 text-[13px] leading-relaxed text-fg-4">
          <QrCode size={18} className="mt-0.5 shrink-0 text-cyan" />
          <span>
            Faster: on {host ? <span className="font-mono text-fg-3">{host}</span> : "the panel's machine"}, open Fleet and choose{" "}
            <span className="text-fg-2">Add a device</span>, then scan the code with this phone.
          </span>
        </div>
      </div>
    </main>
  );
}

/** Only follow same-site relative paths after signing in. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
