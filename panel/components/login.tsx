"use client";

import clsx from "clsx";
import { ArrowRight, Eye, EyeOff, KeyRound, QrCode, ShieldCheck, Terminal, User, type LucideIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { authPost, fieldClass, sixDigits, TotpEnroll } from "./two-factor";
import { Spinner } from "./ui";

type Step = "loading" | "login" | "code" | "setup" | "twofactor";

export function LoginView() {
  const params = useSearchParams();
  const [step, setStep] = useState<Step>("loading");
  const [username, setUsername] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [code, setCode] = useState("");
  const [setupCode, setSetupCode] = useState(params.get("setup") ?? "");
  const [needSetupCode, setNeedSetupCode] = useState(true);
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(params.get("e") === "pair" ? "That pairing code has expired or was already used. Make a new one on the panel." : null);
  const [shake, setShake] = useState(0);
  const [host, setHost] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((me) => {
        setHost(me.hostname);
        if (!me.account) {
          setNeedSetupCode(!me.authed);
          setStep("setup");
        } else if (me.authed) location.replace(safeNext(params.get("next")));
        else setStep("login");
      })
      .catch(() => setStep("login"));
  }, [params]);

  const done = () => location.replace(safeNext(params.get("next")));
  const fail = (msg: string) => {
    setError(msg);
    setShake((s) => s + 1);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    if (step === "setup") {
      if (pw !== pw2) return fail("The passwords don't match");
    }
    setBusy(true);
    try {
      if (step === "setup") {
        await authPost("/api/auth/setup", { username, password: pw, setupCode });
        setStep("twofactor");
      } else {
        await authPost("/api/auth/login", { username, password: pw, code: step === "code" ? code : undefined });
        done();
      }
    } catch (err) {
      const data = (err as { data?: { needCode?: boolean; setup?: boolean } }).data ?? {};
      if (data.setup) setStep("setup");
      if (data.needCode && step === "login") {
        setStep("code");
        setError(null);
        return;
      }
      fail((err as Error).message === "Failed to fetch" ? "Can't reach the panel" : (err as Error).message);
      if (step === "code") setCode("");
      else first.current?.select();
    } finally {
      setBusy(false);
    }
  };

  const title = step === "setup" ? "Create your account" : step === "twofactor" ? "Two-factor sign-in" : "Fleet";
  const ready =
    step === "setup"
      ? !!username.trim() && pw.length >= 10 && !!pw2 && (!needSetupCode || !!setupCode.trim())
      : step === "code"
        ? code.length === 6
        : !!username.trim() && !!pw;

  return (
    <main className="canvas-grid relative flex min-h-dvh items-center justify-center overflow-hidden px-5 pt-[max(24px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))]">
      <div
        className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[680px] -translate-x-1/2 rounded-full opacity-60 blur-3xl"
        style={{ background: "radial-gradient(closest-side, rgba(122,162,247,0.18), rgba(187,154,247,0.08), transparent)" }}
      />
      <div className={clsx("relative w-full animate-fade-up", step === "twofactor" ? "max-w-[460px]" : "max-w-[380px]")}>
        <div className="mb-8 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/icon-192.png" alt="" width={72} height={72} className="mb-5 size-[72px] rounded-[20px] shadow-[0_20px_50px_-15px_rgba(122,162,247,0.45)]" />
          <h1 className="text-[24px] font-semibold tracking-tight text-fg">{title}</h1>
          <p className="mt-1 text-[14px] text-fg-4">
            {step === "setup" ? "The one account that signs in to this panel" : step === "twofactor" ? "Optional, and you can turn it on later" : "Control panel"}
            {host && step !== "twofactor" && (
              <>
                {" "}
                on <span className="font-mono text-fg-3">{host}</span>
              </>
            )}
          </p>
        </div>

        {step === "loading" ? (
          <div className="card grid h-48 place-items-center rounded-2xl">
            <Spinner className="text-fg-4" size={18} />
          </div>
        ) : step === "twofactor" ? (
          <div className="card rounded-2xl p-5">
            <p className="mb-4 text-[13px] leading-relaxed text-fg-3">
              Your account is ready. With two-factor on, signing in also needs a code from your phone, so a leaked password alone isn&apos;t enough.
            </p>
            <TotpEnroll password={pw} onDone={done} onCancel={done} cancelLabel="Skip for now" />
          </div>
        ) : (
          <form onSubmit={submit} className="card space-y-3 rounded-2xl p-5" key={shake} style={shake ? { animation: "shake 0.35s" } : undefined}>
            {step === "code" ? (
              <>
                <label htmlFor="code" className="flex items-center gap-2 text-[13px] font-medium text-fg-2">
                  <ShieldCheck size={14} className="text-blue" />
                  Code from your authenticator app
                </label>
                <input
                  id="code"
                  autoFocus
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(e) => setCode(sixDigits(e.target.value))}
                  placeholder="000000"
                  className={clsx(fieldClass, "h-12 text-center font-mono text-[20px] tracking-[0.4em]", error && "border-red/50")}
                />
              </>
            ) : (
              <>
                {step === "setup" && needSetupCode && (
                  <Labeled id="setup-code" icon={Terminal} label="Setup code">
                    <input
                      id="setup-code"
                      value={setupCode}
                      onChange={(e) => setSetupCode(e.target.value)}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder="printed where the panel started"
                      className={clsx(fieldClass, "font-mono")}
                    />
                  </Labeled>
                )}
                <Labeled id="username" icon={User} label="Username">
                  <input
                    ref={first}
                    id="username"
                    autoFocus
                    autoComplete="username"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className={clsx(fieldClass, error && step === "login" && "border-red/50")}
                  />
                </Labeled>
                <Labeled id="pw" icon={KeyRound} label="Password">
                  <div className={clsx("flex items-center rounded-xl border bg-void/70 pr-1 transition-colors focus-within:border-blue/60", error && step === "login" ? "border-red/50" : "border-line-2")}>
                    <input
                      id="pw"
                      type={show ? "text" : "password"}
                      autoComplete={step === "setup" ? "new-password" : "current-password"}
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      value={pw}
                      onChange={(e) => setPw(e.target.value)}
                      placeholder={step === "setup" ? "at least 10 characters" : undefined}
                      className="h-11 min-w-0 flex-1 bg-transparent px-3.5 text-[15px] text-fg placeholder:text-fg-5 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShow((s) => !s)}
                      aria-label={show ? "Hide password" : "Show password"}
                      className="grid size-9 cursor-pointer place-items-center rounded-lg text-fg-4 hover:text-fg"
                    >
                      {show ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                </Labeled>
                {step === "setup" && (
                  <input
                    type={show ? "text" : "password"}
                    autoComplete="new-password"
                    value={pw2}
                    onChange={(e) => setPw2(e.target.value)}
                    placeholder="Password again"
                    aria-label="Password again"
                    className={fieldClass}
                  />
                )}
              </>
            )}
            {error && <p className="text-[13px] leading-snug text-red">{error}</p>}
            <button
              type="submit"
              disabled={!ready || busy}
              className="mt-1 flex h-12 w-full cursor-pointer items-center justify-center gap-2 rounded-xl bg-blue text-[15px] font-semibold text-[#11131c] transition-[background,opacity] hover:bg-[#8db0ff] active:translate-y-px disabled:cursor-not-allowed disabled:bg-hl disabled:text-fg-4"
            >
              {busy ? <Spinner size={16} /> : <>{step === "setup" ? "Create account" : step === "code" ? "Verify" : "Sign in"} <ArrowRight size={16} /></>}
            </button>
            {step === "code" && (
              <button
                type="button"
                onClick={() => {
                  setStep("login");
                  setCode("");
                  setError(null);
                }}
                className="w-full cursor-pointer text-center text-[12.5px] text-fg-4 hover:text-fg-2"
              >
                Back
              </button>
            )}
          </form>
        )}

        {step === "login" && (
          <div className="mt-5 flex items-start gap-3 rounded-2xl border border-line bg-panel/50 px-4 py-3.5 text-[13px] leading-relaxed text-fg-4">
            <QrCode size={18} className="mt-0.5 shrink-0 text-cyan" />
            <span>
              Faster: on {host ? <span className="font-mono text-fg-3">{host}</span> : "the panel's machine"}, open Fleet and choose{" "}
              <span className="text-fg-2">Add a device</span>, then scan the code with this phone.
            </span>
          </div>
        )}
        {step === "setup" && needSetupCode && (
          <p className="mt-5 px-1 text-[12.5px] leading-relaxed text-fg-4">
            The setup code makes sure only you can create the account. Find it where the panel started: its terminal, <span className="font-mono">npm run service:logs</span> or{" "}
            <span className="font-mono">docker compose logs fleet</span>. On the panel&apos;s own machine, open <span className="font-mono">http://localhost</span> instead and you won&apos;t need it.
          </p>
        )}
      </div>
    </main>
  );
}

function Labeled({ id, icon: Icon, label, children }: { id: string; icon: LucideIcon; label: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-center gap-2 text-[13px] font-medium text-fg-2">
        <Icon size={14} className="text-blue" />
        {label}
      </label>
      {children}
    </div>
  );
}

/** Only follow same-site relative paths after signing in. */
function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}
