"use client";

import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Boxes, Eye, EyeOff, Globe, Lock, ShieldCheck, Store } from "lucide-react";
import { BUSINESS_TYPES, type BusinessType } from "@/lib/vendor/types";
import { ApiFailure, api } from "@/lib/vendor/client";
import { passwordSchema, signInSchema, signUpSchema, emailSchema } from "@/lib/vendor/validators";
import { z } from "@/lib/zod";
import { CheckField, Notice, SelectField, TextField, useFocusFirstInvalid, validate, type FieldErrors } from "./fields";

type Mode = "signin" | "signup" | "reset";

const PERKS = [
  { icon: Globe, title: "Sell online across India", body: "Your approved products are listed on the Riderzpro website with your store name, and customers order from anywhere in India." },
  { icon: Store, title: "Your Offline Store screen", body: "Show your stock on a tablet or TV in your own shop. Customers browse and build their order." },
  { icon: Boxes, title: "Stock that keeps itself right", body: "Products that run out leave the website and the screen by themselves. Update stock and prices any time." },
  { icon: Lock, title: "Locked to your store", body: "Only your password closes the Offline Store screen, so customers never reach your dashboard." },
  { icon: ShieldCheck, title: "Checked sellers only", body: "Every seller passes KYC, and we approve each product before it goes on the website or the screen." },
];

function failureFields(err: unknown): FieldErrors {
  return err instanceof ApiFailure ? err.fields : {};
}
const failureMessage = (err: unknown) => (err instanceof ApiFailure ? err.message : "Something went wrong. Please try again.");

/** Only ever go to a page inside the seller portal. */
const safeNext = (next: string | null) => (next && next.startsWith("/vendor/") && !next.startsWith("//") ? next : null);

export function VendorAuth({ initialMode, next }: { initialMode: "signin" | "signup"; next: string | null }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [notice, setNotice] = useState<string | null>(null);

  function go(m: Mode) {
    setMode(m);
    setNotice(null);
    window.history.replaceState(null, "", m === "signup" ? "?mode=signup" : window.location.pathname + (next ? `?next=${encodeURIComponent(next)}` : ""));
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_minmax(0,28rem)] lg:gap-14">
      <aside className="order-2 lg:order-1 lg:pt-6">
        <p className="eyebrow mb-3">Sell on Riderzpro</p>
        <h1 className="display-3 max-w-md">An order screen for your accessories shop.</h1>
        <p className="mt-4 max-w-md text-sm leading-relaxed text-ash">
          Register, complete a short KYC and list your products once we approve your store. Applications are usually reviewed within 1–2 working days.
        </p>
        <ul className="mt-8 grid gap-4 sm:grid-cols-2">
          {PERKS.map(({ icon: Icon, title, body }) => (
            <li key={title} className="card p-4">
              <Icon size={18} className="text-accent" aria-hidden="true" />
              <p className="mt-3 text-sm font-semibold text-chalk">{title}</p>
              <p className="mt-1 text-xs leading-relaxed text-ash">{body}</p>
            </li>
          ))}
        </ul>
      </aside>

      <section aria-label="Seller account" className="order-1 lg:order-2">
        <div className="card p-5 sm:p-7">
          {mode !== "reset" ? (
            <>
              <div role="tablist" aria-label="Seller account" className="mb-6 grid grid-cols-2 gap-1 rounded-sm bg-tint/5 p-1">
                {(["signin", "signup"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    id={`tab-${m}`}
                    aria-selected={mode === m}
                    aria-controls="auth-panel"
                    onClick={() => go(m)}
                    className={`min-h-10 rounded-sm text-xs font-bold uppercase tracking-[0.12em] transition ${
                      mode === m ? "bg-accent text-on-accent" : "text-ash hover:text-chalk"
                    }`}
                  >
                    {m === "signin" ? "Sign in" : "Create account"}
                  </button>
                ))}
              </div>
              {notice && (
                <div className="mb-5">
                  <Notice tone="success">{notice}</Notice>
                </div>
              )}
              <div id="auth-panel" role="tabpanel" aria-labelledby={`tab-${mode}`}>
                {mode === "signin" ? (
                  <SignIn next={safeNext(next)} onForgot={() => go("reset")} />
                ) : (
                  <SignUp onSwitch={() => go("signin")} />
                )}
              </div>
            </>
          ) : (
            <ResetPassword
              onBack={() => go("signin")}
              onDone={() => {
                setMode("signin");
                setNotice("Password updated. Sign in with your new password.");
              }}
            />
          )}
        </div>
      </section>
    </div>
  );
}

/* ---------------------------------------------------------------- sign in */

function SignIn({ next, onForgot }: { next: string | null; onForgot: () => void }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const focusInvalid = useFocusFirstInvalid(form);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget)) as { identifier: string; password: string };
    setFormError(null);
    const checked = validate(signInSchema, data);
    if (!checked.ok) {
      setErrors({
        identifier: checked.fields.identifier ? "Enter your email or mobile number" : "",
        password: checked.fields.password ? "Enter your password" : "",
      });
      focusInvalid();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const res = await api<{ next: string }>("/api/vendor/auth/signin", { body: checked.data });
      router.replace(next ?? res.next);
      router.refresh();
    } catch (err) {
      setErrors(failureFields(err));
      setFormError(failureMessage(err));
      setBusy(false);
    }
  }

  return (
    <form ref={form} onSubmit={submit} noValidate className="space-y-4">
      {formError && <Notice tone="error">{formError}</Notice>}
      <TextField
        id="identifier"
        label="Email or mobile"
        autoComplete="username"
        inputMode="email"
        placeholder="you@business.com or 9876543210"
        error={errors.identifier || undefined}
      />
      <div>
        <div className="flex items-baseline justify-between">
          <label htmlFor="password" className="label">Password</label>
          <button type="button" onClick={onForgot} className="mb-1.5 text-xs font-semibold text-accent hover:underline">
            Forgot password?
          </button>
        </div>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            className="field pr-11"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? "password-msg" : undefined}
          />
          <ShowToggle shown={show} onToggle={() => setShow((s) => !s)} />
        </div>
        {errors.password && (
          <p id="password-msg" role="alert" className="mt-1.5 text-xs text-danger">
            {errors.password}
          </p>
        )}
      </div>
      <button type="submit" disabled={busy} className="btn btn-primary btn-block">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

function ShowToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={shown ? "Hide password" : "Show password"}
      aria-pressed={shown}
      className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center text-dim hover:text-chalk"
    >
      {shown ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
    </button>
  );
}

/* ---------------------------------------------------------------- sign up */

export function passwordStrength(p: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  if (!p) return { score: 0, label: "Use 10 or more characters with letters and numbers." };
  let score = 0;
  if (p.length >= 10) score++;
  if (/[A-Za-z]/.test(p) && /[0-9]/.test(p)) score++;
  if (p.length >= 14) score++;
  if (/[^A-Za-z0-9]/.test(p) || (/[a-z]/.test(p) && /[A-Z]/.test(p))) score++;
  const labels = ["Too short", "Weak", "Fair", "Good", "Strong"];
  return { score: score as 0 | 1 | 2 | 3 | 4, label: labels[score] };
}

export function StrengthMeter({ password }: { password: string }) {
  const { score, label } = passwordStrength(password);
  const fill = score <= 1 ? "bg-danger" : score === 2 ? "bg-gold" : "bg-chalk";
  return (
    <div className="mt-2" aria-live="polite">
      <div className="flex gap-1" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={`h-1 flex-1 rounded-full ${i <= score ? fill : "bg-tint/10"}`} />
        ))}
      </div>
      <p className="mt-1 text-xs text-dim">{label}</p>
    </div>
  );
}

function SignUp({ onSwitch }: { onSwitch: () => void }) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const focusInvalid = useFocusFirstInvalid(form);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);
  const [password, setPassword] = useState("");

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload = {
      fullName: String(fd.get("fullName") ?? ""),
      businessType: String(fd.get("businessType") ?? ""),
      email: String(fd.get("email") ?? ""),
      mobile: String(fd.get("mobile") ?? ""),
      password,
      acceptTerms: fd.get("acceptTerms") === "on" ? true : false,
    };
    setFormError(null);
    const checked = validate(signUpSchema, payload);
    if (!checked.ok) {
      setErrors(checked.fields);
      focusInvalid();
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const res = await api<{ next: string }>("/api/vendor/auth/signup", { body: payload });
      router.replace(res.next);
      router.refresh();
    } catch (err) {
      setErrors(failureFields(err));
      setFormError(failureMessage(err));
      setBusy(false);
      focusInvalid();
    }
  }

  return (
    <form ref={form} onSubmit={submit} noValidate className="space-y-4">
      {formError && (
        <Notice tone="error">
          {formError}{" "}
          {formError.toLowerCase().includes("already exists") && (
            <button type="button" onClick={onSwitch} className="font-semibold underline">
              Sign in
            </button>
          )}
        </Notice>
      )}
      <TextField id="fullName" label="Full name" autoComplete="name" error={errors.fullName} />
      <SelectField id="businessType" label="Business type" defaultValue="" error={errors.businessType && "Choose your business type"}>
        <option value="" disabled>
          Select…
        </option>
        {BUSINESS_TYPES.map((b: BusinessType) => (
          <option key={b} value={b}>
            {b}
          </option>
        ))}
      </SelectField>
      <TextField id="email" label="Email" type="email" autoComplete="email" error={errors.email} />
      <div>
        <label htmlFor="mobile" className="label">Mobile</label>
        <div className="flex">
          <span className="flex min-h-12 items-center rounded-l-sm border border-r-0 border-tint/10 bg-tint/5 px-3 text-sm text-ash" aria-hidden="true">
            +91
          </span>
          <input
            id="mobile"
            name="mobile"
            type="tel"
            inputMode="numeric"
            autoComplete="tel-national"
            maxLength={14}
            placeholder="98765 43210"
            className="field rounded-l-none"
            aria-invalid={errors.mobile ? true : undefined}
            aria-describedby={errors.mobile ? "mobile-msg" : undefined}
          />
        </div>
        {errors.mobile && (
          <p id="mobile-msg" role="alert" className="mt-1.5 text-xs text-danger">
            {errors.mobile}
          </p>
        )}
      </div>
      <div>
        <label htmlFor="password" className="label">Password</label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="field pr-11"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? "password-msg" : "password-strength"}
          />
          <ShowToggle shown={show} onToggle={() => setShow((s) => !s)} />
        </div>
        {errors.password && (
          <p id="password-msg" role="alert" className="mt-1.5 text-xs text-danger">
            {errors.password}
          </p>
        )}
        <div id="password-strength">
          <StrengthMeter password={password} />
        </div>
      </div>
      <CheckField id="acceptTerms" error={errors.acceptTerms}>
        I agree to the{" "}
        <Link href="/legal/terms" target="_blank" className="font-semibold text-accent underline">
          seller terms
        </Link>{" "}
        and confirm I&apos;m authorised to register this business.
      </CheckField>
      <button type="submit" disabled={busy} className="btn btn-primary btn-block">
        {busy ? "Creating account…" : "Create seller account"}
      </button>
      <p className="text-center text-xs text-dim">You&apos;ll add tax, store and bank details in the next steps.</p>
    </form>
  );
}

/* --------------------------------------------------------- reset password */

function ResetPassword({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const form = useRef<HTMLFormElement>(null);
  const focusInvalid = useFocusFirstInvalid(form);
  const [phase, setPhase] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<{ tone: "info" | "error" | "success"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const raw = String(new FormData(e.currentTarget).get("email") ?? "");
    const checked = validate(z.object({ email: emailSchema }), { email: raw });
    if (!checked.ok) {
      setErrors(checked.fields);
      focusInvalid();
      return;
    }
    setErrors({});
    setMessage(null);
    setBusy(true);
    try {
      const res = await api<{ available: boolean; message: string }>("/api/vendor/auth/reset/request", { body: checked.data });
      setEmail(checked.data.email);
      if (res.available) setPhase("code");
      setMessage({ tone: res.available ? "success" : "info", text: res.message });
    } catch (err) {
      setErrors(failureFields(err));
      setMessage({ tone: "error", text: failureMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const payload = { email, code: String(fd.get("code") ?? "").trim(), password: String(fd.get("password") ?? "") };
    const checked = validate(
      z.object({ email: emailSchema, code: z.string().regex(/^[0-9]{6}$/, "Enter the 6-digit code"), password: passwordSchema }),
      payload,
    );
    if (!checked.ok) {
      setErrors(checked.fields);
      focusInvalid();
      return;
    }
    setErrors({});
    setMessage(null);
    setBusy(true);
    try {
      await api("/api/vendor/auth/reset/confirm", { body: payload });
      onDone();
    } catch (err) {
      setErrors(failureFields(err));
      setMessage({ tone: "error", text: failureMessage(err) });
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={onBack} className="mb-5 inline-flex items-center gap-1.5 text-xs font-semibold text-ash hover:text-chalk">
        <ArrowLeft size={14} aria-hidden="true" /> Back to sign in
      </button>
      <h2 className="display-3 mb-1">Reset password</h2>
      <p className="mb-5 text-sm text-ash">
        {phase === "email" ? "Enter your account email and we'll send a 6-digit code." : `Enter the code sent to ${email} and choose a new password.`}
      </p>
      {message && (
        <div className="mb-4">
          <Notice tone={message.tone}>{message.text}</Notice>
        </div>
      )}
      {phase === "email" ? (
        <form ref={form} onSubmit={requestCode} noValidate className="space-y-4">
          <TextField id="email" label="Email" type="email" autoComplete="email" error={errors.email} />
          <button type="submit" disabled={busy} className="btn btn-primary btn-block">
            {busy ? "Sending…" : "Send code"}
          </button>
        </form>
      ) : (
        <form ref={form} onSubmit={confirm} noValidate className="space-y-4">
          <TextField
            id="code"
            label="6-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            error={errors.code}
          />
          <TextField id="password" label="New password" type="password" autoComplete="new-password" error={errors.password} hint="At least 10 characters, with letters and numbers." />
          <button type="submit" disabled={busy} className="btn btn-primary btn-block">
            {busy ? "Updating…" : "Update password"}
          </button>
          <button type="button" onClick={() => { setPhase("email"); setMessage(null); }} className="block w-full text-center text-xs font-semibold text-ash hover:text-chalk">
            Use a different email or resend code
          </button>
        </form>
      )}
    </div>
  );
}
