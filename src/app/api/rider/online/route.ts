import { guardMutation, ok, readJson, route } from "@/lib/server/http";
import { requireApprovedRider, setOnline } from "@/lib/server/riders";
import { z } from "@/lib/zod";

export const dynamic = "force-dynamic";

const schema = z.object({ online: z.boolean() });

/** POST { online } — whether the rider is taking deliveries now. */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  const rider = await requireApprovedRider();
  const { online } = await readJson(req, schema);
  await setOnline(rider.id, online);
  return ok({ online });
});
