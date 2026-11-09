import { z } from "@/lib/zod";
import { clientIp, guardMutation, ok, rateLimit, readJson, route } from "@/lib/server/http";
import { CAN_SELL, requireVendor } from "@/lib/server/session";
import { placeStoreOrder } from "@/lib/server/store-sales";
import { housekeeping } from "@/lib/server/housekeeping";
import { startOnlinePayment } from "@/lib/server/payments";
import { mobileSchema } from "@/lib/vendor/validators";
import { CONVERSATION_ID } from "@/lib/server/salesman-log";

export const dynamic = "force-dynamic";

const schema = z.object({
  lines: z
    .array(z.object({ id: z.string().max(80), qty: z.number().int().min(1).max(99) }))
    .min(1)
    .max(60)
    .refine((l) => new Set(l.map((x) => x.id)).size === l.length, "Each product once, with its quantity"),
  customer: z.object({ name: z.string().trim().min(2, "Enter your name").max(80), mobile: mobileSchema }),
  offerId: z.string().regex(/^sof_[A-Za-z0-9_-]{6,40}$/).nullable().optional(),
  pay: z.enum(["screen", "counter"]),
  /** The Salesman AI chat this order came from, if any. */
  conversationId: z.string().regex(CONVERSATION_ID).optional(),
});

/**
 * Places the shop screen's order. pay "screen" → { order, payment } for Razorpay Checkout on the
 * screen (confirmed by /api/payments/razorpay/verify and the webhook, as on the website);
 * pay "counter" → { order } to show at the counter.
 */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  const vendor = await requireVendor(CAN_SELL, { whileLocked: true });
  await rateLimit(`store-checkout:${vendor.id}`, 40, 10 * 60);
  housekeeping();
  const body = await readJson(req, schema, 16 * 1024);
  const order = await placeStoreOrder(vendor, body, clientIp(req));
  const summary = { number: order.number, total: order.total, discount: order.discount };
  if (body.pay === "counter") return ok({ order: summary }, 201);
  return ok({ order: summary, payment: await startOnlinePayment(order) }, 201);
});
