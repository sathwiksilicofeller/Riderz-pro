import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import { z } from "@/lib/zod";
import { sql, sqlOne } from "@/lib/db/client";
import { PRODUCT_DETAILS } from "@/lib/store/products";
import type { ProductDetail } from "@/lib/store/types";
import { DEFAULT_COMMISSION_RATE, type VendorOnboarding } from "@/lib/vendor/types";
import { emailSchema, mobileSchema } from "@/lib/vendor/validators";
import { DASHCAM_DEPARTMENT, DASHCAM_GROUP, DEMO_DASHCAMS } from "./demo-dashcams";
import { saveFile } from "./files";
import { ensureStarterCategories } from "./starter-categories";
import { ApiError } from "./http";
import { hashPassword, newId } from "./security";
import { newSlug } from "./vendor-catalogue";
import { audit, type Actor } from "./vendors";

/**
 * THE DEMO STORE — "Indus Enterprises"
 *
 * An approved seller with seat covers and speakers copied from the house catalogue, plus
 * Qubo dashcams (details and photos from quboworld.com, see demo-dashcams.ts), so the
 * offline store screen can be shown without a real seller. Run from
 * /admin/vendors (admin only). Safe to run again: it refreshes the demo products in place
 * (SKUs starting DEMO-, same ids and web addresses) and leaves anything else the seller added alone.
 *
 * An existing "Asha Accessories" demo store (slug asha-accessories) is renamed to
 * Indus Enterprises rather than duplicated.
 *
 * Only public catalogue fields are copied (title, brand, price, MRP, photos, highlights,
 * specs). Dealer prices never leave src/lib/catalog.
 */

export const DEMO_NAME = "Indus Enterprises";
export const DEMO_SLUG = "indus-enterprises";
const OLD_SLUGS = ["asha-accessories"];
const SKU_PREFIX = "DEMO-";
const PER_GROUP = 6;
const IMAGES_PER_PRODUCT = 3;
const DEMO_STOCK = 10;

export const demoStoreSchema = z.object({
  /** Needed only when the demo seller does not exist yet. */
  email: emailSchema.optional(),
  mobile: mobileSchema.optional(),
  /**
   * The demo seller's password. Shorter than real sellers' (passwordSchema) on purpose, so a
   * demo login is easy to type at a stand; only an admin can set it, from /admin/vendors.
   */
  password: z.string().min(5, "Use at least 5 characters").max(128).optional(),
});

type Pick = { detail: ProductDetail; department: "interior" | "multimedia"; group: string };

/** Seat covers and speakers with a fixed price and a real product photo. */
function demoProducts(): Pick[] {
  const ok = (d: ProductDetail) =>
    d.price !== null && d.availability !== "coming-soon" && d.images.some((i) => i.kind === "remote");
  const take = (dept: "interior" | "multimedia", group: string) =>
    PRODUCT_DETAILS.filter((d) => d.department === dept && d.group === group && ok(d))
      .slice(0, PER_GROUP)
      .map((detail) => ({ detail, department: dept, group }));
  return [...take("interior", "seat-covers"), ...take("multimedia", "speakers")];
}

async function imageBytes(src: string): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    if (src.startsWith("/")) {
      const file = path.join(process.cwd(), "public", path.normalize(src).replace(/^([/\\])+/, ""));
      if (!file.startsWith(path.join(process.cwd(), "public"))) return null;
      return new Uint8Array(await fs.readFile(file));
    }
    const url = new URL(src);
    if (url.protocol !== "https:") return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function copyImages(vendorId: string, sources: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const src of sources) {
    if (ids.length >= IMAGES_PER_PRODUCT) break;
    const bytes = await imageBytes(src);
    if (!bytes) continue;
    try {
      const saved = await saveFile(vendorId, "product_image", new File([bytes], path.basename(src.split("?")[0]) || "photo"));
      ids.push(saved.id);
    } catch {
      /* not a JPG/PNG/WebP or too large: skip this photo */
    }
  }
  return ids;
}

const ONBOARDING: VendorOnboarding = {
  store: {
    storeName: DEMO_NAME,
    slug: DEMO_SLUG,
    sellerType: "Retailer",
    description: "Demo store: seat covers, car speakers and Qubo dashcams, shown on the offline store screen.",
    departments: ["interior", "multimedia"],
    brands: [
      { name: "Various", authType: "Authorised" },
      { name: "Qubo (Hero Electronix)", authType: "Authorised" },
    ],
    logoFileId: null,
    bannerFileId: null,
  },
  shipping: {
    pickup: { line1: "Demo address", line2: null, city: "Delhi", state: "Delhi", pincode: "110001" },
    contactPhone: "9000000000",
    handlingDays: 2,
    shipsTo: "pan_india",
    acceptsReturns: true,
    returnWindowDays: 7,
  },
};

/**
 * Tidy imported highlights for the demo: some catalogue rows mix headings ("SPECIFICATIONS")
 * and "Label: value" lines into the highlights. Headings go, label lines become specs,
 * lines too long for a highlight join the description, and repeats are dropped.
 */
function tidy(d: ProductDetail): { highlights: string[]; specs: { label: string; value: string }[]; summary: string | null } {
  const key = (s: string) => s.toLowerCase().replace(/[\s:]+/g, "");
  const specs = d.specs.map((s) => ({ label: s.label.trim(), value: s.value.trim() }));
  const seen = new Set(specs.map((s) => key(`${s.label}${s.value}`)));
  const highlights: string[] = [];
  const long: string[] = [];
  for (const raw of d.highlights) {
    const line = raw.trim();
    if (!line || (/^[A-Z\s&/-]+$/.test(line) && line.length < 30)) continue; // a heading
    const m = line.match(/^([^:]{2,40}?)\s*:\s*(.+)$/);
    const k = key(line);
    if (seen.has(k)) continue;
    seen.add(k);
    if (m && !specs.some((s) => s.label.toLowerCase() === m[1].trim().toLowerCase())) specs.push({ label: m[1].trim(), value: m[2].trim() });
    else if (!m) (line.length <= 140 ? highlights : long).push(line); // long lines read as description
  }
  const summary = [d.summary?.trim(), ...long].filter(Boolean).join("\n\n").slice(0, 1500) || null;
  return { highlights, specs, summary };
}

export type DemoStoreResult = { vendorId: string; slug: string; action: "created" | "renamed" | "refreshed"; products: number; photos: number };

export async function seedDemoStore(input: z.infer<typeof demoStoreSchema>, by: Actor, ip: string): Promise<DemoStoreResult> {
  let vendor = await sqlOne<{ id: string; slug: string | null; onboarding: VendorOnboarding | null }>(
    "SELECT id, slug, onboarding FROM vendors WHERE slug = ANY($1) ORDER BY (slug = $2) DESC LIMIT 1",
    [[DEMO_SLUG, ...OLD_SLUGS], DEMO_SLUG],
  );
  let action: DemoStoreResult["action"];

  if (vendor) {
    action = vendor.slug === DEMO_SLUG ? "refreshed" : "renamed";
    const onboarding: VendorOnboarding = {
      ...ONBOARDING,
      ...(vendor.onboarding ?? {}),
      store: { ...ONBOARDING.store!, ...(vendor.onboarding?.store ?? {}), storeName: DEMO_NAME, slug: DEMO_SLUG },
    };
    await sql(
      `UPDATE vendors SET store_name = $2, slug = $3, onboarding = $4::jsonb, status = 'approved',
              commission_rate = COALESCE(commission_rate, $5), tier = COALESCE(tier, 'standard'),
              approved_at = COALESCE(approved_at, now()), approved_by = COALESCE(approved_by, $6),
              changes_requested = NULL, rejection_reason = NULL, updated_at = now()
        WHERE id = $1`,
      [vendor.id, DEMO_NAME, DEMO_SLUG, JSON.stringify(onboarding), DEFAULT_COMMISSION_RATE, by.id],
    );
    if (input.email) {
      const clash = await sqlOne("SELECT 1 FROM vendors WHERE lower(email) = $1 AND id <> $2", [input.email, vendor.id]);
      if (clash) throw new ApiError(409, "exists", "Another seller already uses this email.", { email: "Another seller already uses this email" });
      await sql("UPDATE vendors SET email = $2, email_verified_at = now(), updated_at = now() WHERE id = $1", [vendor.id, input.email]);
    }
    if (input.mobile) {
      const clash = await sqlOne("SELECT 1 FROM vendors WHERE mobile = $1 AND id <> $2", [input.mobile, vendor.id]);
      if (clash) throw new ApiError(409, "exists", "Another seller already uses this mobile.", { mobile: "Another seller already uses this mobile" });
      await sql("UPDATE vendors SET mobile = $2, mobile_verified_at = now(), updated_at = now() WHERE id = $1", [vendor.id, input.mobile]);
    }
    if (input.password) {
      await sql("UPDATE vendors SET password_hash = $2, updated_at = now() WHERE id = $1", [vendor.id, await hashPassword(input.password)]);
    }
  } else {
    if (!input.email || !input.mobile || !input.password) {
      throw new ApiError(400, "invalid", "The demo seller does not exist yet: give an email, mobile and password for its login.", {
        ...(input.email ? {} : { email: "Required to create the demo seller" }),
        ...(input.mobile ? {} : { mobile: "Required to create the demo seller" }),
        ...(input.password ? {} : { password: "Required to create the demo seller" }),
      });
    }
    const clash = await sqlOne("SELECT 1 FROM vendors WHERE lower(email) = $1 OR mobile = $2", [input.email, input.mobile]);
    if (clash) throw new ApiError(409, "exists", "A seller with this email or mobile already exists.");
    const id = newId("ven");
    await sql(
      `INSERT INTO vendors (id, email, mobile, password_hash, full_name, business_type, status, email_verified_at, mobile_verified_at,
                            store_name, slug, onboarding, current_step, completed_steps, commission_rate, tier,
                            submitted_at, approved_at, approved_by)
       VALUES ($1, $2, $3, $4, $5, 'Proprietorship', 'approved', now(), now(), $6, $7, $8::jsonb, 6, '{1,2,3,4,5,6}',
               $9, 'standard', now(), now(), $10)`,
      [id, input.email, input.mobile, await hashPassword(input.password), `${DEMO_NAME} (demo)`, DEMO_NAME, DEMO_SLUG,
        JSON.stringify(ONBOARDING), DEFAULT_COMMISSION_RATE, by.id],
    );
    vendor = { id, slug: DEMO_SLUG, onboarding: ONBOARDING };
    action = "created";
  }

  // Refresh the demo products in place, by SKU, so their ids and web addresses stay the same (orders
  // and links keep working). The seller's own products are never touched.
  const existing = new Map(
    (
      await sql<{ id: string; sku: string; images: string[] }>("SELECT id, sku, images FROM vendor_products WHERE vendor_id = $1 AND sku LIKE $2", [
        vendor.id,
        `${SKU_PREFIX}%`,
      ])
    ).map((r) => [r.sku, r]),
  );
  const kept = new Set<string>();

  let products = 0;
  let photos = 0;
  const insert = async (
    n: number,
    p: {
      title: string; brand: string; department: string; group: string; mrp: number; price: number;
      summary: string | null; highlights: string[]; specs: { label: string; value: string }[]; fitment: string[]; imageSources: string[];
    },
  ) => {
    const sku = `${SKU_PREFIX}${String(n).padStart(2, "0")}`;
    const images = await copyImages(vendor.id, p.imageSources);
    if (images.length === 0) return; // no photo could be copied: an existing product keeps its old one
    photos += images.length;
    const fields = [
      p.title.slice(0, 120), p.brand.slice(0, 60), p.department, p.group, p.mrp, p.price, DEMO_STOCK, p.summary,
      JSON.stringify(p.highlights.map((h) => h.slice(0, 140)).slice(0, 8)),
      JSON.stringify(p.specs.slice(0, 20).map((s) => ({ label: s.label.slice(0, 40), value: s.value.slice(0, 120) }))),
      JSON.stringify(p.fitment), JSON.stringify(images),
    ];
    const had = existing.get(sku);
    if (had) {
      await sql(
        `UPDATE vendor_products SET title=$2, brand=$3, department=$4, group_slug=$5, mrp=$6, price=$7, stock=$8, summary=$9,
                highlights=$10::jsonb, specs=$11::jsonb, fitment=$12::jsonb, images=$13::jsonb, status='live', pending_revision=NULL,
                updated_at=now()
          WHERE id=$1`,
        [had.id, ...fields],
      );
      // The new photos are in place; the old copies can go.
      if (had.images?.length) await sql("DELETE FROM files WHERE vendor_id = $1 AND id = ANY($2)", [vendor.id, had.images]);
    } else {
      await sql(
        `INSERT INTO vendor_products (id, vendor_id, slug, status, title, brand, department, group_slug, sku, gst_rate, mrp, price,
                                      stock, low_stock_at, part_type, summary, highlights, specs, fitment, images,
                                      submitted_at, approved_at, approved_by)
         VALUES ($1, $2, $3, 'live', $4, $5, $6, $7, $8, 18, $9, $10, $11, 3, 'genuine', $12, $13::jsonb, $14::jsonb, $15::jsonb, $16::jsonb,
                 now(), now(), $17)`,
        [newId("vp"), vendor.id, await newSlug(sql, p.brand, p.title), fields[0], fields[1], fields[2], fields[3], sku, ...fields.slice(4), by.id],
      );
    }
    kept.add(sku);
    products++;
  };

  const picks = demoProducts();
  for (const [i, { detail: d, department, group }] of picks.entries()) {
    const price = d.price!;
    const mrp = Math.max(d.mrp ?? price, price);
    const fitment = d.fitment.length && !d.fitment.includes("universal") ? d.fitment.slice(0, 60) : ["universal"];
    // Model codes tell similar products apart (the shop shows "SAM65 — L-1 Series …").
    const { highlights, specs, summary } = tidy(d);
    const title = d.code && !d.title.toLowerCase().includes(d.code.toLowerCase()) ? `${d.code} — ${d.title}` : d.title;
    await insert(i + 1, {
      title, brand: d.brandName, department, group, mrp, price, summary, highlights, specs, fitment,
      imageSources: d.images.filter((img) => img.kind === "remote").map((img) => img.src),
    });
  }

  // Qubo dashcams: SKUs continue after the catalogue picks; fitment is universal.
  for (const [i, c] of DEMO_DASHCAMS.entries()) {
    await insert(picks.length + i + 1, {
      title: c.title, brand: c.brand, department: DASHCAM_DEPARTMENT, group: DASHCAM_GROUP,
      mrp: Math.max(c.mrp, c.price), price: c.price, summary: c.summary, highlights: c.highlights, specs: c.specs,
      fitment: ["universal"], imageSources: c.images,
    });
  }

  // Demo products that are no longer part of the demo set go, with their photos.
  for (const [sku, row] of existing) {
    if (kept.has(sku)) continue;
    await sql("DELETE FROM vendor_products WHERE id = $1", [row.id]);
    if (row.images?.length) await sql("DELETE FROM files WHERE vendor_id = $1 AND id = ANY($2)", [vendor.id, row.images]);
  }

  // Its shop categories (Seat Cover, Mats › Autoform / GFX Pro, … Car Cover) if it has none yet.
  await ensureStarterCategories(vendor.id, by);
  await audit(by, "demo_store.seed", { vendorId: vendor.id, ip, detail: { action, products, photos } });
  return { vendorId: vendor.id, slug: DEMO_SLUG, action, products, photos };
}
