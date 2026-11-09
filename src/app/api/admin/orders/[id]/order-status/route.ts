import { z } from "@/lib/zod";
import { guardMutation, ok, readJson, route } from "@/lib/server/http";
import { requireAdmin } from "@/lib/server/admin-auth";
import { adminChangeOrderStatus } from "@/lib/server/orders";

export const dynamic = "force-dynamic";

const schema = z.object({ to: z.enum(["confirmed", "completed", "cancelled"]) });

/** [id] is an order id. Order-level status for the house's own part (placed, confirmed, completed, cancelled). */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  guardMutation(req);
  const me = await requireAdmin("orders");
  const body = await readJson(req, schema);
  await adminChangeOrderStatus(me.email, (await params).id, body.to);
  return ok();
});
