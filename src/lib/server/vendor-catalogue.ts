import "server-only";

import { z } from "@/lib/zod";
import { sql, transaction, type Query, containsPattern } from "@/lib/db/client";
import { ALL_MODELS } from "@/lib/data/vehicles";
import { ApiError } from "./http";
import { assertOwnFiles } from "./files";
import { newId } from "./security";
import { audit } from "./vendors";
import { assertOwnStoreCategory } from "./store-categories";
import { AWAITING_PAYMENT_SQL } from "./orders";
import {
  ownProduct,
  toVendorProduct,
  type VendorProductRow,
} from "./vendor-products";
import {
  departmentSchema,
  productCommercialSchema,
  productContentSchema,
  productDraftSchema,
  slugify,
} from "@/lib/vendor/validators";
import {
  GST_RATES,
  PART_TYPES,
  PRODUCT_STATUSES,
  type GstRate,
  type VendorProduct,
  type VendorProductCommercial,
  type VendorProductContent,
  type VendorProductStatus,
} from "@/lib/vendor/types";

/**
 * VENDOR CATALOGUE — the rules for a seller's own products.
 * Status moves follow docs/VENDOR_PORTAL.md rule 3. Every function takes the
 * vendor id from the session and only ever touches rows with that vendor_id.
 */

const MODEL_SLUGS = new Set(ALL_MODELS.map((m) => m.slug));
const EDITABLE: VendorProductStatus[] = ["draft", "changes_requested", "rejected"];

/* --------------------------------------------------------------- schemas */

const str = (max: number) => z.string().trim().max(max);

/** Content fields as the form sends them; every one optional so drafts can be incomplete. */
export const contentPatchSchema = z
  .object({
    title: str(120),
    brand: str(60),
    department: departmentSchema,
    groupSlug: str(60),
    partType: z.enum(PART_TYPES),
    hsn: str(8).nullable().transform((v) => (v ? v : null)),
    gstRate: z.number().refine((r) => (GST_RATES as readonly number[]).includes(r), "Pick a GST rate"),
    warrantyMonths: z.number().int().min(0).max(120).nullable(),
    summary: str(1500).nullable().transform((v) => (v ? v : null)),
    highlights: z.array(str(140)).max(8).transform((a) => a.filter(Boolean)),
    specs: z
      .array(z.object({ label: str(40), value: str(120) }))
      .max(20)
      .transform((a) => a.filter((s) => s.label || s.value)),
    fitment: z
      .array(z.string().trim().min(1).max(40))
      .max(60)
      .transform((a) => [...new Set(a)]),
    images: z.array(z.string().min(1).max(60)).max(8),
  })
  .partial()
  .strict();

export type ContentPatch = z.infer<typeof contentPatchSchema>;

export const createProductSchema = z.object({
  content: contentPatchSchema,
  commercial: productCommercialSchema,
  submit: z.boolean().default(false),
  /** The seller's own shop category (Offline Store screen). Not part of the reviewed content. */
  storeCategoryId: z.string().min(1).max(80).nullable().optional(),
});

export const updateProductSchema = z.object({
  content: contentPatchSchema.optional(),
  commercial: productCommercialSchema.optional(),
  submit: z.boolean().optional(),
  storeCategoryId: z.string().min(1).max(80).nullable().optional(),
  /** The stock the form was showing when it loaded, so a sale made meanwhile isn't overwritten. */
  stockWas: z.number().int().min(0).max(100_000).optional(),
});

export const bulkCommercialSchema = z.object({
  items: z
    .array(
      z
        .object({
          id: z.string().min(1).max(80),
          stock: z.number().int().min(0).max(100_000).optional(),
          lowStockAt: z.number().int().min(0).max(10_000).optional(),
          price: z.number().int().min(1).max(10_000_000).optional(),
          mrp: z.number().int().min(1).max(10_000_000).optional(),
          /** The stock the table loaded (see stockAfterEdit). */
          stockWas: z.number().int().min(0).max(100_000).optional(),
        })
        .strict(),
    )
    .min(1)
    .max(200),
});

export const listQuerySchema = z.object({
  status: z.enum(PRODUCT_STATUSES).optional(),
  q: z.string().trim().max(80).optional(),
});

/* --------------------------------------------------------------- helpers */

const DEFAULT_CONTENT: VendorProductContent = {
  title: "",
  brand: "",
  department: "accessories",
  groupSlug: "",
  partType: "aftermarket",
  hsn: null,
  gstRate: 18,
  warrantyMonths: null,
  summary: null,
  highlights: [],
  specs: [],
  fitment: [],
  images: [],
};

function contentOf(r: VendorProductRow): VendorProductContent {
  return {
    title: r.title,
    brand: r.brand,
    department: r.department,
    groupSlug: r.group_slug,
    partType: r.part_type,
    hsn: r.hsn,
    gstRate: r.gst_rate,
    warrantyMonths: r.warranty_months,
    summary: r.summary,
    highlights: r.highlights ?? [],
    specs: r.specs ?? [],
    fitment: r.fitment ?? [],
    images: r.images ?? [],
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Throw a 400 with `fields` from a zod failure. */
function invalid(error: z.ZodError): never {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) fields[issue.path[0]?.toString() ?? "_"] ??= issue.message;
  throw new ApiError(400, "invalid", "Some details need fixing.", fields);
}

function requireComplete(content: VendorProductContent): VendorProductContent {
  const parsed = productContentSchema.safeParse(content);
  if (!parsed.success) invalid(parsed.error);
  return parsed.data as VendorProductContent;
}

function checkFitment(fitment: string[] | undefined) {
  if (!fitment) return;
  const bad = fitment.filter((f) => f !== "universal" && !MODEL_SLUGS.has(f));
  if (bad.length) throw new ApiError(400, "invalid", "Some details need fixing.", { fitment: "Choose vehicles from the list, or universal." });
}

function uniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

const skuTaken = () =>
  new ApiError(409, "sku_taken", "You already have a product with this SKU.", { sku: "You already have a product with this SKU." });

async function assertSkuFree(q: Query, vendorId: string, sku: string, exceptId?: string) {
  const rows = await q<{ id: string }>(
    "SELECT id FROM vendor_products WHERE vendor_id = $1 AND lower(sku) = lower($2) AND ($3::text IS NULL OR id <> $3)",
    [vendorId, sku, exceptId ?? null],
  );
  if (rows.length) throw skuTaken();
}

function randomSuffix(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => (b % 36).toString(36)).join("");
}

export async function newSlug(q: Query, brand: string, title: string): Promise<string> {
  const base = slugify(`${brand} ${title}`) || "product";
  for (let i = 0; i < 5; i++) {
    const slug = `${base}-${randomSuffix()}`;
    if (!(await q("SELECT 1 FROM vendor_products WHERE slug = $1", [slug])).length) return slug;
  }
  throw new ApiError(500, "slug", "Could not create the product. Please try again.");
}

/** Columns a caller may set, mapped to SQL; JSON columns are cast. Names are fixed here, never from input. */
const COLUMN: Record<string, { col: string; json?: boolean }> = {
  title: { col: "title" },
  brand: { col: "brand" },
  department: { col: "department" },
  groupSlug: { col: "group_slug" },
  partType: { col: "part_type" },
  hsn: { col: "hsn" },
  gstRate: { col: "gst_rate" },
  warrantyMonths: { col: "warranty_months" },
  summary: { col: "summary" },
  highlights: { col: "highlights", json: true },
  specs: { col: "specs", json: true },
  fitment: { col: "fitment", json: true },
  images: { col: "images", json: true },
  sku: { col: "sku" },
  mrp: { col: "mrp" },
  price: { col: "price" },
  stock: { col: "stock" },
  lowStockAt: { col: "low_stock_at" },
  status: { col: "status" },
  pendingRevision: { col: "pending_revision", json: true },
  reviewNotes: { col: "review_notes", json: true },
  rejectionReason: { col: "rejection_reason" },
  submittedAt: { col: "submitted_at" },
  storeCategoryId: { col: "store_category_id" },
};

async function updateRow(q: Query, vendorId: string, id: string, set: Record<string, unknown>): Promise<VendorProductRow> {
  const params: unknown[] = [];
  const parts: string[] = [];
  for (const [key, value] of Object.entries(set)) {
    const c = COLUMN[key];
    if (!c) throw new Error(`unknown column ${key}`);
    params.push(c.json ? (value === null ? null : JSON.stringify(value)) : value);
    parts.push(`${c.col} = $${params.length}${c.json ? "::jsonb" : ""}`);
  }
  parts.push("updated_at = now()");
  params.push(id, vendorId);
  const rows = await q<VendorProductRow>(
    `UPDATE vendor_products SET ${parts.join(", ")} WHERE id = $${params.length - 1} AND vendor_id = $${params.length} RETURNING *`,
    params,
  );
  if (!rows[0]) throw new ApiError(404, "not_found", "Product not found.");
  return rows[0];
}

async function mustOwn(q: Query, vendorId: string, id: string, lock = false): Promise<VendorProductRow> {
  const row = lock
    ? ((await q<VendorProductRow>("SELECT * FROM vendor_products WHERE id = $1 AND vendor_id = $2 FOR UPDATE", [id, vendorId]))[0] ?? null)
    : await ownProduct(vendorId, id, q);
  if (!row) throw new ApiError(404, "not_found", "Product not found.");
  return row;
}

/* ------------------------------------------------------------------ reads */

export async function listProducts(vendorId: string, filter: z.infer<typeof listQuerySchema>): Promise<VendorProduct[]> {
  const params: unknown[] = [vendorId];
  let where = "vendor_id = $1";
  if (filter.status) {
    params.push(filter.status);
    where += ` AND status = $${params.length}`;
  }
  if (filter.q) {
    params.push(containsPattern(filter.q));
    where += ` AND (title ILIKE $${params.length} OR sku ILIKE $${params.length} OR brand ILIKE $${params.length})`;
  }
  const rows = await sql<VendorProductRow>(
    `SELECT * FROM vendor_products WHERE ${where} ORDER BY updated_at DESC LIMIT 500`,
    params,
  );
  return rows.map(toVendorProduct);
}

export async function getProduct(vendorId: string, id: string): Promise<VendorProduct | null> {
  const row = await ownProduct(vendorId, id);
  return row ? toVendorProduct(row) : null;
}

/* ----------------------------------------------------------------- create */

export async function createProduct(
  vendorId: string,
  input: z.infer<typeof createProductSchema>,
): Promise<VendorProduct> {
  const draft = productDraftSchema.safeParse({ title: input.content.title ?? "", sku: input.commercial.sku });
  if (!draft.success) invalid(draft.error);
  checkFitment(input.content.fitment);
  if (input.content.images?.length) await assertOwnFiles(vendorId, input.content.images, ["product_image"]);
  await assertOwnStoreCategory(vendorId, input.storeCategoryId);

  const content: VendorProductContent = { ...DEFAULT_CONTENT, ...input.content } as VendorProductContent;
  const finalContent = input.submit ? requireComplete(content) : content;

  try {
    return await transaction(async (q) => {
      await assertSkuFree(q, vendorId, input.commercial.sku);
      const id = newId("prd");
      const slug = await newSlug(q, finalContent.brand, finalContent.title);
      const c = input.commercial;
      const rows = await q<VendorProductRow>(
        `INSERT INTO vendor_products
           (id, vendor_id, slug, status, title, brand, department, group_slug, sku, hsn, gst_rate, mrp, price, stock,
            low_stock_at, part_type, warranty_months, summary, highlights, specs, fitment, images, submitted_at, store_category_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,
                 CASE WHEN $4 = 'pending_review' THEN now() ELSE NULL END, $23)
         RETURNING *`,
        [
          id, vendorId, slug, input.submit ? "pending_review" : "draft", finalContent.title, finalContent.brand,
          finalContent.department, finalContent.groupSlug, c.sku, finalContent.hsn, finalContent.gstRate, c.mrp, c.price,
          c.stock, c.lowStockAt, finalContent.partType, finalContent.warrantyMonths, finalContent.summary,
          JSON.stringify(finalContent.highlights), JSON.stringify(finalContent.specs),
          JSON.stringify(finalContent.fitment), JSON.stringify(finalContent.images), input.storeCategoryId ?? null,
        ],
      );
      await audit({ type: "vendor", id: vendorId }, input.submit ? "product.submit" : "product.create", { vendorId, detail: { productId: id } }, q);
      return toVendorProduct(rows[0]);
    });
  } catch (err) {
    if (uniqueViolation(err)) throw skuTaken();
    throw err;
  }
}

/* ----------------------------------------------------------------- update */

export async function updateProduct(
  vendorId: string,
  id: string,
  input: z.infer<typeof updateProductSchema>,
): Promise<VendorProduct> {
  checkFitment(input.content?.fitment);
  if (input.content?.images?.length) await assertOwnFiles(vendorId, input.content.images, ["product_image"]);
  await assertOwnStoreCategory(vendorId, input.storeCategoryId);

  try {
    return await transaction(async (q) => {
      const row = await mustOwn(q, vendorId, id, true);
      const set: Record<string, unknown> = {};
      let action = "update";

      if (row.status === "archived") {
        throw new ApiError(409, "archived", "This product is archived. Restore it before editing.");
      }

      const current = contentOf(row);
      const patch = input.content ?? {};
      const contentChanged = Object.entries(patch).some(([k, v]) => !same(v, current[k as keyof VendorProductContent]));

      if (input.commercial) {
        const c = input.commercial;
        if (c.sku.toLowerCase() !== row.sku.toLowerCase()) await assertSkuFree(q, vendorId, c.sku, row.id);
        Object.assign(set, { sku: c.sku, mrp: c.mrp, price: c.price, lowStockAt: c.lowStockAt });
        const stock = stockAfterEdit(row, c.stock, input.stockWas, "stock");
        if (stock !== row.stock) set.stock = stock;
      }
      // The shop category only arranges the seller's own screen, so it changes straight away, in any status.
      if (input.storeCategoryId !== undefined && input.storeCategoryId !== row.store_category_id) {
        set.storeCategoryId = input.storeCategoryId;
      }

      if (row.status === "pending_review") {
        if (contentChanged) {
          throw new ApiError(409, "waiting_for_review", "This product is waiting for review. Its details can be edited once the review is done.");
        }
      } else if (row.status === "live") {
        if (input.content) {
          const base = row.pending_revision ?? current;
          const merged = { ...base, ...patch } as VendorProductContent;
          if (same(merged, current)) {
            if (row.pending_revision) set.pendingRevision = null;
          } else if (!row.pending_revision || !same(merged, row.pending_revision)) {
            set.pendingRevision = requireComplete(merged);
            set.submittedAt = new Date().toISOString();
            action = "revision";
          }
        }
      } else if (EDITABLE.includes(row.status)) {
        const merged = { ...current, ...patch } as VendorProductContent;
        Object.assign(set, patch);
        if (input.submit) {
          requireComplete(merged);
          Object.assign(set, {
            status: "pending_review",
            submittedAt: new Date().toISOString(),
            reviewNotes: null,
            rejectionReason: null,
          });
          action = "submit";
        }
      }

      if (Object.keys(set).length === 0) return toVendorProduct(row);
      const updated = await updateRow(q, vendorId, id, set);
      await audit({ type: "vendor", id: vendorId }, `product.${action}`, { vendorId, detail: { productId: id } }, q);
      return toVendorProduct(updated);
    });
  } catch (err) {
    if (uniqueViolation(err)) throw skuTaken();
    throw err;
  }
}

/* ------------------------------------------------------ archive / delete */

export async function archiveProduct(vendorId: string, id: string): Promise<VendorProduct> {
  return transaction(async (q) => {
    const row = await mustOwn(q, vendorId, id);
    if (row.status === "archived") return toVendorProduct(row);
    if (row.status === "pending_review") {
      throw new ApiError(409, "waiting_for_review", "This product is waiting for review and cannot be archived yet.");
    }
    const updated = await updateRow(q, vendorId, id, { status: "archived", pendingRevision: null });
    await audit({ type: "vendor", id: vendorId }, "product.archive", { vendorId, detail: { productId: id } }, q);
    return toVendorProduct(updated);
  });
}

export async function unarchiveProduct(vendorId: string, id: string): Promise<VendorProduct> {
  return transaction(async (q) => {
    const row = await mustOwn(q, vendorId, id);
    if (row.status !== "archived") throw new ApiError(409, "not_archived", "This product is not archived.");
    const updated = await updateRow(q, vendorId, id, { status: "draft", reviewNotes: null, rejectionReason: null });
    await audit({ type: "vendor", id: vendorId }, "product.unarchive", { vendorId, detail: { productId: id } }, q);
    return toVendorProduct(updated);
  });
}

/**
 * Deletes one of the seller's products for good, in any status: the shop owner manages their
 * own catalogue. Past orders keep their own copy of the title, price, HSN, GST rate and warranty
 * (order_items, migration 018), so their invoices and receipts are untouched. Its photos go too, unless another of the seller's products still uses them.
 */
export async function deleteProduct(vendorId: string, id: string): Promise<void> {
  await transaction(async (q) => {
    const row = await mustOwn(q, vendorId, id);
    const photos = [...new Set([...(row.images ?? []), ...(row.pending_revision?.images ?? [])])];
    await q("DELETE FROM vendor_products WHERE id = $1 AND vendor_id = $2", [id, vendorId]);
    if (photos.length) {
      await q(
        `DELETE FROM files f
          WHERE f.id = ANY($1) AND f.vendor_id = $2 AND f.kind = 'product_image'
            AND NOT EXISTS (
              SELECT 1 FROM vendor_products p
               WHERE p.vendor_id = $2 AND (p.images ? f.id OR coalesce(p.pending_revision->'images', '[]'::jsonb) ? f.id))`,
        [photos, vendorId],
      );
    }
    await audit({ type: "vendor", id: vendorId }, "product.delete", { vendorId, detail: { productId: id, sku: row.sku, status: row.status } }, q);
  });
}

export async function duplicateProduct(vendorId: string, id: string): Promise<VendorProduct> {
  return transaction(async (q) => {
    const row = await mustOwn(q, vendorId, id);
    let sku = `${row.sku.slice(0, 35)}-copy`;
    for (let n = 2; (await q("SELECT 1 FROM vendor_products WHERE vendor_id = $1 AND lower(sku) = lower($2)", [vendorId, sku])).length; n++) {
      sku = `${row.sku.slice(0, 33)}-copy${n}`;
    }
    const slug = await newSlug(q, row.brand, row.title);
    const copyId = newId("prd");
    const c = contentOf(row);
    const rows = await q<VendorProductRow>(
      `INSERT INTO vendor_products
         (id, vendor_id, slug, status, title, brand, department, group_slug, sku, hsn, gst_rate, mrp, price, stock,
          low_stock_at, part_type, warranty_months, summary, highlights, specs, fitment, images, store_category_id)
       VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,0,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21)
       RETURNING *`,
      [
        copyId, vendorId, slug, c.title, c.brand, c.department, c.groupSlug, sku, c.hsn, c.gstRate, row.mrp, row.price,
        row.low_stock_at, c.partType, c.warrantyMonths, c.summary, JSON.stringify(c.highlights), JSON.stringify(c.specs),
        JSON.stringify(c.fitment), JSON.stringify(c.images), row.store_category_id,
      ],
    );
    await audit({ type: "vendor", id: vendorId }, "product.duplicate", { vendorId, detail: { productId: copyId, from: id } }, q);
    return toVendorProduct(rows[0]);
  });
}

/* ------------------------------------------------------------------- bulk */

/**
 * The stock to save when a seller's form says `wanted`. Sales on the shop screen or the website can
 * change stock while the form is open, so with `was` (what the form loaded): an untouched stock
 * box keeps today's stock, and a changed one is refused if stock moved underneath it.
 */
function stockAfterEdit(row: VendorProductRow, wanted: number, was: number | undefined, field: string): number {
  if (was === undefined) return wanted;
  if (wanted === was) return row.stock;
  if (row.stock !== was) {
    const msg = `Stock changed to ${row.stock} (a sale or another edit) since you opened this. Check it and save again.`;
    throw new ApiError(409, "stock_changed", msg, { stock: msg, [field]: msg });
  }
  return wanted;
}

export async function bulkCommercial(
  vendorId: string,
  items: z.infer<typeof bulkCommercialSchema>["items"],
): Promise<VendorProduct[]> {
  return transaction(async (q) => {
    const out: VendorProduct[] = [];
    for (const item of items) {
      const row = await mustOwn(q, vendorId, item.id, true);
      if (row.status === "archived") {
        throw new ApiError(409, "archived", "Archived products cannot be changed.", { [item.id]: "This product is archived." });
      }
      const mrp = item.mrp ?? row.mrp;
      const price = item.price ?? row.price;
      if (price > mrp) {
        throw new ApiError(400, "invalid", "Selling price cannot be above MRP.", { [item.id]: "Selling price cannot be above MRP." });
      }
      const set: Record<string, unknown> = {};
      if (item.mrp !== undefined) set.mrp = mrp;
      if (item.price !== undefined) set.price = price;
      if (item.stock !== undefined) {
        const stock = stockAfterEdit(row, item.stock, item.stockWas, item.id);
        if (stock !== row.stock) set.stock = stock;
      }
      if (item.lowStockAt !== undefined) set.lowStockAt = item.lowStockAt;
      if (Object.keys(set).length === 0) {
        out.push(toVendorProduct(row));
        continue;
      }
      const updated = await updateRow(q, vendorId, item.id, set);
      await audit({ type: "vendor", id: vendorId }, "product.commercial", { vendorId, detail: { productId: item.id, ...set } }, q);
      out.push(toVendorProduct(updated));
    }
    return out;
  });
}

/* --------------------------------------------------------------- overview */

export type VendorOverview = {
  kpis: {
    newOrders: number;
    ordersInProgress: number;
    deliveredSales30d: number;
    productsLive: number;
    productsPending: number;
    productsChangesRequested: number;
    lowStock: number;
    outOfStock: number;
    commissionRate: number | null;
  };
  recentOrders: { id: string; number: string; status: string; subtotal: number; createdAt: string }[];
  attention: { id: string; title: string; sku: string; reason: string }[];
};

export async function vendorOverview(vendorId: string, commissionRate: number | null): Promise<VendorOverview> {
  const [orders] = await sql<Record<string, string | null>>(
    `SELECT
       count(*) FILTER (WHERE vo.status = 'new') AS new_orders,
       count(*) FILTER (WHERE vo.status IN ('accepted','packed','shipped')) AS in_progress,
       COALESCE(sum(vo.subtotal) FILTER (WHERE vo.status = 'delivered' AND vo.delivered_at >= now() - interval '30 days'), 0) AS sales
     FROM vendor_orders vo JOIN orders o ON o.id = vo.order_id
     WHERE vo.vendor_id = $1 AND NOT ${AWAITING_PAYMENT_SQL}`,
    [vendorId],
  );
  const [products] = await sql<Record<string, string | null>>(
    `SELECT
       count(*) FILTER (WHERE status = 'live') AS live,
       count(*) FILTER (WHERE status = 'pending_review') AS pending,
       count(*) FILTER (WHERE status = 'changes_requested') AS changes,
       count(*) FILTER (WHERE status = 'live' AND stock <= low_stock_at) AS low,
       count(*) FILTER (WHERE status = 'live' AND stock = 0) AS out
     FROM vendor_products WHERE vendor_id = $1`,
    [vendorId],
  );
  const recent = await sql<{ id: string; number: string; status: string; subtotal: number; created_at: Date }>(
    `SELECT vo.id, o.number, vo.status, vo.subtotal, vo.created_at
     FROM vendor_orders vo JOIN orders o ON o.id = vo.order_id
     WHERE vo.vendor_id = $1 AND NOT ${AWAITING_PAYMENT_SQL} ORDER BY vo.created_at DESC LIMIT 5`,
    [vendorId],
  );
  const attention = await sql<{ id: string; title: string; sku: string; status: string; stock: number }>(
    `SELECT id, title, sku, status, stock FROM vendor_products
     WHERE vendor_id = $1 AND (status = 'changes_requested' OR (status = 'live' AND stock <= low_stock_at))
     ORDER BY (status = 'changes_requested') DESC, stock ASC LIMIT 6`,
    [vendorId],
  );
  const n = (v: string | null | undefined) => Number(v ?? 0);
  return {
    kpis: {
      newOrders: n(orders?.new_orders),
      ordersInProgress: n(orders?.in_progress),
      deliveredSales30d: n(orders?.sales),
      productsLive: n(products?.live),
      productsPending: n(products?.pending),
      productsChangesRequested: n(products?.changes),
      lowStock: n(products?.low),
      outOfStock: n(products?.out),
      commissionRate,
    },
    recentOrders: recent.map((r) => ({
      id: r.id,
      number: r.number,
      status: r.status,
      subtotal: Number(r.subtotal),
      createdAt: new Date(r.created_at).toISOString(),
    })),
    attention: attention.map((a) => ({
      id: a.id,
      title: a.title,
      sku: a.sku,
      reason: a.status === "changes_requested" ? "Changes requested" : a.stock === 0 ? "Out of stock" : `Low stock (${a.stock} left)`,
    })),
  };
}

export type { GstRate, VendorProductCommercial };
