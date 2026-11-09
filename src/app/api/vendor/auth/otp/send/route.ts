import { z } from "@/lib/zod";
import { ApiError, guardMutation, ok, rateLimit, readJson, route } from "@/lib/server/http";
import { requireVendor } from "@/lib/server/session";
import { sendOtp } from "@/lib/server/otp";

export const dynamic = "force-dynamic";

/** Send a verification code to the signed-in vendor's own email or mobile. */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  const vendor = await requireVendor();
  const { channel } = await readJson(req, z.object({ channel: z.enum(["email", "mobile"]) }));
  if (channel === "email" ? vendor.emailVerified : vendor.mobileVerified) {
    throw new ApiError(400, "already_verified", "This is already verified.");
  }
  await rateLimit(`otp-send:${vendor.id}:${channel}`, 6, 60 * 60);
  await sendOtp({ vendorId: vendor.id, channel, target: channel === "email" ? vendor.email : vendor.mobile, purpose: "verify" });
  return ok({ sentTo: channel === "email" ? vendor.email : `+91 ${vendor.mobile.slice(0, 2)}XXXXXX${vendor.mobile.slice(-2)}` });
});
