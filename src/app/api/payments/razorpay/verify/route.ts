import { z } from "@/lib/zod";
import { clientIp, guardMutation, ok, rateLimit, readJson, route } from "@/lib/server/http";
import { verifyCheckoutPayment } from "@/lib/server/payments";

export const dynamic = "force-dynamic";

const schema = z.object({
  razorpay_order_id: z.string().regex(/^order_[A-Za-z0-9]{1,40}$/),
  razorpay_payment_id: z.string().regex(/^pay_[A-Za-z0-9]{1,40}$/),
  razorpay_signature: z.string().regex(/^[0-9a-fA-F]{64}$/),
});

/**
 * Razorpay Checkout's success handler posts its three values here. The HMAC signature is checked
 * (timing-safe) before anything changes; marking the order paid is idempotent with the webhook.
 * → { order: { number, total, paymentStatus, orderStatus, paidAfterCancel } }
 */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  await rateLimit(`rzp-verify:${clientIp(req)}`, 30, 10 * 60);
  const body = await readJson(req, schema, 4 * 1024);
  const order = await verifyCheckoutPayment({
    razorpayOrderId: body.razorpay_order_id,
    razorpayPaymentId: body.razorpay_payment_id,
    razorpaySignature: body.razorpay_signature,
  });
  return ok({ order });
});
