import { z } from "@/lib/zod";
import { clientIp, guardMutation, ok, readJson, route } from "@/lib/server/http";
import { requireAdmin } from "@/lib/server/admin-auth";
import { adminRefund } from "@/lib/server/payments";

export const dynamic = "force-dynamic";

const schema = z.object({
  /** Whole rupees; omit or null for a full refund of whatever is still refundable. */
  amount: z.number().int("Whole rupees only").min(1, "At least ₹1").max(10_000_000).nullable().optional(),
  reason: z.string().trim().min(3, "Say why you are refunding").max(300),
});

/** [id] is an order id. Admin refunds an online payment, full or partial. */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  guardMutation(req);
  const me = await requireAdmin("refunds");
  const body = await readJson(req, schema, 4 * 1024);
  const refund = await adminRefund(me.email, (await params).id, { amountRupees: body.amount ?? null, reason: body.reason }, clientIp(req));
  return ok({ refund });
});
