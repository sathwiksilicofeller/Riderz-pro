import "server-only";

import { z } from "@/lib/zod";
import { sql, sqlOne, transaction } from "@/lib/db/client";
import { assertOwnFiles } from "./files";
import { ApiError, rateLimit } from "./http";
import { hashPassword, newId, seal, verifyPassword } from "./security";
import { endAllSessions, startSession } from "./session";
import { audit, vendorById } from "./vendors";
import { addressSchema, bankStepSchema, maskTail, mobileSchema, passwordSchema } from "@/lib/vendor/validators";
import type { VendorSelf } from "@/lib/vendor/types";

/**
 * Vendor-side account logic: settings, bank change requests,
 * password change, notifications and support tickets. Every function takes the
 * signed-in `VendorSelf` from the session — never an id from the request.
 */

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);

/* --------------------------------------------------------------- settings */

export const settingsPatchSchema = z
  .object({
    description: z.string().trim().min(20, "Describe your store in at least 20 characters").max(600, "600 characters or fewer"),
    logoFileId: z.string().min(1).max(80).nullable(),
    bannerFileId: z.string().min(1).max(80).nullable(),
    contactPhone: mobileSchema,
    handlingDays: z.number().int().min(0).max(10),
    shipsTo: z.enum(["pan_india", "own_state"]),
    acceptsReturns: z.boolean(),
    returnWindowDays: z.number().int().min(0).max(30),
    pickup: addressSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const passwordChangeSchema = z.object({
  current: z.string().min(1, "Enter your current password").max(128),
  next: passwordSchema,
});
export const markReadSchema = z.object({
  ids: z.array(z.string().min(1).max(60)).max(200).optional(),
  all: z.boolean().optional(),
});
export const ticketSchema = z.object({
  subject: z.string().trim().min(3, "Add a short subject").max(120),
  body: z.string().trim().min(10, "Tell us a little more (10 characters or more)").max(2000),
});

export type PendingBankChange = { id: string; summary: string; createdAt: string };

export type VendorSettings = {
  status: VendorSelf["status"];
  canEdit: boolean;
  readOnly: {
    storeName: string | null;
    slug: string | null;
    legalName: string | null;
    tradeName: string | null;
    gstin: string | null;
    gstExempt: boolean | null;
    panLast4: string | null;
    businessType: string;
    email: string;
    mobile: string;
  };
  editable: {
    description: string;
    logoFileId: string | null;
    bannerFileId: string | null;
    contactPhone: string;
    handlingDays: number;
    shipsTo: "pan_india" | "own_state";
    acceptsReturns: boolean;
    returnWindowDays: number;
    pickup: { line1: string; line2: string | null; city: string; state: string; pincode: string };
  };
  bank: { holderName: string; maskedAccount: string; ifsc: string } | null;
  pendingBankChange: PendingBankChange | null;
};

export async function getSettings(vendor: VendorSelf): Promise<VendorSettings> {
  const o = vendor.onboarding;
  const pending = await sqlOne<{ id: string; summary: string; created_at: Date }>(
    "SELECT id, summary, created_at FROM vendor_change_requests WHERE vendor_id = $1 AND kind = 'bank' AND status = 'pending' ORDER BY created_at DESC LIMIT 1",
    [vendor.id],
  );
  return {
    status: vendor.status,
    canEdit: vendor.status === "approved",
    readOnly: {
      storeName: vendor.storeName,
      slug: vendor.slug,
      legalName: o.tax?.legalName ?? null,
      tradeName: o.tax?.tradeName ?? null,
      gstin: o.tax?.gstExempt ? null : (o.tax?.gstin ?? null),
      gstExempt: o.tax?.gstExempt ?? null,
      panLast4: o.tax?.panLast4 ?? null,
      businessType: vendor.businessType,
      email: vendor.email,
      mobile: vendor.mobile,
    },
    editable: {
      description: o.store?.description ?? "",
      logoFileId: o.store?.logoFileId ?? null,
      bannerFileId: o.store?.bannerFileId ?? null,
      contactPhone: o.shipping?.contactPhone ?? vendor.mobile,
      handlingDays: o.shipping?.handlingDays ?? 2,
      shipsTo: o.shipping?.shipsTo ?? "pan_india",
      acceptsReturns: o.shipping?.acceptsReturns ?? true,
      returnWindowDays: o.shipping?.returnWindowDays ?? 7,
      pickup: o.shipping?.pickup ?? { line1: "", line2: null, city: "", state: "", pincode: "" },
    },
    bank: o.bank ? { holderName: o.bank.holderName, maskedAccount: maskTail(o.bank.accountLast4, 12), ifsc: o.bank.ifsc } : null,
    pendingBankChange: pending ? { id: pending.id, summary: pending.summary, createdAt: iso(pending.created_at)! } : null,
  };
}

/** Changes that need no review: store profile, contact, shipping, returns, pickup address. */
export async function updateSettings(vendor: VendorSelf, patch: SettingsPatch, ip: string): Promise<void> {
  if (patch.logoFileId) await assertOwnFiles(vendor.id, [patch.logoFileId], ["logo"]);
  if (patch.bannerFileId) await assertOwnFiles(vendor.id, [patch.bannerFileId], ["banner"]);

  const store: Record<string, unknown> = {};
  if (patch.description !== undefined) store.description = patch.description;
  if (patch.logoFileId !== undefined) store.logoFileId = patch.logoFileId;
  if (patch.bannerFileId !== undefined) store.bannerFileId = patch.bannerFileId;

  const shipping: Record<string, unknown> = {};
  if (patch.contactPhone !== undefined) shipping.contactPhone = patch.contactPhone;
  if (patch.handlingDays !== undefined) shipping.handlingDays = patch.handlingDays;
  if (patch.shipsTo !== undefined) shipping.shipsTo = patch.shipsTo;
  if (patch.acceptsReturns !== undefined) shipping.acceptsReturns = patch.acceptsReturns;
  if (patch.returnWindowDays !== undefined) shipping.returnWindowDays = patch.returnWindowDays;
  if (patch.pickup !== undefined) shipping.pickup = patch.pickup;
  if (shipping.acceptsReturns === false) shipping.returnWindowDays = 0;

  await transaction(async (q) => {
    // Atomic merge into the JSON so concurrent edits of other keys are never lost.
    const rows = await q<{ id: string }>(
      `UPDATE vendors SET
         onboarding = onboarding
           || jsonb_build_object('store', COALESCE(onboarding->'store', '{}'::jsonb) || $2::jsonb)
           || jsonb_build_object('shipping', COALESCE(onboarding->'shipping', '{}'::jsonb) || $3::jsonb),
         updated_at = now()
       WHERE id = $1 AND status = 'approved' RETURNING id`,
      [vendor.id, JSON.stringify(store), JSON.stringify(shipping)],
    );
    if (rows.length === 0) throw new ApiError(403, "not_allowed", "Your store settings cannot be changed right now.");
    await audit(
      { type: "vendor", id: vendor.id },
      "settings.update",
      { vendorId: vendor.id, ip, detail: { changed: Object.keys(patch) } },
      q,
    );
    if (patch.pickup) {
      await audit(
        { type: "vendor", id: vendor.id },
        "settings.pickup_address",
        { vendorId: vendor.id, ip, detail: { from: vendor.onboarding.shipping?.pickup ?? null, to: patch.pickup } },
        q,
      );
    }
  });
}

/* ------------------------------------------------------------ bank change */

/** What a bank change request seals. Read back (once) by the admin when approving. */
export const bankPayloadSchema = z.object({
  holderName: z.string().min(2).max(100),
  accountNumber: z.string().regex(/^[0-9]{9,18}$/),
  ifsc: z.string().length(11),
});
export type BankPayload = z.infer<typeof bankPayloadSchema>;

export async function requestBankChange(
  vendor: VendorSelf,
  input: z.infer<typeof bankStepSchema>,
  ip: string,
): Promise<PendingBankChange> {
  await rateLimit(`bank-change:${vendor.id}`, 5, 24 * 3600);
  const payload: BankPayload = { holderName: input.holderName, accountNumber: input.accountNumber, ifsc: input.ifsc };
  const last4 = input.accountNumber.slice(-4);
  const summary = `Change payout account to ${maskTail(last4, 12)} (${input.ifsc}), holder ${input.holderName}`;
  const id = newId("chg");
  // One pending request at a time: checked in the statement, and the unique index
  // vendor_change_requests_one_pending (migration 002) refuses a simultaneous second one.
  const rows = await sql<{ id: string; created_at: Date }>(
    `INSERT INTO vendor_change_requests (id, vendor_id, kind, payload_sealed, summary)
     SELECT $1, $2, 'bank', $3, $4
     WHERE NOT EXISTS (SELECT 1 FROM vendor_change_requests WHERE vendor_id = $2 AND kind = 'bank' AND status = 'pending')
     RETURNING id, created_at`,
    [id, vendor.id, seal(JSON.stringify(payload)), summary],
  ).catch((err: unknown) => {
    if ((err as { code?: string }).code === "23505") return [];
    throw err;
  });
  if (rows.length === 0) {
    throw new ApiError(409, "pending_exists", "You already have a bank change waiting for review. We will notify you once it is decided.");
  }
  await audit({ type: "vendor", id: vendor.id }, "bank.change_request", {
    vendorId: vendor.id,
    ip,
    detail: { requestId: id, last4, ifsc: input.ifsc },
  });
  return { id, summary, createdAt: iso(rows[0].created_at)! };
}

/* --------------------------------------------------------------- password */

export async function changePassword(vendor: VendorSelf, current: string, next: string, ip: string, userAgent: string | null) {
  await rateLimit(`pw-change:${vendor.id}`, 6, 15 * 60);
  const row = await vendorById(vendor.id);
  if (!row) throw new ApiError(401, "signed_out", "Please sign in again.");
  if (!(await verifyPassword(current, row.password_hash))) {
    throw new ApiError(400, "invalid", "Some details need fixing.", { current: "That is not your current password." });
  }
  if (current === next) {
    throw new ApiError(400, "invalid", "Some details need fixing.", { next: "Choose a different password." });
  }
  const hash = await hashPassword(next);
  await sql("UPDATE vendors SET password_hash = $2, updated_at = now() WHERE id = $1", [vendor.id, hash]);
  // Sign out every device, then keep this browser signed in.
  await endAllSessions(vendor.id);
  await startSession(vendor.id, userAgent);
  await audit({ type: "vendor", id: vendor.id }, "account.password_change", { vendorId: vendor.id, ip });
}

/* ---------------------------------------------------------- notifications */

export type VendorNotification = {
  id: string;
  type: "account" | "product" | "order" | "stock" | "payout" | "support";
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
};

export async function listNotifications(vendorId: string): Promise<{ items: VendorNotification[]; unread: number }> {
  const rows = await sql<{
    id: string;
    type: VendorNotification["type"];
    title: string;
    body: string;
    link: string | null;
    read_at: Date | null;
    created_at: Date;
  }>(
    "SELECT id, type, title, body, link, read_at, created_at FROM notifications WHERE vendor_id = $1 ORDER BY created_at DESC LIMIT 100",
    [vendorId],
  );
  const unread = await sqlOne<{ n: string }>("SELECT count(*) AS n FROM notifications WHERE vendor_id = $1 AND read_at IS NULL", [vendorId]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      body: r.body,
      link: r.link,
      read: Boolean(r.read_at),
      createdAt: iso(r.created_at)!,
    })),
    unread: Number(unread?.n ?? 0),
  };
}

export async function markNotificationsRead(vendorId: string, input: z.infer<typeof markReadSchema>): Promise<void> {
  if (input.all) {
    await sql("UPDATE notifications SET read_at = now() WHERE vendor_id = $1 AND read_at IS NULL", [vendorId]);
  } else if (input.ids?.length) {
    await sql("UPDATE notifications SET read_at = now() WHERE vendor_id = $1 AND read_at IS NULL AND id = ANY($2::text[])", [
      vendorId,
      input.ids,
    ]);
  }
}

/* ---------------------------------------------------------------- support */

export type VendorTicket = {
  id: string;
  subject: string;
  body: string;
  status: "open" | "answered" | "closed";
  adminReply: string | null;
  repliedAt: string | null;
  createdAt: string;
};

export async function listTickets(vendorId: string): Promise<VendorTicket[]> {
  const rows = await sql<{
    id: string;
    subject: string;
    body: string;
    status: VendorTicket["status"];
    admin_reply: string | null;
    replied_at: Date | null;
    created_at: Date;
  }>(
    "SELECT id, subject, body, status, admin_reply, replied_at, created_at FROM support_tickets WHERE vendor_id = $1 ORDER BY created_at DESC LIMIT 100",
    [vendorId],
  );
  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    body: r.body,
    status: r.status,
    adminReply: r.admin_reply,
    repliedAt: iso(r.replied_at),
    createdAt: iso(r.created_at)!,
  }));
}

export async function createTicket(vendor: VendorSelf, input: z.infer<typeof ticketSchema>, ip: string): Promise<VendorTicket> {
  await rateLimit(`ticket:${vendor.id}`, 10, 24 * 3600);
  const id = newId("tkt");
  const rows = await sql<{ created_at: Date }>(
    "INSERT INTO support_tickets (id, vendor_id, subject, body) VALUES ($1, $2, $3, $4) RETURNING created_at",
    [id, vendor.id, input.subject, input.body],
  );
  await audit({ type: "vendor", id: vendor.id }, "support.ticket_create", { vendorId: vendor.id, ip, detail: { ticketId: id } });
  return {
    id,
    subject: input.subject,
    body: input.body,
    status: "open",
    adminReply: null,
    repliedAt: null,
    createdAt: iso(rows[0].created_at)!,
  };
}
