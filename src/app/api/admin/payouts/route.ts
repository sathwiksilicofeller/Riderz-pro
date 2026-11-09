import { z } from "@/lib/zod";
import { guardMutation, ok, readJson, route } from "@/lib/server/http";
import { requireAdmin } from "@/lib/server/admin-auth";
import { dueVendors, recordPayout } from "@/lib/server/payouts";

export const dynamic = "force-dynamic";

/** Vendors with money due. Bank number is masked. */
export const GET = route(async () => {
  await requireAdmin("payouts");
  return ok({ vendors: await dueVendors() });
});

const schema = z.object({
  vendorId: z.string().min(1).max(80),
  vendorOrderIds: z.array(z.string().min(1).max(80)).min(1).max(200),
  reference: z.string().trim().min(4, "Enter the UTR or bank reference").max(60),
});

/** Record a transfer. Amounts are recomputed from the orders; nothing money-related is read from the body. */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  const me = await requireAdmin("payouts");
  const body = await readJson(req, schema);
  const payout = await recordPayout(me.email, body);
  return ok({ payout }, 201);
});
