import { z } from "@/lib/zod";
import { guardMutation, ok, rateLimit, readJson, route } from "@/lib/server/http";
import { requireApprovedRider } from "@/lib/server/riders";
import { setLocationConsent } from "@/lib/server/tracking";

export const dynamic = "force-dynamic";

const schema = z.object({ consent: z.boolean() });

/** POST { consent } — the rider agrees to (or stops) sharing their location while delivering. */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  const rider = await requireApprovedRider();
  await rateLimit(`rider-consent:${rider.id}`, 20, 10 * 60);
  const { consent } = await readJson(req, schema);
  await setLocationConsent(rider.id, consent);
  return ok({ consent });
});
