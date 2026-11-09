import { z } from "@/lib/zod";
import { sqlOne } from "@/lib/db/client";
import { ApiError, clientIp, guardMutation, ok, rateLimit, readJson, route } from "@/lib/server/http";
import { verifyPassword } from "@/lib/server/security";
import { CAN_SELL, requireVendor, setStoreScreenLock } from "@/lib/server/session";
import { audit } from "@/lib/server/vendors";

export const dynamic = "force-dynamic";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("lock") }),
  z.object({
    action: z.literal("unlock"),
    password: z.string().min(1, "Enter your password").max(128),
    /** Where to go once unlocked: the dashboard, or straight to adding / managing products. */
    to: z.enum(["dashboard", "add-product", "products", "categories"]).default("dashboard"),
  }),
]);

const UNLOCK_TO = {
  dashboard: "/vendor/dashboard",
  "add-product": "/vendor/dashboard/products/new",
  products: "/vendor/dashboard/products",
  categories: "/vendor/dashboard/store-screen/categories",
} as const;

/**
 * The offline store screen lock (see src/lib/server/session.ts).
 *   lock    the screen opened: this session can only show the store screen
 *   unlock  the seller's password returns this session to the dashboard
 */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  const body = await readJson(req, schema);
  const ip = clientIp(req);

  if (body.action === "lock") {
    const vendor = await requireVendor(CAN_SELL, { whileLocked: true });
    await setStoreScreenLock(true);
    await audit({ type: "vendor", id: vendor.id }, "store_screen.open", { vendorId: vendor.id, ip });
    return ok({ locked: true });
  }

  // Any status may unlock (a store suspended while its screen was open must still get out).
  const vendor = await requireVendor(undefined, { whileLocked: true });
  // Per device first (a customer guessing at the tablet), then per shop (the seller can still unlock elsewhere).
  await rateLimit(`store-screen-unlock-ip:${vendor.id}:${ip}`, 6, 15 * 60);
  await rateLimit(`store-screen-unlock:${vendor.id}`, 20, 15 * 60);
  const row = await sqlOne<{ password_hash: string }>("SELECT password_hash FROM vendors WHERE id = $1", [vendor.id]);
  if (!row || !(await verifyPassword(body.password, row.password_hash))) {
    await audit({ type: "vendor", id: vendor.id }, "store_screen.unlock_failed", { vendorId: vendor.id, ip });
    throw new ApiError(400, "bad_password", "That password is not right.", { password: "That password is not right." });
  }
  await setStoreScreenLock(false);
  await audit({ type: "vendor", id: vendor.id }, "store_screen.close", { vendorId: vendor.id, ip });
  return ok({ locked: false, next: UNLOCK_TO[body.to] });
});
