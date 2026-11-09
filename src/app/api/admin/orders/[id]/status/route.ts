import { z } from "@/lib/zod";
import { guardMutation, ok, readJson, route } from "@/lib/server/http";
import { requireAdmin } from "@/lib/server/admin-auth";
import { adminChangePartStatus } from "@/lib/server/orders";

export const dynamic = "force-dynamic";

const schema = z.object({
  to: z.enum(["cancelled", "return_requested", "returned"]),
  reason: z.string().trim().min(3, "A reason is required").max(300),
});

/** [id] is a vendor_order id. Admin cancels a seller's part or records a return. */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  guardMutation(req);
  const me = await requireAdmin("orders");
  const body = await readJson(req, schema);
  await adminChangePartStatus(me.email, (await params).id, body.to, body.reason);
  return ok();
});
