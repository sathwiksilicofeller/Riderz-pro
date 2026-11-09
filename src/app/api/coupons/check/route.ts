import { z } from "@/lib/zod";
import { clientIp, guardMutation, ok, rateLimit, readJson, route } from "@/lib/server/http";
import { priceCart } from "@/lib/server/orders";
import { quoteCoupon } from "@/lib/server/coupons";
import { placeOrderSchema } from "@/components/cart/orderSchema";
import { codeSchema } from "@/lib/coupons/types";
import { mobileSchema } from "@/lib/vendor/validators";

export const dynamic = "force-dynamic";

const schema = z.object({
  code: codeSchema,
  lines: placeOrderSchema.shape.lines,
  /** Optional: with the mobile, "already used" is checked too. The order checks it again anyway. */
  mobile: mobileSchema.optional().or(z.literal("").transform(() => undefined)),
});

/** Checkout's "Apply": what a coupon takes off this cart, priced on the server. Nothing is reserved. */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  await rateLimit(`coupon-check:${clientIp(req)}`, 30, 10 * 60);
  const body = await readJson(req, schema, 32 * 1024);
  const cart = await priceCart(body.lines);
  return ok({ quote: await quoteCoupon(body.code, { houseItems: cart.houseItems, subtotal: cart.subtotal, shipping: cart.shipping }, body.mobile ?? null) });
});
