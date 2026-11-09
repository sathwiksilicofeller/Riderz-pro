import { z } from "@/lib/zod";
import { clientIp, guardMutation, ok, rateLimit, readJson, route } from "@/lib/server/http";
import { CAN_SELL, requireVendor } from "@/lib/server/session";
import { sendStoreReceipt } from "@/lib/server/store-receipts";
import { emailSchema } from "@/lib/vendor/validators";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("channel", [
  z.object({ number: z.string().trim().min(4).max(40), channel: z.literal("sms") }),
  z.object({ number: z.string().trim().min(4).max(40), channel: z.literal("email"), email: emailSchema }),
]);

/**
 * The customer asked for a receipt after a shop screen sale: SMS to the mobile given at checkout,
 * or email to the address they typed. Only for this seller's screen order from the last 30 minutes.
 * Answers { sent, status, message } with a message to show on the screen.
 */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  const vendor = await requireVendor(CAN_SELL, { whileLocked: true });
  await rateLimit(`store-receipt:${vendor.id}`, 30, 10 * 60);
  const body = await readJson(req, schema, 2 * 1024);
  await rateLimit(`store-receipt-order:${vendor.id}:${body.number}`, 4, 30 * 60);
  const out = await sendStoreReceipt(vendor, { number: body.number, channel: body.channel, email: body.channel === "email" ? body.email : null }, clientIp(req));
  return ok(out);
});
