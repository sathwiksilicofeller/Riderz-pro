import "server-only";

import { NextResponse } from "next/server";
import type { z } from "@/lib/zod";
import { DatabaseNotConfigured, sql } from "@/lib/db/client";

/**
 * Conventions every JSON API route follows.
 *
 *   success  200/201  { ok: true, ...data }
 *   failure  4xx/5xx  { ok: false, error: "<code>", message: "<for people>", fields?: { path: message } }
 *
 * Mutating routes call `guardMutation` first: it rejects cross-site requests
 * (Origin must be this site) — the session cookie is SameSite=Lax, and this
 * closes the remaining gaps. Never return raw error text from a catch block.
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const ok = (data: Record<string, unknown> = {}, status = 200) =>
  NextResponse.json({ ok: true, ...data }, { status, headers: { "Cache-Control": "no-store" } });

export function fail(err: unknown) {
  if (err instanceof ApiError) {
    return NextResponse.json(
      { ok: false, error: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) },
      { status: err.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (err instanceof DatabaseNotConfigured) {
    return NextResponse.json(
      { ok: false, error: "unavailable", message: "The seller portal is not available right now." },
      { status: 503 },
    );
  }
  console.error("[api]", err instanceof Error ? `${err.name}: ${err.message}` : err);
  return NextResponse.json(
    { ok: false, error: "server_error", message: "Something went wrong. Please try again." },
    { status: 500 },
  );
}

/** Wraps a handler so every thrown error becomes a safe JSON response. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      return fail(err);
    }
  };
}

/** Same-origin check for POST/PUT/PATCH/DELETE. */
export function guardMutation(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || !host) throw new ApiError(403, "forbidden", "Request blocked.");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ApiError(403, "forbidden", "Request blocked.");
  }
  if (originHost !== host) throw new ApiError(403, "forbidden", "Request blocked.");
}

/** Refuses a request whose declared size is over `limit` bytes, before reading it. */
export function assertBodySize(req: Request, limit: number) {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw new ApiError(413, "too_large", "That request is too large.");
}

/** Parse a JSON body (max `limit` bytes) against a zod schema; field errors come back as `fields`. */
export async function readJson<S extends z.ZodTypeAny>(req: Request, schema: S, limit = 64 * 1024): Promise<z.infer<S>> {
  assertBodySize(req, limit);
  const text = await req.text();
  if (Buffer.byteLength(text) > limit) throw new ApiError(413, "too_large", "That request is too large.");
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "bad_json", "The request could not be read.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "_";
      fields[key] ??= issue.message;
    }
    throw new ApiError(400, "invalid", "Some details need fixing.", fields);
  }
  return parsed.data;
}

/**
 * The visitor's IP for rate limits. Headers the host sets come first (Vercel: x-vercel-forwarded-for;
 * nginx and most proxies: x-real-ip). Failing those, the LAST x-forwarded-for entry: the one the
 * nearest proxy added. The first entry is whatever the visitor sent, so it can't be trusted.
 */
export function clientIp(req: Request): string {
  const h = req.headers;
  const first = (v: string | null) => (v ?? "").split(",")[0].trim();
  const last = (v: string | null) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean).pop() ?? "";
  return first(h.get("x-vercel-forwarded-for")) || first(h.get("x-real-ip")) || last(h.get("x-forwarded-for")) || "unknown";
}

/**
 * Fixed-window rate limit stored in the database (works across server instances).
 * Throws 429 when `key` has been used more than `max` times in `windowSeconds`.
 */
export async function rateLimit(key: string, max: number, windowSeconds: number): Promise<void> {
  const rows = await sql<{ count: number }>(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2) THEN now() ELSE rate_limits.window_start END
     RETURNING count`,
    [key, windowSeconds],
  );
  if ((rows[0]?.count ?? 0) > max) {
    throw new ApiError(429, "rate_limited", "Too many attempts. Please wait a few minutes and try again.");
  }
}

