import "server-only";

import type { z } from "@/lib/zod";
import { sql, sqlOne, transaction, type Query } from "@/lib/db/client";
import type { OnboardingState } from "@/components/vendor/onboarding/types";
import {
  ONBOARDING_STEPS,
  type OnboardingSectionId,
  type VendorOnboarding,
  type VendorSelf,
} from "@/lib/vendor/types";
import {
  last4,
  normaliseId,
  panFromGstin,
  requiredDocuments,
  type bankStepSchema,
  type documentsStepSchema,
  type shippingStepSchema,
  type storeStepSchema,
  type taxStepSchema,
} from "@/lib/vendor/validators";
import { assertOwnFiles, type FileKind } from "./files";
import { ApiError } from "./http";
import { otpDeliveryAvailable } from "./otp";
import { seal } from "./security";
import { CAN_EDIT_ONBOARDING } from "./session";
import { audit, notifyVendor, toVendorSelf, type VendorRow } from "./vendors";

/**
 * ONBOARDING (the six KYC steps)
 *
 * Every save runs in a transaction on the locked vendor row, so two tabs
 * cannot overwrite each other and the status check cannot go stale. Full PAN
 * and bank account numbers are sealed into vendor_secrets; the vendor's JSON
 * keeps only the last four digits.
 */

export type SavedSection = Exclude<OnboardingSectionId, "account">;

const STEP_OF = Object.fromEntries(ONBOARDING_STEPS.map((s) => [s.id, s.step])) as Record<OnboardingSectionId, number>;
const ALL_STEPS: number[] = ONBOARDING_STEPS.map((s) => s.step);

const RESERVED_SLUGS = new Set([
  "new", "edit", "admin", "api", "dashboard", "vendor", "store", "riderzpro", "official", "support",
]);
export const isReservedSlug = (slug: string) => RESERVED_SLUGS.has(slug);

/** Step 1 is done when every channel that can be verified is verified. */
export function accountStepComplete(v: { emailVerified: boolean; mobileVerified: boolean }): boolean {
  return (v.emailVerified || !otpDeliveryAvailable("email")) && (v.mobileVerified || !otpDeliveryAvailable("mobile"));
}

function nextIncomplete(completed: number[]): number {
  return ALL_STEPS.find((s) => !completed.includes(s)) ?? ALL_STEPS[ALL_STEPS.length - 1];
}

const withStep = (completed: number[], ...add: number[]) =>
  [...new Set([...completed, ...add])].sort((a, b) => a - b);

/** Only flagged sections may change while the admin has asked for changes. */
function assertEditable(row: VendorRow, section: OnboardingSectionId) {
  if (!CAN_EDIT_ONBOARDING.includes(row.status)) {
    throw new ApiError(403, "not_allowed", "Your application can't be edited right now.");
  }
  if (row.status === "changes_requested" && !row.changes_requested?.sections.includes(section)) {
    throw new ApiError(403, "section_locked", "This section wasn't flagged for changes, so it can't be edited.");
  }
}

/** Lock the vendor row, check the section is editable, apply one section and move the progress along. */
async function saveSection(
  vendorId: string,
  section: SavedSection,
  value: unknown,
  apply?: (q: Query, row: VendorRow) => Promise<void>,
): Promise<VendorSelf> {
  const updated = await transaction(async (q) => {
    const row = (await q<VendorRow>("SELECT * FROM vendors WHERE id = $1 FOR UPDATE", [vendorId]))[0];
    if (!row) throw new ApiError(401, "signed_out", "Please sign in to your seller account.");
    assertEditable(row, section);
    if (apply) await apply(q, row);

    let completed = withStep(row.completed_steps ?? [], STEP_OF[section]);
    if (accountStepComplete(toVendorSelf(row))) completed = withStep(completed, 1);
    const res = await q<VendorRow>(
      `UPDATE vendors
          SET onboarding = jsonb_set(onboarding, ARRAY[$2]::text[], $3::jsonb, true),
              completed_steps = $4::int[], current_step = $5, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [vendorId, section, JSON.stringify(value), completed, nextIncomplete(completed)],
    );
    await audit({ type: "vendor", id: vendorId }, `onboarding.save_${section}`, { vendorId }, q);
    return res[0];
  });
  return toVendorSelf(updated);
}

/* ------------------------------------------------------------------ tax */

export function saveTax(vendorId: string, body: z.infer<typeof taxStepSchema>) {
  const gstin = body.gstExempt ? null : normaliseId(body.gstin ?? "");
  const pan = gstin ? panFromGstin(gstin) : normaliseId(body.pan ?? "");
  const value: NonNullable<VendorOnboarding["tax"]> = {
    gstExempt: body.gstExempt,
    gstin,
    legalName: body.legalName,
    tradeName: body.tradeName || null,
    panLast4: last4(pan),
    idType: body.idType,
    idLast4: body.idLast4.toUpperCase(),
  };
  return saveSection(vendorId, "tax", value, async (q) => {
    await q(
      `INSERT INTO vendor_secrets (vendor_id, pan_sealed, pan_last4) VALUES ($1, $2, $3)
       ON CONFLICT (vendor_id) DO UPDATE SET pan_sealed = EXCLUDED.pan_sealed, pan_last4 = EXCLUDED.pan_last4, updated_at = now()`,
      [vendorId, seal(pan), last4(pan)],
    );
  });
}

/* ---------------------------------------------------------------- store */

export async function saveStore(vendorId: string, body: z.infer<typeof storeStepSchema>) {
  if (isReservedSlug(body.slug)) {
    throw new ApiError(400, "invalid", "Some details need fixing.", { slug: "That address is reserved. Choose another." });
  }
  await assertOwnFiles(vendorId, body.logoFileId ? [body.logoFileId] : [], ["logo"]);
  await assertOwnFiles(vendorId, body.bannerFileId ? [body.bannerFileId] : [], ["banner"]);
  const value: NonNullable<VendorOnboarding["store"]> = {
    storeName: body.storeName,
    slug: body.slug,
    sellerType: body.sellerType,
    description: body.description,
    departments: [...new Set(body.departments)],
    brands: body.brands,
    logoFileId: body.logoFileId,
    bannerFileId: body.bannerFileId,
  };
  try {
    return await saveSection(vendorId, "store", value, async (q) => {
      await q("UPDATE vendors SET store_name = $2, slug = $3 WHERE id = $1", [vendorId, body.storeName, body.slug]);
    });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      const slugTaken = await sqlOne("SELECT 1 AS x FROM vendors WHERE slug = $1 AND id <> $2", [body.slug, vendorId]);
      throw new ApiError(
        409,
        "taken",
        slugTaken ? "That store address is taken." : "That store name is taken.",
        slugTaken
          ? { slug: "That store address is taken. Try another." }
          : { storeName: "That store name is taken. Try another." },
      );
    }
    throw err;
  }
}

/** Is a store name free, and what slug could it have? */
export async function checkStoreName(vendorId: string, name: string, slugBase: string) {
  const taken = await sqlOne("SELECT 1 AS x FROM vendors WHERE lower(store_name) = lower($1) AND id <> $2", [name, vendorId]);
  const candidates = [slugBase, ...Array.from({ length: 9 }, (_, i) => `${slugBase.slice(0, 44)}-${i + 2}`)];
  const used = await sql<{ slug: string }>("SELECT slug FROM vendors WHERE slug = ANY($1::text[]) AND id <> $2", [candidates, vendorId]);
  const usedSet = new Set(used.map((u) => u.slug));
  const slug = candidates.find((c) => !usedSet.has(c) && !isReservedSlug(c)) ?? slugBase;
  return { available: !taken, slug };
}

/* ------------------------------------------------------------- shipping */

export function saveShipping(vendorId: string, body: z.infer<typeof shippingStepSchema>) {
  const value: NonNullable<VendorOnboarding["shipping"]> = {
    ...body,
    pickup: { ...body.pickup, line2: body.pickup.line2 || null },
    returnWindowDays: body.acceptsReturns ? body.returnWindowDays : 0,
  };
  return saveSection(vendorId, "shipping", value);
}

/* ----------------------------------------------------------------- bank */

export function saveBank(vendorId: string, body: z.infer<typeof bankStepSchema>) {
  const value: NonNullable<VendorOnboarding["bank"]> = {
    holderName: body.holderName,
    accountLast4: last4(body.accountNumber),
    ifsc: body.ifsc,
  };
  return saveSection(vendorId, "bank", value, async (q) => {
    await q(
      `INSERT INTO vendor_secrets (vendor_id, bank_holder, bank_account_sealed, bank_account_last4, bank_ifsc)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (vendor_id) DO UPDATE SET bank_holder = EXCLUDED.bank_holder,
         bank_account_sealed = EXCLUDED.bank_account_sealed, bank_account_last4 = EXCLUDED.bank_account_last4,
         bank_ifsc = EXCLUDED.bank_ifsc, updated_at = now()`,
      [vendorId, body.holderName, seal(body.accountNumber), last4(body.accountNumber), body.ifsc],
    );
  });
}

/* ------------------------------------------------------------ documents */

export async function saveDocuments(vendorId: string, body: z.infer<typeof documentsStepSchema>) {
  // One file per kind; the last one listed wins.
  const byKind = new Map(body.files.map((f) => [f.kind, f]));
  const files = [...byKind.values()];
  for (const f of files) await assertOwnFiles(vendorId, [f.fileId], [f.kind as FileKind]);

  const row = await sqlOne<VendorRow>("SELECT * FROM vendors WHERE id = $1", [vendorId]);
  const tax = row?.onboarding?.tax;
  if (!tax) throw new ApiError(400, "tax_first", "Complete your tax details first.");
  const missing = requiredDocuments(tax.gstExempt).filter((k) => !byKind.has(k));
  if (missing.length) {
    throw new ApiError(400, "invalid", "Upload the required documents.", {
      files: "Upload every required document.",
      ...Object.fromEntries(missing.map((k) => [k, "Required"])),
    });
  }
  const value: NonNullable<VendorOnboarding["documents"]> = {
    files,
    agreement: { signatoryName: body.signatoryName, acceptedAt: new Date().toISOString() },
  };
  return saveSection(vendorId, "documents", value);
}

/* --------------------------------------------------------------- submit */

export async function submitApplication(vendorId: string): Promise<void> {
  await transaction(async (q) => {
    const row = (await q<VendorRow>("SELECT * FROM vendors WHERE id = $1 FOR UPDATE", [vendorId]))[0];
    if (!row) throw new ApiError(401, "signed_out", "Please sign in to your seller account.");
    if (!CAN_EDIT_ONBOARDING.includes(row.status)) {
      throw new ApiError(409, "already_submitted", "This application has already been submitted.");
    }
    const resubmit = row.status === "changes_requested";
    let completed = row.completed_steps ?? [];
    if (accountStepComplete(toVendorSelf(row))) completed = withStep(completed, 1);
    const missing = ALL_STEPS.filter((s) => !completed.includes(s));
    if (missing.length) {
      const names = missing.map((s) => ONBOARDING_STEPS[s - 1].title).join(", ");
      throw new ApiError(400, "incomplete", `Finish these steps first: ${names}.`);
    }
    const ob = row.onboarding ?? {};
    const docs = ob.documents;
    if (!ob.tax || !docs?.agreement?.signatoryName || !docs.agreement.acceptedAt) {
      throw new ApiError(400, "incomplete", "Accept the seller agreement to submit.");
    }
    const have = new Set(docs.files.map((f) => f.kind));
    if (requiredDocuments(ob.tax.gstExempt).some((k) => !have.has(k))) {
      throw new ApiError(400, "incomplete", "Upload all required documents to submit.");
    }
    await q(
      `UPDATE vendors SET status = 'submitted', submitted_at = now(), changes_requested = NULL,
              completed_steps = $2::int[], current_step = 6, updated_at = now()
        WHERE id = $1`,
      [vendorId, completed],
    );
    await audit({ type: "vendor", id: vendorId }, resubmit ? "onboarding.resubmit" : "onboarding.submit", { vendorId }, q);
    await notifyVendor(
      vendorId,
      {
        type: "account",
        title: "Application received",
        body: "We've received your seller application. Reviews usually take 1–2 working days; we'll tell you here as soon as there's a decision.",
        link: "/vendor/pending",
      },
      q,
    );
  });
}

/* ----------------------------------------------------------------- read */

/** Everything the stepper needs. Also records step 1 as done once its checks pass. */
export async function loadOnboarding(vendorId: string): Promise<OnboardingState> {
  let row = await sqlOne<VendorRow>("SELECT * FROM vendors WHERE id = $1", [vendorId]);
  if (!row) throw new ApiError(401, "signed_out", "Please sign in to your seller account.");
  if (
    CAN_EDIT_ONBOARDING.includes(row.status) &&
    !(row.completed_steps ?? []).includes(1) &&
    accountStepComplete(toVendorSelf(row))
  ) {
    const completed = withStep(row.completed_steps ?? [], 1);
    row =
      (
        await sql<VendorRow>(
          "UPDATE vendors SET completed_steps = $2::int[], current_step = $3, updated_at = now() WHERE id = $1 RETURNING *",
          [vendorId, completed, Math.max(row.current_step, nextIncomplete(completed))],
        )
      )[0] ?? row;
  }
  const files = await sql<{ id: string; kind: string; mime: string; size_bytes: number }>(
    `SELECT id, kind, mime, size_bytes FROM files
      WHERE vendor_id = $1 AND (kind LIKE 'doc\\_%' OR kind IN ('logo','banner')) ORDER BY created_at`,
    [vendorId],
  );
  const bank = await sqlOne<{ bank_holder: string | null; bank_account_last4: string | null; bank_ifsc: string | null }>(
    "SELECT bank_holder, bank_account_last4, bank_ifsc FROM vendor_secrets WHERE vendor_id = $1",
    [vendorId],
  );
  return {
    vendor: toVendorSelf(row),
    otp: { email: otpDeliveryAvailable("email"), mobile: otpDeliveryAvailable("mobile") },
    uploaded: files.map((f) => ({ id: f.id, kind: f.kind, mime: f.mime, size: f.size_bytes })),
    bank:
      bank?.bank_holder && bank.bank_account_last4 && bank.bank_ifsc
        ? { holderName: bank.bank_holder, accountLast4: bank.bank_account_last4, ifsc: bank.bank_ifsc }
        : null,
  };
}
