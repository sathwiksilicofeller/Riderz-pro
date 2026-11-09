import { z } from "@/lib/zod";
import { sql, sqlOne } from "@/lib/db/client";
import { ApiError, clientIp, guardMutation, ok, rateLimit, readJson, route } from "@/lib/server/http";
import { checkOtp } from "@/lib/server/otp";
import { hashPassword } from "@/lib/server/security";
import { endAllSessions } from "@/lib/server/session";
import { audit } from "@/lib/server/vendors";
import { emailSchema, passwordSchema } from "@/lib/vendor/validators";

export const dynamic = "force-dynamic";

/** Finish a reset: code + new password. Signs the vendor out everywhere. */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  await rateLimit(`reset-confirm:${clientIp(req)}`, 20, 60 * 60);
  const body = await readJson(
    req,
    z.object({ email: emailSchema, code: z.string().regex(/^[0-9]{6}$/, "Enter the 6-digit code"), password: passwordSchema }),
  );
  const row = await sqlOne<{ id: string }>("SELECT id FROM vendors WHERE lower(email) = $1", [body.email]);
  if (!row) throw new ApiError(400, "otp_expired", "That code has expired. Ask for a new one.");
  await checkOtp({ target: body.email, purpose: "reset", code: body.code });
  await sql("UPDATE vendors SET password_hash = $2, updated_at = now() WHERE id = $1", [row.id, await hashPassword(body.password)]);
  await endAllSessions(row.id);
  await audit({ type: "vendor", id: row.id }, "vendor.password_reset", { vendorId: row.id, ip: clientIp(req) });
  return ok({ next: "/vendor/auth" });
});
