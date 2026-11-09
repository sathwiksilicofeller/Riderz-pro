import { z } from "@/lib/zod";
import { clientIp, guardMutation, ok, readJson, route } from "@/lib/server/http";
import { CAN_SELL, requireVendor } from "@/lib/server/session";
import { saveStoreSettings, storeSettings } from "@/lib/server/store-sales";

export const dynamic = "force-dynamic";

const schema = z.object({
  aiEnabled: z.boolean(),
  bargainEnabled: z.boolean(),
  maxDiscountPct: z.number().int().min(0).max(30),
  maxDiscountRupees: z.number().int().min(1).max(1_000_000).nullable(),
  payOnScreen: z.boolean(),
  payAtCounter: z.boolean(),
  screenAddress: z.string().trim().max(120, "Keep the address under 120 characters").nullable().default(null),
  screenHours: z.string().trim().max(80, "Keep the hours under 80 characters").nullable().default(null),
  screenOffer: z.string().trim().max(140, "Keep the offer under 140 characters").nullable().default(null),
});

export const GET = route(async () => {
  const vendor = await requireVendor(CAN_SELL);
  return ok({ settings: await storeSettings(vendor.id) });
});

/** The Offline Store screen's AI salesperson, bargaining limits and ways to pay. */
export const PUT = route(async (req: Request) => {
  guardMutation(req);
  const vendor = await requireVendor(CAN_SELL);
  const body = await readJson(req, schema, 2 * 1024);
  await saveStoreSettings(vendor.id, body, clientIp(req));
  return ok({ settings: await storeSettings(vendor.id) });
});
