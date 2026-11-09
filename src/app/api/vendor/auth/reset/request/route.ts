import { z } from "@/lib/zod";
import { sqlOne } from "@/lib/db/client";
import { clientIp, guardMutation, ok, rateLimit, readJson, route } from "@/lib/server/http";
import { otpDeliveryAvailable, sendOtp } from "@/lib/server/otp";
import { emailSchema } from "@/lib/vendor/validators";

export const dynamic = "force-dynamic";

/**
 * Start a password reset by email. Always answers the same way, whether or
 * not the account exists, so it cannot be used to discover sellers.
 */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  await rateLimit(`reset-ip:${clientIp(req)}`, 10, 60 * 60);
  const { email } = await readJson(req, z.object({ email: emailSchema }));
  if (!otpDeliveryAvailable("email")) {
    return ok({ available: false, message: "Password reset by email is not switched on yet. Contact seller support." });
  }
  const row = await sqlOne<{ id: string }>("SELECT id FROM vendors WHERE lower(email) = $1 AND status <> 'rejected'", [email]);
  if (row) {
    await rateLimit(`reset-id:${email}`, 5, 60 * 60);
    await sendOtp({ vendorId: row.id, channel: "email", target: email, purpose: "reset" }).catch((err) => {
      // A resend inside 30 s is not worth telling an anonymous caller about.
      if ((err as { code?: string }).code !== "otp_wait") throw err;
    });
  }
  return ok({ available: true, message: "If that email has a seller account, a code is on its way." });
});
