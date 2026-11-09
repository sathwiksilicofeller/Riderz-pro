"use client";

import { useCallback, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import type { z } from "@/lib/zod";
import { AlertCircle } from "lucide-react";

/** Shared form pieces for the seller portal: labelled fields whose errors are announced and linked. */

export type FieldErrors = Record<string, string>;

/** Run a zod schema in the browser; returns data or a { path: message } map (first message per path). */
export function validate<S extends z.ZodTypeAny>(
  schema: S,
  value: unknown,
): { ok: true; data: z.infer<S> } | { ok: false; fields: FieldErrors } {
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, data: parsed.data };
  const fields: FieldErrors = {};
  for (const issue of parsed.error.issues) fields[issue.path.join(".") || "_"] ??= issue.message;
  return { ok: false, fields };
}

/** Move focus to the first invalid control inside `root` once React has rendered the errors. */
export function useFocusFirstInvalid(root: { current: HTMLElement | null }) {
  return useCallback(() => {
    requestAnimationFrame(() => {
      const el = root.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      el?.focus();
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }, [root]);
}

export function FieldMessage({ id, error, hint }: { id: string; error?: string; hint?: ReactNode }) {
  if (error) {
    return (
      <p id={`${id}-msg`} role="alert" className="mt-1.5 flex items-start gap-1.5 text-xs leading-snug text-danger">
        <AlertCircle size={13} className="mt-px shrink-0" aria-hidden="true" />
        <span>{error}</span>
      </p>
    );
  }
  if (hint) {
    return (
      <p id={`${id}-msg`} className="mt-1.5 text-xs leading-snug text-dim">
        {hint}
      </p>
    );
  }
  return null;
}

type Common = { id: string; label: string; error?: string; hint?: ReactNode; optional?: boolean };

const describe = (id: string, error?: string, hint?: ReactNode) => (error || hint ? `${id}-msg` : undefined);

export function TextField({
  id, label, error, hint, optional, className = "", ...rest
}: Common & Omit<InputHTMLAttributes<HTMLInputElement>, "id">) {
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
        {optional && <span className="ml-1 font-normal normal-case tracking-normal text-dim">(optional)</span>}
      </label>
      <input
        id={id}
        name={id}
        className="field"
        aria-invalid={error ? true : undefined}
        aria-describedby={describe(id, error, hint)}
        {...rest}
      />
      <FieldMessage id={id} error={error} hint={hint} />
    </div>
  );
}

export function SelectField({
  id, label, error, hint, optional, className = "", children, ...rest
}: Common & Omit<SelectHTMLAttributes<HTMLSelectElement>, "id">) {
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
        {optional && <span className="ml-1 font-normal normal-case tracking-normal text-dim">(optional)</span>}
      </label>
      <select
        id={id}
        name={id}
        className="field"
        aria-invalid={error ? true : undefined}
        aria-describedby={describe(id, error, hint)}
        {...rest}
      >
        {children}
      </select>
      <FieldMessage id={id} error={error} hint={hint} />
    </div>
  );
}

export function TextAreaField({
  id, label, error, hint, optional, className = "", ...rest
}: Common & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id">) {
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
        {optional && <span className="ml-1 font-normal normal-case tracking-normal text-dim">(optional)</span>}
      </label>
      <textarea
        id={id}
        name={id}
        className="field min-h-28 py-3"
        aria-invalid={error ? true : undefined}
        aria-describedby={describe(id, error, hint)}
        {...rest}
      />
      <FieldMessage id={id} error={error} hint={hint} />
    </div>
  );
}

export function CheckField({
  id, error, children, ...rest
}: { id: string; error?: string; children: ReactNode } & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type">) {
  return (
    <div>
      <label htmlFor={id} className="flex cursor-pointer items-start gap-3 text-sm leading-snug text-ash">
        <input
          id={id}
          name={id}
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-msg` : undefined}
          {...rest}
        />
        <span>{children}</span>
      </label>
      <FieldMessage id={id} error={error} />
    </div>
  );
}

/** A banner for form-level messages (not tied to one field). */
export function Notice({
  tone = "info", children, role,
}: { tone?: "info" | "error" | "success" | "warn"; children: ReactNode; role?: "alert" | "status" }) {
  const styles = {
    info: "border-tint/10 bg-tint/5 text-ash",
    error: "border-danger/40 bg-danger/10 text-danger",
    success: "border-accent/30 bg-accent/10 text-chalk",
    warn: "border-gold/40 bg-gold/10 text-chalk",
  }[tone];
  return (
    <div role={role ?? (tone === "error" ? "alert" : "status")} className={`rounded-sm border px-4 py-3 text-sm leading-relaxed ${styles}`}>
      {children}
    </div>
  );
}
