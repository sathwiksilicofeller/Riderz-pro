import { z } from "@/lib/zod";
import { guardMutation, ok, readJson, route } from "@/lib/server/http";
import { vendorChangeStatus } from "@/lib/server/orders";
import { CAN_SELL, requireVendor } from "@/lib/server/session";
import { VENDOR_ORDER_STATUSES } from "@/lib/vendor/types";

export const dynamic = "force-dynamic";

const schema = z.object({
  to: z.enum(VENDOR_ORDER_STATUSES),
  courier: z.string().trim().min(2, "Courier is required").max(60).optional(),
  trackingNumber: z.string().trim().min(3, "Tracking number is required").max(60).optional(),
  reason: z.string().trim().min(3, "A reason is required").max(300).optional(),
});

/** Move this seller's order one step along (accept, pack, ship, deliver, cancel). */
export const POST = route(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  guardMutation(req);
  const vendor = await requireVendor(CAN_SELL);
  const body = await readJson(req, schema);
  const status = await vendorChangeStatus(vendor.id, (await params).id, body);
  return ok({ status });
});
