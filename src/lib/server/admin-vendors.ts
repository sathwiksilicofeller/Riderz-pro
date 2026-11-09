import "server-only";

import { z } from "@/lib/zod";
import { sql, sqlOne, transaction, type Query, containsPattern } from "@/lib/db/client";
import { DEPARTMENT_BY_SLUG } from "@/lib/data/taxonomy";
import { findModelBySlug } from "@/lib/data/vehicles";
import { ApiError, rateLimit } from "./http";
import { bankPayloadSchema } from "./vendor-account";
import { seal, unseal } from "./security";
import { endAllSessions } from "./session";
import { audit, notifyVendor, toVendorSelf, vendorById } from "./vendors";
import { toVendorProduct, type VendorProductRow } from "./vendor-products";
import {
  DOCUMENT_LABELS,
  ONBOARDING_STEPS,
  VENDOR_STATUSES,
  VENDOR_TIERS,
  type DocumentKind,
  type OnboardingSectionId,
  type VendorProduct,
  type VendorProductContent,
  type VendorSelf,
  type VendorStatus,
} from "@/lib/vendor/types";
import { gstinProblem, panFromGstin, productContentSchema, requiredDocuments } from "@/lib/vendor/validators";
import { ensureStarterCategories } from "./starter-categories";

/**
 * Admin-side logic for the seller marketplace: the KYC queue and decisions,
 * the secret reveal, the product approval queue, bank change requests and
 * support tickets. Called from /api/admin/* routes and /admin/* pages, both
 * behind the admin team login (src/lib/server/admin-auth.ts). The route layer supplies the actor (the admin's email).
 */

const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
const stale = () =>
  new ApiError(409, "stale", "This record changed since you opened it. Reload to see its current state, then try again.");

/* ================================================================ vendors */

export const QUEUE_STATUSES: VendorStatus[] = ["submitted", "under_review", "changes_requested"];

export type VendorListItem = {
  id: string;
  storeName: string | null;
  fullName: string;
  email: string;
  mobile: string;
  businessType: string;
  status: VendorStatus;
  submittedAt: string | null;
  createdAt: string;
  emailVerified: boolean;
  mobileVerified: boolean;
  liveProducts: number;
};

export type VendorFilter = "queue" | "all" | VendorStatus;

export function parseVendorFilter(raw: string | null | undefined): VendorFilter {
  if (raw === "all") return "all";
  if (raw && (VENDOR_STATUSES as readonly string[]).includes(raw)) return raw as VendorStatus;
  return "queue";
}

const likeEscape = containsPattern;

export async function listVendors(filter: VendorFilter, q: string): Promise<{ items: VendorListItem[]; counts: Record<string, number> }> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (filter === "queue") {
    params.push(QUEUE_STATUSES);
    where.push(`v.status = ANY($${params.length}::text[])`);
  } else if (filter !== "all") {
    params.push(filter);
    where.push(`v.status = $${params.length}`);
  }
  const term = q.trim().slice(0, 80);
  if (term) {
    params.push(likeEscape(term));
    const n = params.length;
    where.push(
      `(v.store_name ILIKE $${n} OR v.full_name ILIKE $${n} OR v.email ILIKE $${n} OR v.mobile LIKE $${n} OR v.slug ILIKE $${n})`,
    );
  }
  const rows = await sql<{
    id: string;
    store_name: string | null;
    full_name: string;
    email: string;
    mobile: string;
    business_type: string;
    status: VendorStatus;
    submitted_at: Date | null;
    created_at: Date;
    email_verified_at: Date | null;
    mobile_verified_at: Date | null;
    live_products: string;
  }>(
    `SELECT v.id, v.store_name, v.full_name, v.email, v.mobile, v.business_type, v.status, v.submitted_at, v.created_at,
            v.email_verified_at, v.mobile_verified_at,
            (SELECT count(*) FROM vendor_products p WHERE p.vendor_id = v.id AND p.status = 'live') AS live_products
     FROM vendors v ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY v.submitted_at ASC NULLS LAST, v.created_at DESC LIMIT 200`,
    params,
  );
  const countRows = await sql<{ status: string; n: string }>("SELECT status, count(*) AS n FROM vendors GROUP BY status");
  const counts: Record<string, number> = {};
  let all = 0;
  for (const c of countRows) {
    counts[c.status] = Number(c.n);
    all += Number(c.n);
  }
  counts.all = all;
  counts.queue = QUEUE_STATUSES.reduce((s, k) => s + (counts[k] ?? 0), 0);
  return {
    counts,
    items: rows.map((r) => ({
      id: r.id,
      storeName: r.store_name,
      fullName: r.full_name,
      email: r.email,
      mobile: r.mobile,
      businessType: r.business_type,
      status: r.status,
      submittedAt: iso(r.submitted_at),
      createdAt: iso(r.created_at)!,
      emailVerified: Boolean(r.email_verified_at),
      mobileVerified: Boolean(r.mobile_verified_at),
      liveProducts: Number(r.live_products),
    })),
  };
}

export type VendorFileInfo = {
  id: string;
  kind: string;
  label: string;
  mime: string;
  size: number;
  createdAt: string;
  /** Served by /api/admin/files/<id>. */
  url: string;
};

export type TimelineEntry = { at: string; actorType: string; actor: string; action: string; detail: Record<string, unknown> | null };

export type VendorReview = {
  vendor: VendorSelf;
  statusBeforeSuspension: VendorStatus | null;
  approvedBy: string | null;
  secrets: {
    panLast4: string | null;
    bankHolder: string | null;
    bankLast4: string | null;
    bankIfsc: string | null;
  };
  files: VendorFileInfo[];
  timeline: TimelineEntry[];
  products: Record<string, number>;
  checks: {
    gstin: { applicable: boolean; value: string | null; problem: string | null };
    /** null when it cannot be derived (GST exempt) or the sealed PAN could not be read. */
    panMatchesGstin: boolean | null;
    documents: { kind: DocumentKind; label: string; present: boolean; fileId: string | null }[];
    documentsComplete: boolean;
    emailVerified: boolean;
    mobileVerified: boolean;
    slug: string | null;
    holderMatchesLegalName: boolean;
  };
};

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function vendorReview(id: string): Promise<VendorReview | null> {
  const row = await vendorById(id);
  if (!row) return null;
  const vendor = toVendorSelf(row);
  const secrets = await sqlOne<{
    pan_sealed: string | null;
    pan_last4: string | null;
    bank_holder: string | null;
    bank_account_last4: string | null;
    bank_ifsc: string | null;
  }>("SELECT pan_sealed, pan_last4, bank_holder, bank_account_last4, bank_ifsc FROM vendor_secrets WHERE vendor_id = $1", [id]);

  const files = await sql<{ id: string; kind: string; mime: string; size_bytes: number; created_at: Date }>(
    "SELECT id, kind, mime, size_bytes, created_at FROM files WHERE vendor_id = $1 AND kind LIKE 'doc\\_%' ORDER BY created_at DESC",
    [id],
  );
  const timelineRows = await sql<{ at: Date; actor_type: string; actor: string; action: string; detail: Record<string, unknown> | null }>(
    "SELECT at, actor_type, actor, action, detail FROM audit_log WHERE vendor_id = $1 ORDER BY at DESC, id DESC LIMIT 100",
    [id],
  );
  const productRows = await sql<{ status: string; n: string }>(
    "SELECT status, count(*) AS n FROM vendor_products WHERE vendor_id = $1 GROUP BY status",
    [id],
  );

  const tax = vendor.onboarding.tax;
  const gstExempt = tax?.gstExempt ?? false;
  const gstin = tax && !tax.gstExempt ? tax.gstin : null;
  let panMatches: boolean | null = null;
  if (gstin && secrets?.pan_sealed) {
    try {
      panMatches = unseal(secrets.pan_sealed) === panFromGstin(gstin);
    } catch {
      panMatches = null;
    }
  }
  const submitted = vendor.onboarding.documents?.files ?? [];
  const fileIds = new Set(files.map((f) => f.id));
  const documents = requiredDocuments(gstExempt).map((kind) => {
    const f = submitted.find((d) => d.kind === kind && fileIds.has(d.fileId));
    return { kind, label: DOCUMENT_LABELS[kind], present: Boolean(f), fileId: f?.fileId ?? null };
  });
  const holder = secrets?.bank_holder ?? vendor.onboarding.bank?.holderName ?? null;
  const legal = tax?.legalName ?? null;
  const holderMatches = Boolean(holder && legal && (norm(holder) === norm(legal) || norm(legal).includes(norm(holder)) || norm(holder).includes(norm(legal))));

  const label = (kind: string) => (DOCUMENT_LABELS as Record<string, string>)[kind] ?? kind;
  return {
    vendor,
    statusBeforeSuspension: row.status_before_suspension,
    approvedBy: row.approved_by,
    secrets: {
      panLast4: secrets?.pan_last4 ?? tax?.panLast4 ?? null,
      bankHolder: secrets?.bank_holder ?? vendor.onboarding.bank?.holderName ?? null,
      bankLast4: secrets?.bank_account_last4 ?? vendor.onboarding.bank?.accountLast4 ?? null,
      bankIfsc: secrets?.bank_ifsc ?? vendor.onboarding.bank?.ifsc ?? null,
    },
    files: files.map((f) => ({
      id: f.id,
      kind: f.kind,
      label: label(f.kind),
      mime: f.mime,
      size: f.size_bytes,
      createdAt: iso(f.created_at)!,
      url: `/api/admin/files/${f.id}`,
    })),
    timeline: timelineRows.map((t) => ({
      at: iso(t.at)!,
      actorType: t.actor_type,
      actor: t.actor,
      action: t.action,
      detail: t.detail,
    })),
    products: Object.fromEntries(productRows.map((p) => [p.status, Number(p.n)])),
    checks: {
      gstin: { applicable: !gstExempt, value: gstin, problem: gstExempt ? null : gstin ? gstinProblem(gstin) : "No GSTIN on the application." },
      panMatchesGstin: panMatches,
      documents,
      documentsComplete: documents.every((d) => d.present),
      emailVerified: vendor.emailVerified,
      mobileVerified: vendor.mobileVerified,
      slug: vendor.slug,
      holderMatchesLegalName: holderMatches,
    },
  };
}

/* ---------------------------------------------------------------- reveal */

export const revealSchema = z.object({
  field: z.enum(["bank", "pan"]),
  reason: z.string().trim().min(5, "Say why you need to see this (5+ characters)").max(300),
});

/** Unseals one secret for one admin, once. The caller shows it for a short time. Always audited. */
export async function revealSecret(vendorId: string, input: z.infer<typeof revealSchema>, actor: string, ip: string) {
  await rateLimit(`reveal:${actor}`, 40, 3600);
  const s = await sqlOne<{
    pan_sealed: string | null;
    bank_holder: string | null;
    bank_account_sealed: string | null;
    bank_ifsc: string | null;
  }>("SELECT pan_sealed, bank_holder, bank_account_sealed, bank_ifsc FROM vendor_secrets WHERE vendor_id = $1", [vendorId]);
  const sealed = input.field === "bank" ? s?.bank_account_sealed : s?.pan_sealed;
  if (!sealed) throw new ApiError(404, "not_found", "Nothing is stored for that field.");
  let value: string;
  try {
    value = unseal(sealed);
  } catch {
    throw new ApiError(500, "unseal_failed", "That value could not be decrypted. Check VENDOR_DATA_KEY.");
  }
  await audit({ type: "admin", id: actor }, `kyc.reveal_${input.field}`, {
    vendorId,
    ip,
    detail: { reason: input.reason },
  });
  return input.field === "bank"
    ? { field: "bank" as const, value, holder: s?.bank_holder ?? null, ifsc: s?.bank_ifsc ?? null }
    : { field: "pan" as const, value };
}

/* -------------------------------------------------------------- decisions */

const sectionIds = ONBOARDING_STEPS.map((s) => s.id) as [OnboardingSectionId, ...OnboardingSectionId[]];
const reasonText = (label: string) => z.string().trim().min(5, `${label} (5+ characters)`).max(1000);

export const vendorDecisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start_review") }),
  z.object({
    action: z.literal("approve"),
    commissionRate: z
      .number()
      .min(0)
      .max(50)
      .refine((v) => Math.round(v * 2) === v * 2, "Use steps of 0.5"),
    tier: z.enum(VENDOR_TIERS),
  }),
  z.object({
    action: z.literal("request_changes"),
    sections: z.array(z.enum(sectionIds)).min(1, "Pick at least one section").max(6),
    note: reasonText("Tell the seller what to fix"),
  }),
  z.object({ action: z.literal("reject"), reason: reasonText("Give a reason") }),
  z.object({ action: z.literal("suspend"), reason: reasonText("Give a reason") }),
  z.object({ action: z.literal("reinstate") }),
]);
export type VendorDecision = z.infer<typeof vendorDecisionSchema>;

export async function decideVendor(vendorId: string, input: VendorDecision, actor: string, ip: string): Promise<{ status: VendorStatus }> {
  const row = await vendorById(vendorId);
  if (!row) throw new ApiError(404, "not_found", "Seller not found.");
  const by = { type: "admin" as const, id: actor };

  await transaction(async (q) => {
    const move = async (from: VendorStatus[], setSql: string, params: unknown[]) => {
      const rows = await q<{ id: string }>(
        `UPDATE vendors SET ${setSql}, updated_at = now() WHERE id = $1 AND status = ANY($2::text[]) RETURNING id`,
        [vendorId, from, ...params],
      );
      if (rows.length === 0) throw stale();
    };

    switch (input.action) {
      case "start_review": {
        await move(["submitted"], "status = 'under_review'", []);
        await audit(by, "kyc.start_review", { vendorId, ip }, q);
        break;
      }
      case "approve": {
        if (!row.store_name || !row.slug) throw new ApiError(409, "incomplete", "This application has no store name or URL yet.");
        await move(
          ["submitted", "under_review"],
          "status = 'approved', commission_rate = $3, tier = $4, approved_at = now(), approved_by = $5, changes_requested = NULL, rejection_reason = NULL",
          [input.commissionRate, input.tier, actor],
        );
        await audit(by, "kyc.approve", { vendorId, ip, detail: { commissionRate: input.commissionRate, tier: input.tier } }, q);
        // Sellers the owner set up a starter category list for (Indus Enterprises) get it now.
        await ensureStarterCategories(vendorId, by, q);
        await notifyVendor(
          vendorId,
          {
            type: "account",
            title: "Your store is approved",
            body: `Welcome to Riderzpro. Your commission is ${input.commissionRate}% (${input.tier} tier). You can now add products and receive orders.`,
            link: "/vendor/dashboard",
          },
          q,
        );
        break;
      }
      case "request_changes": {
        const sections = [...new Set(input.sections)];
        const steps = sections.map((id) => ONBOARDING_STEPS.find((s) => s.id === id)!.step);
        const flagged = { sections, note: input.note, requestedAt: new Date().toISOString() };
        await move(
          ["submitted", "under_review"],
          "status = 'changes_requested', changes_requested = $3::jsonb, completed_steps = ARRAY(SELECT s FROM unnest(completed_steps) AS s WHERE NOT (s = ANY($4::int[]))), current_step = $5",
          [JSON.stringify(flagged), steps, Math.min(...steps)],
        );
        await audit(by, "kyc.request_changes", { vendorId, ip, detail: { sections, note: input.note } }, q);
        await notifyVendor(
          vendorId,
          {
            type: "account",
            title: "Changes needed on your application",
            body: `${input.note} Sections to update: ${sections.map((s) => ONBOARDING_STEPS.find((x) => x.id === s)!.title).join(", ")}.`,
            link: "/vendor/onboarding",
          },
          q,
        );
        break;
      }
      case "reject": {
        await move(["submitted", "under_review", "changes_requested"], "status = 'rejected', rejection_reason = $3, changes_requested = NULL", [input.reason]);
        await audit(by, "kyc.reject", { vendorId, ip, detail: { reason: input.reason } }, q);
        await notifyVendor(
          vendorId,
          { type: "account", title: "Your application was not approved", body: input.reason, link: "/vendor/pending" },
          q,
        );
        break;
      }
      case "suspend": {
        await move(["approved"], "status = 'suspended', status_before_suspension = 'approved', rejection_reason = $3", [input.reason]);
        await audit(by, "kyc.suspend", { vendorId, ip, detail: { reason: input.reason } }, q);
        await notifyVendor(
          vendorId,
          {
            type: "account",
            title: "Your store is suspended",
            body: `Your Offline Store screen is closed and your products are hidden until this is resolved. Reason: ${input.reason}. Contact seller support to discuss.`,
            link: "/vendor/dashboard/support",
          },
          q,
        );
        break;
      }
      case "reinstate": {
        await move(["suspended"], "status = 'approved', status_before_suspension = NULL, rejection_reason = NULL", []);
        await audit(by, "kyc.reinstate", { vendorId, ip }, q);
        await notifyVendor(
          vendorId,
          {
            type: "account",
            title: "Your store is active again",
            body: "Your suspension has been lifted. Live products are back on the shop.",
            link: "/vendor/dashboard",
          },
          q,
        );
        break;
      }
    }
  });

  // Rejection revokes sessions so a stale dashboard tab stops working at once.
  if (input.action === "reject") await endAllSessions(vendorId);
  const after = await vendorById(vendorId);
  return { status: after?.status ?? row.status };
}

/* ============================================================ product queue */

export type ProductState = "pending" | "revisions" | "live" | "all";

export function parseProductState(raw: string | null | undefined): ProductState {
  return raw === "revisions" || raw === "live" || raw === "all" ? raw : "pending";
}

export type ProductListItem = {
  id: string;
  title: string;
  brand: string;
  sku: string;
  price: number;
  mrp: number;
  status: VendorProduct["status"];
  hasRevision: boolean;
  vendorId: string;
  storeName: string | null;
  vendorStatus: VendorStatus;
  imageId: string | null;
  submittedAt: string | null;
  department: string;
};

export async function listVendorProducts(state: ProductState, q: string): Promise<{ items: ProductListItem[]; counts: Record<string, number> }> {
  const cond: Record<ProductState, string> = {
    pending: "p.status = 'pending_review'",
    revisions: "p.status = 'live' AND p.pending_revision IS NOT NULL",
    live: "p.status = 'live'",
    all: "(p.status IN ('pending_review','live','changes_requested','rejected'))",
  };
  const params: unknown[] = [];
  let search = "";
  const term = q.trim().slice(0, 80);
  if (term) {
    params.push(likeEscape(term));
    search = ` AND (p.title ILIKE $1 OR p.sku ILIKE $1 OR p.brand ILIKE $1 OR v.store_name ILIKE $1)`;
  }
  const rows = await sql<
    VendorProductRow & { store_name: string | null; vendor_status: VendorStatus }
  >(
    `SELECT p.*, v.store_name, v.status AS vendor_status FROM vendor_products p JOIN vendors v ON v.id = p.vendor_id
     WHERE ${cond[state]}${search} ORDER BY p.submitted_at ASC NULLS LAST, p.updated_at DESC LIMIT 200`,
    params,
  );
  const c = await sqlOne<{ pending: string; revisions: string; live: string }>(
    `SELECT count(*) FILTER (WHERE status = 'pending_review') AS pending,
            count(*) FILTER (WHERE status = 'live' AND pending_revision IS NOT NULL) AS revisions,
            count(*) FILTER (WHERE status = 'live') AS live
     FROM vendor_products`,
  );
  return {
    counts: { pending: Number(c?.pending ?? 0), revisions: Number(c?.revisions ?? 0), live: Number(c?.live ?? 0) },
    items: rows.map((r) => {
      const content = r.status === "live" && r.pending_revision ? r.pending_revision : r;
      const images = (content as { images?: string[] }).images ?? [];
      return {
        id: r.id,
        title: (content as { title: string }).title,
        brand: (content as { brand: string }).brand,
        sku: r.sku,
        price: r.price,
        mrp: r.mrp,
        status: r.status,
        hasRevision: r.status === "live" && Boolean(r.pending_revision),
        vendorId: r.vendor_id,
        storeName: r.store_name,
        vendorStatus: r.vendor_status,
        imageId: images[0] ?? null,
        submittedAt: iso(r.submitted_at),
        department: (content as { department: string }).department,
      };
    }),
  };
}

const CONTENT_FIELDS: { key: keyof VendorProductContent; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "brand", label: "Brand" },
  { key: "department", label: "Department" },
  { key: "groupSlug", label: "Category" },
  { key: "partType", label: "Part type" },
  { key: "hsn", label: "HSN code" },
  { key: "gstRate", label: "GST rate" },
  { key: "warrantyMonths", label: "Warranty" },
  { key: "summary", label: "Summary" },
  { key: "highlights", label: "Highlights" },
  { key: "specs", label: "Specifications" },
  { key: "fitment", label: "Fitment" },
  { key: "images", label: "Photos" },
];
export const REVIEW_FIELD_LABELS = CONTENT_FIELDS.map((f) => f.label);

function contentOf(p: VendorProduct): VendorProductContent {
  return {
    title: p.title,
    brand: p.brand,
    department: p.department,
    groupSlug: p.groupSlug,
    partType: p.partType,
    hsn: p.hsn,
    gstRate: p.gstRate,
    warrantyMonths: p.warrantyMonths,
    summary: p.summary,
    highlights: p.highlights,
    specs: p.specs,
    fitment: p.fitment,
    images: p.images,
  };
}

function fitmentNames(slugs: string[]): string[] {
  return slugs.map((s) => {
    if (s === "universal") return "Universal (fits all)";
    const m = findModelBySlug(s);
    return m ? `${m.brand} ${m.name}` : `${s} (unknown model)`;
  });
}

const display = (key: keyof VendorProductContent, c: VendorProductContent): string => {
  const v = c[key];
  if (key === "department") return DEPARTMENT_BY_SLUG[c.department]?.name ?? c.department;
  if (key === "groupSlug") return DEPARTMENT_BY_SLUG[c.department]?.groups.find((g) => g.slug === c.groupSlug)?.name ?? c.groupSlug;
  if (key === "warrantyMonths") return v === null ? "None" : `${v} months`;
  if (key === "gstRate") return `${v}%`;
  if (key === "highlights") return (v as string[]).length ? (v as string[]).map((h) => `• ${h}`).join("\n") : "None";
  if (key === "specs") return (v as { label: string; value: string }[]).length ? (v as { label: string; value: string }[]).map((s) => `${s.label}: ${s.value}`).join("\n") : "None";
  if (key === "fitment") return fitmentNames(v as string[]).join(", ") || "None";
  if (key === "images") return `${(v as string[]).length} photo(s)`;
  return v === null || v === "" ? "—" : String(v);
};

const tokens = (s: string) => new Set(norm(s).split(" ").filter((t) => t.length > 1));
function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

export type DuplicateHit = { source: "vendor" | "house"; id: string; title: string; detail: string; reason: "sku" | "title"; href: string | null };

export type ProductReview = {
  product: VendorProduct;
  /** The content under review: the pending revision if there is one, else the product's own. */
  content: VendorProductContent;
  contentRows: { key: string; label: string; text: string; changed: boolean }[];
  /** Per-field before/after, only when a live product has a pending revision. */
  diff: { key: string; label: string; before: string; after: string; beforeImages?: string[]; afterImages?: string[] }[];
  kind: "new" | "revision" | "other";
  canDecide: boolean;
  vendor: { id: string; storeName: string | null; status: VendorStatus; fullName: string; email: string };
  price: { price: number; mrp: number; discountPct: number; flags: { level: "warn" | "info"; text: string }[] };
  compliance: { hsnPresent: boolean; gstRate: number; hsn: string | null };
  fitment: string[];
  duplicates: DuplicateHit[];
  imageUrls: string[];
};

export async function productReview(id: string): Promise<ProductReview | null> {
  const row = await sqlOne<VendorProductRow>("SELECT * FROM vendor_products WHERE id = $1", [id]);
  if (!row) return null;
  const product = toVendorProduct(row);
  const v = await vendorById(product.vendorId);
  if (!v) return null;

  const isRevision = product.status === "live" && product.pendingRevision !== null;
  const isNew = product.status === "pending_review";
  const own = contentOf(product);
  const content = isRevision ? { ...own, ...product.pendingRevision! } : own;

  const diff: ProductReview["diff"] = [];
  if (isRevision) {
    for (const f of CONTENT_FIELDS) {
      if (JSON.stringify(own[f.key]) !== JSON.stringify(content[f.key])) {
        diff.push({
          key: f.key,
          label: f.label,
          before: display(f.key, own),
          after: display(f.key, content),
          ...(f.key === "images" ? { beforeImages: own.images, afterImages: content.images } : {}),
        });
      }
    }
  }
  const changedKeys = new Set(diff.map((d) => d.key));
  const contentRows = CONTENT_FIELDS.filter((f) => f.key !== "images").map((f) => ({
    key: f.key,
    label: f.label,
    text: display(f.key, content),
    changed: changedKeys.has(f.key),
  }));

  // Price sanity against MRP.
  const discountPct = product.mrp > 0 ? Math.round(((product.mrp - product.price) / product.mrp) * 100) : 0;
  const flags: ProductReview["price"]["flags"] = [];
  if (discountPct > 70) flags.push({ level: "warn", text: `Discount of ${discountPct}% is unusually high. Check the MRP is real.` });
  else if (discountPct > 50) flags.push({ level: "info", text: `Discount of ${discountPct}% is on the high side.` });
  if (discountPct === 0) flags.push({ level: "info", text: "Selling price equals MRP (no discount)." });
  if (product.price < 50) flags.push({ level: "warn", text: "Selling price is under ₹50. Check for a typing slip." });
  if (product.mrp >= 1000 && product.mrp % 100 !== 0 && product.mrp % 10 !== 0) flags.push({ level: "info", text: "MRP is not a round number. Compare with the brand's price list." });

  // Duplicate detector: same SKU, or a very similar title, elsewhere.
  const duplicates: DuplicateHit[] = [];
  const skuHits = await sql<{ id: string; title: string; store_name: string | null; sku: string }>(
    `SELECT p.id, p.title, v.store_name, p.sku FROM vendor_products p JOIN vendors v ON v.id = p.vendor_id
     WHERE p.vendor_id <> $1 AND p.status = 'live' AND lower(p.sku) = lower($2) LIMIT 10`,
    [product.vendorId, product.sku],
  );
  for (const h of skuHits) {
    duplicates.push({ source: "vendor", id: h.id, title: h.title, detail: `${h.store_name ?? "Another seller"} · same SKU ${h.sku}`, reason: "sku", href: `/admin/vendor-products/${h.id}` });
  }
  const others = await sql<{ id: string; title: string; brand: string; store_name: string | null }>(
    `SELECT p.id, p.title, p.brand, v.store_name FROM vendor_products p JOIN vendors v ON v.id = p.vendor_id
     WHERE p.vendor_id <> $1 AND p.status = 'live' AND lower(p.brand) = lower($2) LIMIT 300`,
    [product.vendorId, content.brand],
  );
  for (const o of others) {
    if (skuHits.some((s) => s.id === o.id)) continue;
    if (similarity(content.title, o.title) >= 0.6) {
      duplicates.push({ source: "vendor", id: o.id, title: o.title, detail: `${o.store_name ?? "Another seller"} · same brand, similar title`, reason: "title", href: `/admin/vendor-products/${o.id}` });
    }
  }
  // House catalogue titles (server-only import; prices are never read).
  const { CATALOG } = await import("@/lib/catalog");
  const houseBrand = norm(content.brand);
  for (const item of CATALOG) {
    const sameBrand = norm(item.brandName) === houseBrand;
    const score = similarity(content.title, item.title);
    if (score >= (sameBrand ? 0.55 : 0.8)) {
      duplicates.push({ source: "house", id: item.id, title: item.title, detail: `House catalogue · ${item.brandName}`, reason: "title", href: item.href });
    }
    if (duplicates.length >= 15) break;
  }

  return {
    product,
    content,
    contentRows,
    diff,
    kind: isNew ? "new" : isRevision ? "revision" : "other",
    canDecide: isNew || isRevision,
    vendor: { id: v.id, storeName: v.store_name, status: v.status, fullName: v.full_name, email: v.email },
    price: { price: product.price, mrp: product.mrp, discountPct, flags },
    compliance: { hsnPresent: Boolean(content.hsn), gstRate: content.gstRate, hsn: content.hsn },
    fitment: fitmentNames(content.fitment),
    duplicates,
    imageUrls: content.images.map((i) => `/api/admin/files/${i}`),
  };
}

export const productDecisionSchema = z.object({
  action: z.enum(["approve", "request_changes", "reject"]),
  note: z.string().trim().max(1000).optional(),
  fields: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});
export type ProductDecision = z.infer<typeof productDecisionSchema>;
export const bulkApproveSchema = z.object({ ids: z.array(z.string().min(1).max(60)).min(1).max(50) });

export async function decideProduct(productId: string, input: ProductDecision, actor: string, ip: string): Promise<{ status: string }> {
  if (input.action !== "approve" && (input.note ?? "").length < 5) {
    throw new ApiError(400, "invalid", "Some details need fixing.", { note: "Tell the seller what to change (5+ characters)." });
  }
  const by = { type: "admin" as const, id: actor };
  return transaction(async (q: Query) => {
    const row = (await q<VendorProductRow>("SELECT * FROM vendor_products WHERE id = $1", [productId]))[0];
    if (!row) throw new ApiError(404, "not_found", "Product not found.");
    const isRevision = row.status === "live" && row.pending_revision !== null;
    const isNew = row.status === "pending_review";
    if (!isNew && !isRevision) throw stale();
    const vendor = await vendorById(row.vendor_id, q);
    if (!vendor) throw new ApiError(404, "not_found", "Seller not found.");
    const link = `/vendor/dashboard/products/${productId}`;
    const title = isRevision ? (row.pending_revision?.title ?? row.title) : row.title;
    const note = input.note ?? "";
    const reviewNotes = JSON.stringify({ note, fields: input.fields ?? [], at: new Date().toISOString() });
    const guard = (rows: unknown[]) => {
      if (rows.length === 0) throw stale();
    };

    if (input.action === "approve") {
      if (vendor.status !== "approved") {
        throw new ApiError(409, "vendor_not_approved", `${vendor.store_name ?? "This seller"} is not approved (status: ${vendor.status}). Products cannot go live.`);
      }
      if (isNew) {
        guard(
          await q(
            `UPDATE vendor_products SET status = 'live', approved_at = now(), approved_by = $2, review_notes = NULL, rejection_reason = NULL, updated_at = now()
             WHERE id = $1 AND status = 'pending_review' RETURNING id`,
            [productId, actor],
          ),
        );
      } else {
        const parsed = productContentSchema.safeParse(row.pending_revision);
        if (!parsed.success) {
          throw new ApiError(422, "bad_revision", "The pending edit is incomplete or invalid. Ask the seller to resubmit, or reject it.");
        }
        const c = parsed.data;
        guard(
          await q(
            `UPDATE vendor_products SET title = $2, brand = $3, department = $4, group_slug = $5, part_type = $6, hsn = $7, gst_rate = $8,
               warranty_months = $9, summary = $10, highlights = $11::jsonb, specs = $12::jsonb, fitment = $13::jsonb, images = $14::jsonb,
               pending_revision = NULL, review_notes = NULL, approved_at = now(), approved_by = $15, updated_at = now()
             WHERE id = $1 AND status = 'live' AND pending_revision IS NOT NULL RETURNING id`,
            [
              productId, c.title, c.brand, c.department, c.groupSlug, c.partType, c.hsn, c.gstRate, c.warrantyMonths, c.summary,
              JSON.stringify(c.highlights), JSON.stringify(c.specs), JSON.stringify(c.fitment), JSON.stringify(c.images), actor,
            ],
          ),
        );
      }
      await audit(by, "product.approve", { vendorId: vendor.id, ip, detail: { productId, title, revision: isRevision } }, q);
      await notifyVendor(vendor.id, {
        type: "product",
        title: isRevision ? "Your product edit is approved" : "Your product is live",
        body: `“${title}” ${isRevision ? "now shows your updated details" : "is now on the shop"}.`,
        link,
      }, q);
      return { status: "live" };
    }

    if (input.action === "request_changes") {
      if (isNew) {
        guard(
          await q(
            `UPDATE vendor_products SET status = 'changes_requested', review_notes = $2::jsonb, updated_at = now()
             WHERE id = $1 AND status = 'pending_review' RETURNING id`,
            [productId, reviewNotes],
          ),
        );
      } else {
        guard(
          await q(
            `UPDATE vendor_products SET pending_revision = NULL, review_notes = $2::jsonb, updated_at = now()
             WHERE id = $1 AND status = 'live' AND pending_revision IS NOT NULL RETURNING id`,
            [productId, reviewNotes],
          ),
        );
      }
      await audit(by, "product.request_changes", { vendorId: vendor.id, ip, detail: { productId, title, note, fields: input.fields ?? [], revision: isRevision } }, q);
      await notifyVendor(vendor.id, {
        type: "product",
        title: isRevision ? "Your product edit needs changes" : "Changes needed on your product",
        body: `“${title}”: ${note}${input.fields?.length ? ` (Check: ${input.fields.join(", ")}.)` : ""}${isRevision ? " Your live listing is unchanged." : ""}`,
        link,
      }, q);
      return { status: isNew ? "changes_requested" : "live" };
    }

    // reject
    if (isNew) {
      guard(
        await q(
          `UPDATE vendor_products SET status = 'rejected', rejection_reason = $2, review_notes = $3::jsonb, updated_at = now()
           WHERE id = $1 AND status = 'pending_review' RETURNING id`,
          [productId, note, reviewNotes],
        ),
      );
    } else {
      guard(
        await q(
          `UPDATE vendor_products SET pending_revision = NULL, review_notes = $2::jsonb, updated_at = now()
           WHERE id = $1 AND status = 'live' AND pending_revision IS NOT NULL RETURNING id`,
          [productId, reviewNotes],
        ),
      );
    }
    await audit(by, "product.reject", { vendorId: vendor.id, ip, detail: { productId, title, reason: note, revision: isRevision } }, q);
    await notifyVendor(vendor.id, {
      type: "product",
      title: isRevision ? "Your product edit was declined" : "Your product was not approved",
      body: `“${title}”: ${note}${isRevision ? " Your live listing is unchanged." : ""}`,
      link,
    }, q);
    return { status: isNew ? "rejected" : "live" };
  });
}

export async function bulkApprove(ids: string[], actor: string, ip: string) {
  const results: { id: string; ok: boolean; message?: string }[] = [];
  for (const id of [...new Set(ids)]) {
    try {
      await decideProduct(id, { action: "approve" }, actor, ip);
      results.push({ id, ok: true });
    } catch (err) {
      results.push({ id, ok: false, message: err instanceof ApiError ? err.message : "Could not approve." });
    }
  }
  return results;
}

/* ========================================================= change requests */

export type ChangeRequestItem = {
  id: string;
  vendorId: string;
  storeName: string | null;
  kind: "bank";
  summary: string;
  status: "pending" | "approved" | "rejected";
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  currentBank: string | null;
};

export async function listChangeRequests(): Promise<ChangeRequestItem[]> {
  const rows = await sql<{
    id: string;
    vendor_id: string;
    store_name: string | null;
    kind: "bank";
    summary: string;
    status: ChangeRequestItem["status"];
    decided_by: string | null;
    decided_at: Date | null;
    created_at: Date;
    bank_holder: string | null;
    bank_account_last4: string | null;
    bank_ifsc: string | null;
  }>(
    `SELECT c.id, c.vendor_id, v.store_name, c.kind, c.summary, c.status, c.decided_by, c.decided_at, c.created_at,
            s.bank_holder, s.bank_account_last4, s.bank_ifsc
     FROM vendor_change_requests c JOIN vendors v ON v.id = c.vendor_id LEFT JOIN vendor_secrets s ON s.vendor_id = c.vendor_id
     ORDER BY (c.status = 'pending') DESC, c.created_at DESC LIMIT 100`,
  );
  return rows.map((r) => ({
    id: r.id,
    vendorId: r.vendor_id,
    storeName: r.store_name,
    kind: r.kind,
    summary: r.summary,
    status: r.status,
    decidedBy: r.decided_by,
    decidedAt: iso(r.decided_at),
    createdAt: iso(r.created_at)!,
    currentBank: r.bank_account_last4 ? `${r.bank_holder ?? ""} · ••••${r.bank_account_last4} · ${r.bank_ifsc ?? ""}` : null,
  }));
}

export const changeDecisionSchema = z.object({
  action: z.enum(["approve", "reject"]),
  note: z.string().trim().max(500).optional(),
});

export async function decideChangeRequest(id: string, input: z.infer<typeof changeDecisionSchema>, actor: string, ip: string) {
  if (input.action === "reject" && (input.note ?? "").length < 5) {
    throw new ApiError(400, "invalid", "Some details need fixing.", { note: "Give the seller a reason (5+ characters)." });
  }
  const by = { type: "admin" as const, id: actor };
  await transaction(async (q) => {
    const cr = (
      await q<{ id: string; vendor_id: string; payload_sealed: string; status: string }>(
        "SELECT id, vendor_id, payload_sealed, status FROM vendor_change_requests WHERE id = $1",
        [id],
      )
    )[0];
    if (!cr) throw new ApiError(404, "not_found", "Request not found.");
    if (cr.status !== "pending") throw stale();

    if (input.action === "approve") {
      let payload;
      try {
        payload = bankPayloadSchema.parse(JSON.parse(unseal(cr.payload_sealed)));
      } catch {
        throw new ApiError(422, "bad_payload", "The stored bank details could not be read. Ask the seller to submit again, then reject this one.");
      }
      const last4 = payload.accountNumber.slice(-4);
      await q(
        `INSERT INTO vendor_secrets (vendor_id, bank_holder, bank_account_sealed, bank_account_last4, bank_ifsc, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (vendor_id) DO UPDATE SET bank_holder = EXCLUDED.bank_holder, bank_account_sealed = EXCLUDED.bank_account_sealed,
           bank_account_last4 = EXCLUDED.bank_account_last4, bank_ifsc = EXCLUDED.bank_ifsc, updated_at = now()`,
        [cr.vendor_id, payload.holderName, seal(payload.accountNumber), last4, payload.ifsc],
      );
      await q(
        "UPDATE vendors SET onboarding = onboarding || jsonb_build_object('bank', $2::jsonb), updated_at = now() WHERE id = $1",
        [cr.vendor_id, JSON.stringify({ holderName: payload.holderName, accountLast4: last4, ifsc: payload.ifsc })],
      );
    }
    const done = await q(
      "UPDATE vendor_change_requests SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING id",
      [id, input.action === "approve" ? "approved" : "rejected", actor],
    );
    if (done.length === 0) throw stale();
    await audit(by, input.action === "approve" ? "bank.change_approve" : "bank.change_reject", {
      vendorId: cr.vendor_id,
      ip,
      detail: { requestId: id, note: input.note ?? null },
    }, q);
    await notifyVendor(cr.vendor_id, {
      type: "account",
      title: input.action === "approve" ? "Bank account updated" : "Bank change not approved",
      body:
        input.action === "approve"
          ? "Your new payout account is active. It applies to payouts created from now on."
          : `Your bank change request was declined. ${input.note ?? ""}`.trim(),
      link: "/vendor/dashboard/settings",
    }, q);
  });
}

/* ================================================================ support */

export type TicketItem = {
  id: string;
  vendorId: string;
  storeName: string | null;
  email: string;
  subject: string;
  body: string;
  status: "open" | "answered" | "closed";
  adminReply: string | null;
  repliedBy: string | null;
  repliedAt: string | null;
  createdAt: string;
};

export async function listTickets(filter: "open" | "answered" | "closed" | "all"): Promise<{ items: TicketItem[]; counts: Record<string, number> }> {
  const rows = await sql<{
    id: string;
    vendor_id: string;
    store_name: string | null;
    email: string;
    subject: string;
    body: string;
    status: TicketItem["status"];
    admin_reply: string | null;
    replied_by: string | null;
    replied_at: Date | null;
    created_at: Date;
  }>(
    `SELECT t.id, t.vendor_id, v.store_name, v.email, t.subject, t.body, t.status, t.admin_reply, t.replied_by, t.replied_at, t.created_at
     FROM support_tickets t JOIN vendors v ON v.id = t.vendor_id
     WHERE ($1 = 'all' OR t.status = $1)
     ORDER BY (t.status = 'open') DESC, t.created_at ASC LIMIT 200`,
    [filter],
  );
  const c = await sql<{ status: string; n: string }>("SELECT status, count(*) AS n FROM support_tickets GROUP BY status");
  const counts: Record<string, number> = { open: 0, answered: 0, closed: 0 };
  for (const r of c) counts[r.status] = Number(r.n);
  return {
    counts,
    items: rows.map((r) => ({
      id: r.id,
      vendorId: r.vendor_id,
      storeName: r.store_name,
      email: r.email,
      subject: r.subject,
      body: r.body,
      status: r.status,
      adminReply: r.admin_reply,
      repliedBy: r.replied_by,
      repliedAt: iso(r.replied_at),
      createdAt: iso(r.created_at)!,
    })),
  };
}

export const ticketActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reply"), reply: z.string().trim().min(2, "Write a reply").max(3000) }),
  z.object({ action: z.literal("close") }),
]);

export async function actOnTicket(id: string, input: z.infer<typeof ticketActionSchema>, actor: string, ip: string) {
  const by = { type: "admin" as const, id: actor };
  await transaction(async (q) => {
    const t = (await q<{ vendor_id: string; subject: string; status: string }>("SELECT vendor_id, subject, status FROM support_tickets WHERE id = $1", [id]))[0];
    if (!t) throw new ApiError(404, "not_found", "Ticket not found.");
    if (input.action === "reply") {
      const rows = await q(
        `UPDATE support_tickets SET admin_reply = $2, replied_by = $3, replied_at = now(), status = 'answered'
         WHERE id = $1 AND status IN ('open','answered') RETURNING id`,
        [id, input.reply, actor],
      );
      if (rows.length === 0) throw stale();
      await audit(by, "support.reply", { vendorId: t.vendor_id, ip, detail: { ticketId: id } }, q);
      await notifyVendor(t.vendor_id, {
        type: "support",
        title: "Seller support replied",
        body: `Re: ${t.subject} — ${input.reply}`,
        link: "/vendor/dashboard/support",
      }, q);
    } else {
      const rows = await q("UPDATE support_tickets SET status = 'closed' WHERE id = $1 AND status <> 'closed' RETURNING id", [id]);
      if (rows.length === 0) throw stale();
      await audit(by, "support.close", { vendorId: t.vendor_id, ip, detail: { ticketId: id } }, q);
      await notifyVendor(t.vendor_id, {
        type: "support",
        title: "Your support ticket was closed",
        body: `“${t.subject}” has been closed. Raise a new ticket if you still need help.`,
        link: "/vendor/dashboard/support",
      }, q);
    }
  });
}

/* ================================================================== hub */

/** Queue sizes for the /admin hub. Null when the database is not reachable. */
export async function adminCounts(): Promise<{ kyc: number; products: number; changeRequests: number; tickets: number; refunds: number } | null> {
  try {
    const r = await sqlOne<{ kyc: string; products: string; changes: string; tickets: string; refunds: string }>(
      `SELECT
         (SELECT count(*) FROM vendors WHERE status IN ('submitted','under_review')) AS kyc,
         (SELECT count(*) FROM vendor_products WHERE status = 'pending_review' OR (status = 'live' AND pending_revision IS NOT NULL)) AS products,
         (SELECT count(*) FROM vendor_change_requests WHERE status = 'pending') AS changes,
         (SELECT count(*) FROM support_tickets WHERE status = 'open') AS tickets,
         -- Paid online, a seller has cancelled their part, and no refund has been started yet.
         (SELECT count(*) FROM orders o
           WHERE o.payment_status = 'paid'
             AND EXISTS (SELECT 1 FROM vendor_orders vo WHERE vo.order_id = o.id AND vo.status = 'cancelled')
             AND NOT EXISTS (SELECT 1 FROM refunds rf WHERE rf.order_id = o.id)) AS refunds`,
    );
    return r ? { kyc: Number(r.kyc), products: Number(r.products), changeRequests: Number(r.changes), tickets: Number(r.tickets), refunds: Number(r.refunds) } : null;
  } catch {
    return null;
  }
}
