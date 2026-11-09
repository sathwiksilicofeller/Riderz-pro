import { z } from "@/lib/zod";
import { clientIp, guardMutation, ok, rateLimit, readJson, route } from "@/lib/server/http";
import { reverseGeocode, serviceCityFor } from "@/lib/server/tracking-geo";
import { latSchema, lngSchema, type DetectedLocation } from "@/lib/tracking/geo";

export const dynamic = "force-dynamic";

const schema = z.object({ lat: latSchema, lng: lngSchema, accuracy: z.number().finite().min(0).max(100_000).nullable().optional() });

/**
 * POST { lat, lng, accuracy? } → { location: { lat, lng, accuracy, address | null, serviceCity } }
 * "Detect my location": the address at the shopper's GPS point (OpenStreetMap Nominatim, from the
 * server). POST so the coordinates stay out of URLs and logs; same-origin only; nothing is stored.
 * `address` is null when the lookup fails; the point is still returned so checkout can keep it.
 */
export const POST = route(async (req: Request) => {
  guardMutation(req);
  await rateLimit(`geo-reverse:${clientIp(req)}`, 10, 10 * 60);
  const input = await readJson(req, schema, 1024);
  const point = { lat: Number(input.lat.toFixed(6)), lng: Number(input.lng.toFixed(6)) };
  const address = await reverseGeocode(point);
  const location: DetectedLocation = { ...point, accuracy: input.accuracy ?? null, address, serviceCity: serviceCityFor(address) };
  return ok({ location });
});
