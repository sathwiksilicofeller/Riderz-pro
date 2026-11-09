import "server-only";

import { randomInt } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "@/lib/zod";
import { DatabaseNotConfigured, sql, sqlOne, transaction, type Query } from "@/lib/db/client";
import {
  LIVE_JOB,
  RIDER_CONSENT_VERSION,
  RIDER_PAY_MAX,
  serviceCity,
  type ApplyInput,
  type JobStatus,
  type RiderEarnings,
  type RiderJobView,
  type RiderSelf,
  type RiderStatus,
  type VehicleType,
} from "@/lib/rider/types";
import type { VendorOnboarding, VendorOrderStatus } from "@/lib/vendor/types";
import { ApiError } from "./http";
import { smsRiderOffer } from "./messaging";
import { checkOtp } from "./otp";
import { riderMovePart } from "./orders";
import { newId, newToken, sha256 } from "./security";
import { closeTracking } from "./tracking";
import { audit, notifyVendor } from "./vendors";

/**
 * RIDERS — Riderzpro's own delivery riders in Delhi NCR.
 *
 *   sign-in     a one-time code to the rider's mobile (cookie `rzp_rider`; the session is tied to the
 *               mobile, so someone can sign in before they have applied)
 *   apply       name, city, vehicle and registration number, three declarations; no identity
 *               documents are uploaded or stored — the team checks the licence, RC and insurance in
 *               person before approving
 *   review      admin approves, asks for changes, rejects, suspends or reinstates (audited)
 *   dispatch    admin offers a packed seller shipment to an approved rider with a pay amount
 *   delivery    rider accepts (or declines) → picks up (shipment becomes "shipped") → enters the
 *               customer's 4-digit code (shipment becomes "delivered"); 5 wrong codes lock the job
 *               until the admin resets it
 *   earnings    each delivered job's pay; the admin records a payout with a bank/UPI reference
 *   location    while a job is accepted or picked up, with the rider's consent (src/lib/server/tracking.ts);
 *               closing a job deletes its trail (closeTracking, in the same transaction)
 *
 * Status moves are checked here, inside transactions with row locks. Identity always comes from the
 * session. A rider sees the customer's phone and full address only after accepting a job.
 */

export const RIDER_COOKIE = "rzp_rider";
const SESSION_DAYS = 30;
const CODE_TRIES = 5;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

type RiderRow = {
  id: string;
  mobile: string;
  name: string;
  city: string;
  vehicle_type: VehicleType;
  vehicle_number: string | null;
  status: RiderStatus;
  review_note: string | null;
  online: boolean;
  location_consent_at: Date | null;
};
const toSelf = (r: RiderRow): RiderSelf => ({
  id: r.id,
  mobile: r.mobile,
  name: r.name,
  city: r.city,
  vehicleType: r.vehicle_type,
  vehicleNumber: r.vehicle_number,
  status: r.status,
  reviewNote: r.review_note,
  online: r.online,
  locationConsent: r.location_consent_at !== null,
});

/* --------------------------------------------------------------- sessions */

async function token(): Promise<string | null> {
  const t = (await cookies()).get(RIDER_COOKIE)?.value;
  return t && t.length <= 100 ? t : null;
}

export async function signInRider(mobile: string, code: string, userAgent: string | null): Promise<void> {
  await checkOtp({ target: mobile, purpose: "rider_login", code });
  const t = newToken();
  await sql(
    `INSERT INTO rider_sessions (token_hash, mobile, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(days => $3), $4)`,
    [sha256(t), mobile, SESSION_DAYS, (userAgent ?? "").slice(0, 200)],
  );
  (await cookies()).set(RIDER_COOKIE, t, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function signOutRider(): Promise<void> {
  const jar = await cookies();
  const t = jar.get(RIDER_COOKIE)?.value;
  if (t) await sql("DELETE FROM rider_sessions WHERE token_hash = $1", [sha256(t)]);
  jar.delete(RIDER_COOKIE);
}

/** The signed-in mobile and, once they have applied, their rider record. */
export async function riderSession(): Promise<{ mobile: string; rider: RiderSelf | null } | null> {
  const t = await token();
  if (!t) return null;
  try {
    const s = await sqlOne<{ mobile: string }>("SELECT mobile FROM rider_sessions WHERE token_hash = $1 AND expires_at > now()", [sha256(t)]);
    if (!s) return null;
    const r = await sqlOne<RiderRow>("SELECT * FROM riders WHERE mobile = $1", [s.mobile]);
    return { mobile: s.mobile, rider: r ? toSelf(r) : null };
  } catch (err) {
    if (err instanceof DatabaseNotConfigured) return null;
    throw err;
  }
}

export async function requireRiderSession() {
  const s = await riderSession();
  if (!s) throw new ApiError(401, "signed_out", "Please sign in to the rider app.");
  return s;
}

/** An approved (not suspended) rider, for job and online routes. */
export async function requireApprovedRider(): Promise<RiderSelf> {
  const { rider } = await requireRiderSession();
  if (!rider) throw new ApiError(403, "not_applied", "Apply to ride with Riderzpro first.");
  if (rider.status !== "approved") throw new ApiError(403, "not_approved", "Your rider account isn't active. Check your application status.");
  return rider;
}

/** For rider pages: the session, or a redirect to /rider (sign-in). */
export async function riderPage() {
  const s = await riderSession();
  if (!s) redirect("/rider");
  return s;
}

/* ----------------------------------------------------------- application */

const EDITABLE: RiderStatus[] = ["applied", "changes_requested"];

export async function applyRider(mobile: string, input: ApplyInput): Promise<RiderSelf> {
  if (input.vehicleNumber) {
    const taken = await sqlOne("SELECT 1 FROM riders WHERE vehicle_number = $1 AND mobile <> $2 AND status <> 'rejected'", [input.vehicleNumber, mobile]);
    if (taken) throw new ApiError(409, "vehicle_taken", "That vehicle is already registered to another rider.", { vehicleNumber: "Already registered to another rider" });
  }
  const row = await transaction(async (q) => {
    const existing = (await q<RiderRow>("SELECT * FROM riders WHERE mobile = $1 FOR UPDATE", [mobile]))[0];
    if (existing && !EDITABLE.includes(existing.status)) {
      throw new ApiError(409, "locked", existing.status === "approved" ? "You're already approved." : "This application can't be changed. Contact rider support.");
    }
    const values = [input.name, input.city, input.vehicleType, input.vehicleNumber, RIDER_CONSENT_VERSION];
    const rows = existing
      ? await q<RiderRow>(
          `UPDATE riders SET name=$2, city=$3, vehicle_type=$4, vehicle_number=$5, consent_version=$6, consented_at=now(),
                  status='applied', updated_at=now() WHERE id=$1 RETURNING *`,
          [existing.id, ...values],
        )
      : await q<RiderRow>(
          `INSERT INTO riders (id, mobile, name, city, vehicle_type, vehicle_number, consent_version, consented_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now()) RETURNING *`,
          [newId("rdr"), mobile, ...values],
        );
    await audit({ type: "system", id: `rider:${rows[0].id}` }, existing ? "rider.resubmit" : "rider.apply", { detail: { city: input.city, vehicle: input.vehicleType } }, q);
    return rows[0];
  });
  return toSelf(row);
}

export async function setOnline(riderId: string, online: boolean): Promise<void> {
  await sql("UPDATE riders SET online = $2, online_at = CASE WHEN $2 THEN now() ELSE online_at END, updated_at = now() WHERE id = $1", [riderId, online]);
}

/* ------------------------------------------------------------ rider jobs */

type JobRow = {
  id: string;
  order_id: string;
  vendor_order_id: string | null;
  rider_id: string;
  status: JobStatus;
  pickup_name: string;
  pickup_address: string;
  pickup_phone: string | null;
  drop_name: string;
  drop_address: string;
  drop_phone: string;
  city: string;
  earning: number;
  delivery_code: string;
  code_attempts: number;
  note: string | null;
  offered_at: Date;
  accepted_at: Date | null;
  picked_up_at: Date | null;
  delivered_at: Date | null;
  number: string;
  pincode: string;
};

const JOB_COLS = `j.*, o.number, o.pincode`;

async function itemsFor(rows: JobRow[]) {
  if (rows.length === 0) return new Map<string, { title: string; qty: number }[]>();
  const items = await sql<{ job_id: string; title: string; qty: number }>(
    `SELECT j.id AS job_id, i.title, i.qty FROM rider_jobs j
       JOIN order_items i ON i.order_id = j.order_id AND i.vendor_order_id IS NOT DISTINCT FROM j.vendor_order_id
      WHERE j.id = ANY($1) ORDER BY i.id`,
    [rows.map((r) => r.id)],
  );
  const map = new Map<string, { title: string; qty: number }[]>();
  for (const i of items) map.set(i.job_id, [...(map.get(i.job_id) ?? []), { title: i.title, qty: i.qty }]);
  return map;
}

const toJobView = (r: JobRow, items: { title: string; qty: number }[]): RiderJobView => {
  const shared = r.status === "accepted" || r.status === "picked_up";
  return {
    id: r.id,
    status: r.status,
    orderNumber: r.number,
    pickupName: r.pickup_name,
    pickupAddress: r.pickup_address,
    pickupPhone: shared ? r.pickup_phone : null,
    dropName: shared || r.status === "delivered" ? r.drop_name : r.drop_name.split(/\s+/)[0],
    dropArea: `${r.city} ${r.pincode}`,
    dropAddress: shared ? r.drop_address : null,
    dropPhone: shared ? r.drop_phone : null,
    city: r.city,
    earning: r.earning,
    items,
    note: r.note,
    offeredAt: iso(r.offered_at)!,
    acceptedAt: iso(r.accepted_at),
    pickedUpAt: iso(r.picked_up_at),
    deliveredAt: iso(r.delivered_at),
    codeLocked: r.code_attempts >= CODE_TRIES,
  };
};

/** The rider's live jobs and their last 30 finished ones. */
export async function riderJobs(riderId: string): Promise<{ live: RiderJobView[]; done: RiderJobView[] }> {
  const rows = await sql<JobRow>(
    `SELECT ${JOB_COLS} FROM rider_jobs j JOIN orders o ON o.id = j.order_id
      WHERE j.rider_id = $1 AND (j.status = ANY($2) OR j.updated_at > now() - interval '30 days')
      ORDER BY j.created_at DESC LIMIT 60`,
    [riderId, LIVE_JOB],
  );
  const items = await itemsFor(rows);
  const views = rows.map((r) => toJobView(r, items.get(r.id) ?? []));
  return { live: views.filter((v) => LIVE_JOB.includes(v.status)), done: views.filter((v) => !LIVE_JOB.includes(v.status)).slice(0, 30) };
}

async function event(q: Query, jobId: string, actor: string, from: JobStatus | null, to: JobStatus, note: string | null = null) {
  await q("INSERT INTO rider_job_events (job_id, actor, from_status, to_status, note) VALUES ($1,$2,$3,$4,$5)", [jobId, actor, from, to, note]);
}

/** "RZR-QSFS4A": the job's last six letters and digits (ids also contain - and _). */
const shortRef = (jobId: string) => `RZR-${jobId.replace(/[^A-Za-z0-9]/g, "").slice(-6).toUpperCase()}`;

export const riderActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("accept") }),
  z.object({ action: z.literal("decline"), reason: z.string().trim().max(200).optional() }),
  z.object({ action: z.literal("pickup") }),
  z.object({ action: z.literal("deliver"), code: z.string().trim().regex(/^\d{4}$/, "Enter the customer's 4-digit code") }),
]);

/** A rider moves their own job. Returns the new status. */
export async function riderAct(rider: RiderSelf, jobId: string, input: z.infer<typeof riderActionSchema>): Promise<JobStatus> {
  const who = `rider:${rider.id}`;
  // A wrong code must count even though the move is refused: it is counted inside the transaction,
  // under the job's row lock, so parallel guesses can't all slip in before the count rises.
  let wrongCode = false;
  let attempts = 0;
  const result = await transaction(async (q) => {
    const j = (await q<JobRow>(`SELECT ${JOB_COLS} FROM rider_jobs j JOIN orders o ON o.id = j.order_id WHERE j.id = $1 AND j.rider_id = $2 FOR UPDATE OF j`, [jobId, rider.id]))[0];
    if (!j) throw new ApiError(404, "not_found", "Job not found.");
    const bad = () => new ApiError(409, "bad_transition", `This job is ${j.status.replace("_", " ")}.`);

    switch (input.action) {
      case "accept":
        if (j.status !== "offered") throw bad();
        await q("UPDATE rider_jobs SET status='accepted', accepted_at=now(), updated_at=now() WHERE id=$1", [j.id]);
        await event(q, j.id, who, j.status, "accepted");
        return "accepted" as const;
      case "decline":
        if (j.status !== "offered" && j.status !== "accepted") throw bad();
        await q("UPDATE rider_jobs SET status='declined', cancel_reason=$2, closed_at=now(), updated_at=now() WHERE id=$1", [j.id, input.reason || null]);
        await event(q, j.id, who, j.status, "declined", input.reason || null);
        await closeTracking(q, j.id, "declined");
        return "declined" as const;
      case "pickup":
        if (j.status !== "accepted") throw bad();
        if (j.vendor_order_id) await riderMovePart(q, j.vendor_order_id, "shipped", shortRef(j.id), rider.id);
        await q("UPDATE rider_jobs SET status='picked_up', picked_up_at=now(), updated_at=now() WHERE id=$1", [j.id]);
        await event(q, j.id, who, j.status, "picked_up");
        return "picked_up" as const;
      case "deliver": {
        if (j.status !== "picked_up") throw bad();
        if (j.code_attempts >= CODE_TRIES) {
          throw new ApiError(423, "code_locked", "Too many wrong codes. Call rider support to finish this delivery.");
        }
        if (input.code !== j.delivery_code) {
          wrongCode = true;
          const c = await q<{ code_attempts: number }>(
            "UPDATE rider_jobs SET code_attempts = code_attempts + 1, updated_at = now() WHERE id = $1 RETURNING code_attempts",
            [j.id],
          );
          attempts = c[0]?.code_attempts ?? CODE_TRIES;
          return null;
        }
        if (j.vendor_order_id) await riderMovePart(q, j.vendor_order_id, "delivered", shortRef(j.id), rider.id);
        await q("UPDATE rider_jobs SET status='delivered', delivered_at=now(), closed_at=now(), updated_at=now() WHERE id=$1", [j.id]);
        await event(q, j.id, who, j.status, "delivered");
        await closeTracking(q, j.id, "delivered");
        return "delivered" as const;
      }
    }
  });
  if (wrongCode) {
    const left = CODE_TRIES - attempts;
    throw new ApiError(
      400,
      "code_wrong",
      left > 0 ? `That code is not right. ${left} ${left === 1 ? "try" : "tries"} left.` : "Too many wrong codes. Call rider support to finish this delivery.",
      { code: "Wrong code" },
    );
  }
  return result!;
}

export async function riderEarnings(riderId: string): Promise<RiderEarnings> {
  const r = await sqlOne<{ unpaid: number; unpaid_jobs: number; paid: number; today: number }>(
    `SELECT coalesce(sum(earning) FILTER (WHERE payout_id IS NULL), 0)::int AS unpaid,
            count(*) FILTER (WHERE payout_id IS NULL)::int AS unpaid_jobs,
            coalesce(sum(earning) FILTER (WHERE payout_id IS NOT NULL), 0)::int AS paid,
            coalesce(sum(earning) FILTER (WHERE delivered_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'), 0)::int AS today
       FROM rider_jobs WHERE rider_id = $1 AND status = 'delivered'`,
    [riderId],
  );
  const payouts = await sql<{ id: string; amount: number; jobs: number; reference: string; created_at: Date }>(
    "SELECT id, amount, jobs, reference, created_at FROM rider_payouts WHERE rider_id = $1 ORDER BY created_at DESC LIMIT 20",
    [riderId],
  );
  return {
    unpaid: r?.unpaid ?? 0,
    unpaidJobs: r?.unpaid_jobs ?? 0,
    paid: r?.paid ?? 0,
    today: r?.today ?? 0,
    payouts: payouts.map((p) => ({ id: p.id, amount: p.amount, jobs: p.jobs, reference: p.reference, createdAt: iso(p.created_at)! })),
  };
}

/* =============================================================== admin */

export type AdminRider = RiderSelf & { createdAt: string; reviewedBy: string | null; reviewedAt: string | null; liveJobs: number; delivered: number; unpaid: number };

export async function listRidersAdmin(filter: RiderStatus | "all"): Promise<{ items: AdminRider[]; counts: Record<string, number> }> {
  const rows = await sql<RiderRow & { created_at: Date; reviewed_by: string | null; reviewed_at: Date | null; live_jobs: number; delivered: number; unpaid: number }>(
    `SELECT r.*,
            (SELECT count(*)::int FROM rider_jobs j WHERE j.rider_id = r.id AND j.status IN ('offered','accepted','picked_up')) AS live_jobs,
            (SELECT count(*)::int FROM rider_jobs j WHERE j.rider_id = r.id AND j.status = 'delivered') AS delivered,
            (SELECT coalesce(sum(earning),0)::int FROM rider_jobs j WHERE j.rider_id = r.id AND j.status = 'delivered' AND j.payout_id IS NULL) AS unpaid
       FROM riders r WHERE ($1 = 'all' OR r.status = $1)
      ORDER BY (r.status = 'applied') DESC, r.online DESC, r.created_at ASC LIMIT 300`,
    [filter],
  );
  const c = await sql<{ status: string; n: string }>("SELECT status, count(*) AS n FROM riders GROUP BY status");
  const counts: Record<string, number> = { applied: 0, approved: 0, changes_requested: 0, rejected: 0, suspended: 0 };
  for (const x of c) counts[x.status] = Number(x.n);
  return {
    counts,
    items: rows.map((r) => ({
      ...toSelf(r),
      createdAt: iso(r.created_at)!,
      reviewedBy: r.reviewed_by,
      reviewedAt: iso(r.reviewed_at),
      liveJobs: r.live_jobs,
      delivered: r.delivered,
      unpaid: r.unpaid,
    })),
  };
}

export const riderDecisionSchema = z.object({
  action: z.enum(["approve", "request_changes", "reject", "suspend", "reinstate"]),
  note: z.string().trim().max(500).optional(),
  checked: z.boolean().optional(),
});

const DECISIONS: Record<z.infer<typeof riderDecisionSchema>["action"], { from: RiderStatus[]; to: RiderStatus }> = {
  approve: { from: ["applied"], to: "approved" },
  request_changes: { from: ["applied"], to: "changes_requested" },
  reject: { from: ["applied", "changes_requested"], to: "rejected" },
  suspend: { from: ["approved"], to: "suspended" },
  reinstate: { from: ["suspended"], to: "approved" },
};

export async function riderDecision(riderId: string, input: z.infer<typeof riderDecisionSchema>, actor: string, ip: string): Promise<void> {
  const rule = DECISIONS[input.action];
  if (input.action === "approve" && !input.checked) {
    throw new ApiError(400, "invalid", "Confirm you checked the rider's licence, RC and insurance in person.", { checked: "Confirm the in-person check" });
  }
  if ((input.action === "request_changes" || input.action === "reject" || input.action === "suspend") && !input.note) {
    throw new ApiError(400, "invalid", "Write a note for the rider.", { note: "A note is required" });
  }
  await transaction(async (q) => {
    const r = (await q<{ status: RiderStatus; vehicle_type: VehicleType }>("SELECT status, vehicle_type FROM riders WHERE id = $1 FOR UPDATE", [riderId]))[0];
    if (!r) throw new ApiError(404, "not_found", "Rider not found.");
    if (!rule.from.includes(r.status)) throw new ApiError(409, "stale", `This rider is ${r.status.replace("_", " ")} now. The page has been refreshed.`);
    if (input.action === "suspend") {
      const onRoad = (await q("SELECT 1 FROM rider_jobs WHERE rider_id = $1 AND status = 'picked_up'", [riderId]))[0];
      if (onRoad) throw new ApiError(409, "on_road", "This rider is carrying a parcel. Let them finish it first.");
      const closed = await q<{ id: string }>(
        "UPDATE rider_jobs SET status='cancelled', cancel_reason='Rider suspended', closed_at=now(), updated_at=now() WHERE rider_id=$1 AND status IN ('offered','accepted') RETURNING id",
        [riderId],
      );
      for (const c of closed) await closeTracking(q, c.id, "cancelled");
    }
    await q(
      `UPDATE riders SET status=$2, review_note=$3, reviewed_by=$4, reviewed_at=now(), online = CASE WHEN $2 = 'approved' THEN online ELSE false END, updated_at=now() WHERE id=$1`,
      [riderId, rule.to, input.note || null, actor],
    );
    await audit({ type: "admin", id: actor }, `rider.${input.action}`, { ip, detail: { riderId, from: r.status, note: input.note || null } }, q);
  });
}

/* ------------------------------------------------------------- dispatch */

export type DispatchCandidate = {
  vendorOrderId: string;
  orderNumber: string;
  storeName: string;
  partStatus: VendorOrderStatus;
  pickupCity: string;
  dropCity: string;
  dropPincode: string;
  inArea: boolean;
  itemCount: number;
  subtotal: number;
  createdAt: string;
};

/** Seller shipments that a rider could deliver: accepted or packed, no live job, both ends in Delhi NCR. */
export async function dispatchCandidates(): Promise<DispatchCandidate[]> {
  const rows = await sql<{
    id: string;
    status: VendorOrderStatus;
    subtotal: number;
    created_at: Date;
    number: string;
    city: string;
    pincode: string;
    store_name: string | null;
    onboarding: VendorOnboarding;
    item_count: number;
  }>(
    `SELECT vo.id, vo.status, vo.subtotal, vo.created_at, o.number, o.city, o.pincode, v.store_name, v.onboarding,
            (SELECT coalesce(sum(qty),0)::int FROM order_items i WHERE i.vendor_order_id = vo.id) AS item_count
       FROM vendor_orders vo JOIN orders o ON o.id = vo.order_id JOIN vendors v ON v.id = vo.vendor_id
      WHERE vo.status IN ('accepted','packed') AND o.status <> 'cancelled'
        AND NOT EXISTS (SELECT 1 FROM rider_jobs j WHERE j.vendor_order_id = vo.id AND j.status IN ('offered','accepted','picked_up','delivered'))
      ORDER BY vo.created_at ASC LIMIT 200`,
  );
  return rows.map((r) => {
    const pickupCity = r.onboarding?.shipping?.pickup.city ?? "";
    return {
      vendorOrderId: r.id,
      orderNumber: r.number,
      storeName: r.store_name ?? "Seller",
      partStatus: r.status,
      pickupCity,
      dropCity: r.city,
      dropPincode: r.pincode,
      inArea: serviceCity(pickupCity) !== null && serviceCity(r.city) !== null,
      itemCount: r.item_count,
      subtotal: r.subtotal,
      createdAt: iso(r.created_at)!,
    };
  });
}

export const createJobSchema = z.object({
  vendorOrderId: z.string().regex(/^vor_[A-Za-z0-9_-]{10,40}$/),
  riderId: z.string().regex(/^rdr_[A-Za-z0-9_-]{10,40}$/),
  earning: z.number().int().min(0).max(RIDER_PAY_MAX),
  note: z.string().trim().max(300).optional(),
});

export async function createJob(input: z.infer<typeof createJobSchema>, actor: string, ip: string): Promise<{ id: string }> {
  const id = newId("job");
  await transaction(async (q) => {
    const p = (
      await q<{ status: VendorOrderStatus; order_id: string; vendor_id: string; store_name: string | null; onboarding: VendorOnboarding; mobile: string; number: string; customer_name: string; customer_phone: string; address: string; city: string; state: string; pincode: string; order_status: string }>(
        `SELECT vo.status, vo.order_id, vo.vendor_id, v.store_name, v.onboarding, v.mobile, o.number, o.customer_name, o.customer_phone,
                o.address, o.city, o.state, o.pincode, o.status AS order_status
           FROM vendor_orders vo JOIN orders o ON o.id = vo.order_id JOIN vendors v ON v.id = vo.vendor_id
          WHERE vo.id = $1 FOR UPDATE OF vo`,
        [input.vendorOrderId],
      )
    )[0];
    if (!p) throw new ApiError(404, "not_found", "Order not found.");
    if (p.order_status === "cancelled" || (p.status !== "accepted" && p.status !== "packed")) {
      throw new ApiError(409, "not_dispatchable", "Only accepted or packed shipments can be given to a rider.");
    }
    const pickup = p.onboarding?.shipping?.pickup;
    const city = serviceCity(p.city);
    if (!pickup || !serviceCity(pickup.city) || !city) {
      throw new ApiError(409, "out_of_area", "Both the seller and the customer must be in Delhi NCR for a rider delivery.");
    }
    const r = (await q<{ status: RiderStatus; name: string }>("SELECT status, name FROM riders WHERE id = $1 FOR UPDATE", [input.riderId]))[0];
    if (!r || r.status !== "approved") throw new ApiError(409, "rider_unavailable", "That rider isn't approved.");

    const code = String(randomInt(0, 10_000)).padStart(4, "0");
    const rows = await q(
      `INSERT INTO rider_jobs (id, order_id, vendor_order_id, rider_id, pickup_name, pickup_address, pickup_phone, drop_name, drop_address,
                               drop_phone, city, earning, delivery_code, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT DO NOTHING RETURNING id`,
      [
        id, p.order_id, input.vendorOrderId, input.riderId, p.store_name ?? "Seller",
        [pickup.line1, pickup.line2, `${pickup.city}, ${pickup.state} ${pickup.pincode}`].filter(Boolean).join(", "),
        p.onboarding?.shipping?.contactPhone ?? p.mobile,
        p.customer_name, `${p.address}, ${p.city}, ${p.state} ${p.pincode}`, p.customer_phone, city, input.earning, code, input.note || null, actor,
      ],
    );
    if (!rows[0]) throw new ApiError(409, "already_assigned", "This shipment already has a rider. The list has been refreshed.");
    await event(q, id, `admin:${actor}`, null, "offered");
    await audit({ type: "admin", id: actor }, "rider_job.create", { vendorId: p.vendor_id, ip, detail: { jobId: id, riderId: input.riderId, number: p.number, earning: input.earning } }, q);
    await notifyVendor(
      p.vendor_id,
      {
        type: "order",
        title: `Rider booked for order ${p.number}`,
        body: "A Riderzpro rider will collect this order from your pickup address. Keep it packed and ready.",
        link: `/vendor/dashboard/orders/${input.vendorOrderId}`,
      },
      q,
    );
  });
  // "New delivery near <area>" to the rider, once per job (messaging.ts never throws).
  await smsRiderOffer(id).catch(() => undefined);
  return { id };
}

export type AdminJob = {
  id: string;
  orderNumber: string;
  status: JobStatus;
  riderId: string;
  riderName: string;
  riderMobile: string;
  pickupName: string;
  dropName: string;
  city: string;
  earning: number;
  codeLocked: boolean;
  cancelReason: string | null;
  offeredAt: string;
  updatedAt: string;
  paid: boolean;
};

export async function listJobsAdmin(scope: "live" | "recent"): Promise<AdminJob[]> {
  const rows = await sql<{
    id: string; number: string; status: JobStatus; rider_id: string; name: string; mobile: string; pickup_name: string; drop_name: string;
    city: string; earning: number; code_attempts: number; cancel_reason: string | null; offered_at: Date; updated_at: Date; payout_id: string | null;
  }>(
    `SELECT j.id, o.number, j.status, j.rider_id, r.name, r.mobile, j.pickup_name, j.drop_name, j.city, j.earning, j.code_attempts,
            j.cancel_reason, j.offered_at, j.updated_at, j.payout_id
       FROM rider_jobs j JOIN orders o ON o.id = j.order_id JOIN riders r ON r.id = j.rider_id
      WHERE ($1 = 'recent' AND j.updated_at > now() - interval '14 days') OR ($1 = 'live' AND j.status IN ('offered','accepted','picked_up'))
      ORDER BY j.updated_at DESC LIMIT 200`,
    [scope],
  );
  return rows.map((r) => ({
    id: r.id,
    orderNumber: r.number,
    status: r.status,
    riderId: r.rider_id,
    riderName: r.name,
    riderMobile: r.mobile,
    pickupName: r.pickup_name,
    dropName: r.drop_name,
    city: r.city,
    earning: r.earning,
    codeLocked: r.code_attempts >= CODE_TRIES,
    cancelReason: r.cancel_reason,
    offeredAt: iso(r.offered_at)!,
    updatedAt: iso(r.updated_at)!,
    paid: r.payout_id !== null,
  }));
}

export const jobAdminActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel"), reason: z.string().trim().min(3, "Say why").max(200) }),
  z.object({ action: z.literal("unlock_code") }),
]);

export async function adminJobAction(jobId: string, input: z.infer<typeof jobAdminActionSchema>, actor: string, ip: string): Promise<void> {
  await transaction(async (q) => {
    const j = (await q<{ status: JobStatus }>("SELECT status FROM rider_jobs WHERE id = $1 FOR UPDATE", [jobId]))[0];
    if (!j) throw new ApiError(404, "not_found", "Job not found.");
    if (input.action === "cancel") {
      if (j.status !== "offered" && j.status !== "accepted") {
        throw new ApiError(409, "bad_transition", j.status === "picked_up" ? "The rider has the parcel. It can't be cancelled now." : `This job is ${j.status}.`);
      }
      await q("UPDATE rider_jobs SET status='cancelled', cancel_reason=$2, closed_at=now(), updated_at=now() WHERE id=$1", [jobId, input.reason]);
      await event(q, jobId, `admin:${actor}`, j.status, "cancelled", input.reason);
      await closeTracking(q, jobId, "cancelled");
    } else {
      await q("UPDATE rider_jobs SET code_attempts = 0, updated_at = now() WHERE id = $1", [jobId]);
    }
    await audit({ type: "admin", id: actor }, `rider_job.${input.action}`, { ip, detail: { jobId } }, q);
  });
}

/* --------------------------------------------------------------- payouts */

export const riderPayoutSchema = z.object({
  riderId: z.string().regex(/^rdr_[A-Za-z0-9_-]{10,40}$/),
  reference: z.string().trim().min(4, "Enter the bank or UPI reference").max(60),
});

/** Records that the rider was paid for every delivered, unpaid job (all of them, at once). */
export async function createRiderPayout(input: z.infer<typeof riderPayoutSchema>, actor: string, ip: string): Promise<{ id: string; amount: number; jobs: number }> {
  return transaction(async (q) => {
    await q("SELECT id FROM riders WHERE id = $1 FOR UPDATE", [input.riderId]);
    const jobs = await q<{ id: string; earning: number }>(
      "SELECT id, earning FROM rider_jobs WHERE rider_id = $1 AND status = 'delivered' AND payout_id IS NULL FOR UPDATE",
      [input.riderId],
    );
    const amount = jobs.reduce((n, j) => n + j.earning, 0);
    if (jobs.length === 0 || amount <= 0) throw new ApiError(409, "nothing_due", "Nothing is due to this rider.");
    const id = newId("rpo");
    await q("INSERT INTO rider_payouts (id, rider_id, amount, jobs, reference, created_by) VALUES ($1,$2,$3,$4,$5,$6)", [
      id, input.riderId, amount, jobs.length, input.reference, actor,
    ]);
    await q("UPDATE rider_jobs SET payout_id = $1 WHERE id = ANY($2)", [id, jobs.map((j) => j.id)]);
    await audit({ type: "admin", id: actor }, "rider_payout.create", { ip, detail: { payoutId: id, riderId: input.riderId, amount, jobs: jobs.length } }, q);
    return { id, amount, jobs: jobs.length };
  });
}

/* -------------------------------------------------- customer order page */

export type CustomerRiderInfo = { riderFirstName: string; vehicle: VehicleType; status: JobStatus; code: string | null };

/** The live (or delivered) rider job for each shipment of an order, for the customer's order page. */
export async function riderInfoForOrder(orderId: string): Promise<Map<string, CustomerRiderInfo>> {
  const rows = await sql<{ vendor_order_id: string | null; status: JobStatus; delivery_code: string; name: string; vehicle_type: VehicleType }>(
    `SELECT j.vendor_order_id, j.status, j.delivery_code, r.name, r.vehicle_type
       FROM rider_jobs j JOIN riders r ON r.id = j.rider_id
      WHERE j.order_id = $1 AND j.status IN ('offered','accepted','picked_up','delivered')`,
    [orderId],
  );
  const map = new Map<string, CustomerRiderInfo>();
  for (const r of rows) {
    map.set(r.vendor_order_id ?? "house", {
      riderFirstName: r.name.trim().split(/\s+/)[0],
      vehicle: r.vehicle_type,
      status: r.status,
      // The code is only useful (and only shown) while the parcel is on its way.
      code: r.status === "accepted" || r.status === "picked_up" ? r.delivery_code : null,
    });
  }
  return map;
}

/** Counts for the admin hub: applications waiting and Delhi NCR shipments with no rider. Null without a database. */
export async function riderCounts(): Promise<{ applied: number; ready: number } | null> {
  try {
    const a = await sqlOne<{ n: string }>("SELECT count(*) AS n FROM riders WHERE status = 'applied'");
    const ready = (await dispatchCandidates()).filter((c) => c.inArea).length;
    return { applied: Number(a?.n ?? 0), ready };
  } catch {
    return null;
  }
}
