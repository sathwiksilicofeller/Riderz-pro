/**
 * Live tracking: distances, thresholds and the shapes the tracking APIs return.
 * Client-safe (no server imports), shared by the rider app, the order page, dispatch and the API.
 */
import { z } from "@/lib/zod";

export type LatLng = { lat: number; lng: number };

const R = 6_371_000; // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Metres from point `p` to the segment a→b. A flat (equirectangular) projection around `a` is
 * accurate to well under 1% over city distances, which is all the off-route check needs.
 */
export function distanceToSegment(p: LatLng, a: LatLng, b: LatLng): number {
  const k = Math.cos(rad(a.lat));
  const x = (q: LatLng) => rad(q.lng - a.lng) * k * R;
  const y = (q: LatLng) => rad(q.lat - a.lat) * R;
  const [px, py, bx, by] = [x(p), y(p), x(b), y(b)];
  const len2 = bx * bx + by * by;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

/* ------------------------------------------------------------- the rules */

/** How often the rider's phone sends its position, and the least gap the server stores. */
export const PING_EVERY_MS = 10_000;
export const PING_MIN_GAP_MS = 5_000;
/** How often the customer's order page and the dispatch board ask for the latest positions. */
export const TRACK_POLL_MS = 10_000;

/** Geofence: "arriving" and "arrived" are recorded once each per job. */
export const ARRIVING_M = 500;
export const ARRIVED_M = 50;
/** Points less precise than this still move the marker but never trip the geofence or route checks. */
export const GEOFENCE_ACCURACY_M = 100;
/** Points less precise than this are refused (cell-tower guesses are useless for a delivery). */
export const MAX_ACCURACY_M = 2_000;

/**
 * Off route (picked-up jobs only). Compared with the straight line from where the rider was when
 * the trip to the customer began to the delivery point, the rider is "off route" when either
 *   - they are more than max(OFF_ROUTE_MIN_M, OFF_ROUTE_SHARE × trip length) to the side of it, or
 *   - they are OFF_ROUTE_BACKTRACK_M further from the customer than the closest they have been,
 * and it lasts OFF_ROUTE_AFTER_MS. Roads are not straight, so the corridor is wide on purpose:
 * this flags a rider heading the wrong way, not a detour.
 */
export const OFF_ROUTE_MIN_M = 1_500;
export const OFF_ROUTE_SHARE = 0.35;
export const OFF_ROUTE_BACKTRACK_M = 1_500;
export const OFF_ROUTE_AFTER_MS = 3 * 60_000;

/** Fallback ETA when no road route is available: straight-line distance at this speed. */
export const FALLBACK_KMH = 20;

/** Rider positions older than this are shown as "last seen" rather than live. */
export const STALE_AFTER_S = 120;

/** What the rider agrees to before their phone shares its position. */
export const LOCATION_CONSENT_TEXT = "Riderzpro shares your location with the customer only while you are delivering their order.";

/* --------------------------------------------------------------- inputs */

export const latSchema = z.number().finite().min(-90).max(90);
export const lngSchema = z.number().finite().min(-180).max(180);

/** One position from the rider's phone, applied to each of their live jobs listed. */
export const pingSchema = z.object({
  jobIds: z.array(z.string().regex(/^job_[A-Za-z0-9_-]{10,40}$/)).min(1).max(5),
  lat: latSchema,
  lng: lngSchema,
  accuracy: z.number().finite().min(0).max(MAX_ACCURACY_M, "Location is not precise enough"),
  heading: z.number().finite().min(0).max(360).nullable().optional(),
  speed: z.number().finite().min(0).max(100).nullable().optional(), // metres per second, as the browser gives it
  ageMs: z.number().int().min(0).max(120_000).default(0), // how old the fix is
});
export type PingInput = z.infer<typeof pingSchema>;

export const pointSchema = z.object({ lat: latSchema, lng: lngSchema });

/* -------------------------------------------------------------- outputs */

export type TrackingStep = { key: "accepted" | "picked_up" | "arriving" | "arrived" | "delivered"; label: string; at: string | null };

/** One rider delivery on the customer's order page. Never carries the rider's phone or other riders. */
export type CustomerTrackingJob = {
  /** The order part this job delivers: a vendor order id, or "house". */
  key: string;
  status: "offered" | "accepted" | "picked_up" | "delivered";
  riderFirstName: string;
  /** The rider's position, only while they are carrying this parcel (picked up). */
  rider: (LatLng & { accuracy: number; at: string; ageS: number }) | null;
  distanceM: number | null;
  etaMin: number | null;
  etaSource: "road" | "line" | null;
  /** Road (or straight) line from the rider to the delivery point, as [lat, lng] pairs. */
  route: [number, number][] | null;
  arriving: boolean;
  arrived: boolean;
  steps: TrackingStep[];
};

export type CustomerTracking = {
  /** True while any rider job on the order is accepted or picked up: keep polling. */
  live: boolean;
  /** Null when the address could not be placed on the map (status only). */
  deliveryPoint: (LatLng & { approximate: boolean }) | null;
  jobs: CustomerTrackingJob[];
};

/** A live rider's last position for the dispatch board. */
export type DispatchRiderPosition = {
  jobId: string;
  orderNumber: string;
  status: "accepted" | "picked_up";
  riderId: string;
  riderName: string;
  dropName: string;
  point: (LatLng & { accuracy: number; at: string; ageS: number }) | null;
  distanceM: number | null;
  deliveryPoint: LatLng | null;
  offRoute: { since: string; distanceM: number | null; detail: string | null } | null;
  arriving: boolean;
  arrived: boolean;
};

/** Result of "Detect my location" (POST /api/geo/reverse). */
export type DetectedLocation = LatLng & {
  accuracy: number | null;
  address: { line: string; area: string; city: string; state: string; pincode: string } | null;
  /** The Delhi NCR rider city this point is in, when the address names one. */
  serviceCity: string | null;
};

/** "1.2 km", "350 m". */
export const fmtDistance = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10_000 ? 0 : 1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);
/** "just now", "40 s ago", "3 min ago". */
export const fmtAge = (s: number) => (s < 15 ? "just now" : s < 90 ? `${Math.round(s)} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`);
