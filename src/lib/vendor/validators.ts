/**
 * VENDOR VALIDATION
 *
 * Format checks for Indian business identifiers and the zod schemas every
 * vendor API route parses its input with. The same schemas run in the browser
 * (instant feedback) and on the server (the only check that counts).
 *
 * These are FORMAT checks: a GSTIN with a valid checksum is not proof the
 * business is registered. The admin KYC review verifies documents by hand.
 *
 * No secrets, no database: client components may import this file.
 */

import { z } from "@/lib/zod";
import { DEPARTMENTS, type DepartmentSlug } from "@/lib/data/taxonomy";
import {
  BRAND_AUTH_TYPES,
  BUSINESS_TYPES,
  DOCUMENT_KINDS,
  GST_RATES,
  ID_TYPES,
  type GstRate,
  PART_TYPES,
  SELLER_TYPES,
} from "./types";

/* ------------------------------------------------------------ identifiers */

const GST_CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** The 15th GSTIN character: the checksum of the first 14 (base 36, weights 1,2,1,2…). */
export function gstinCheckChar(first14: string): string | null {
  if (first14.length !== 14) return null;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = GST_CHARSET.indexOf(first14[i]);
    if (v === -1) return null;
    const p = v * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return GST_CHARSET[(36 - (sum % 36)) % 36];
}

/** GST state codes 01–38 and 97 (other territory). */
const GST_STATE_CODES = new Set([
  ...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, "0")),
  "97",
]);

export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const MOBILE_RE = /^[6-9][0-9]{9}$/;
export const PINCODE_RE = /^[1-9][0-9]{5}$/;

export function normaliseId(value: string): string {
  return value.replace(/\s+/g, "").toUpperCase();
}

/** Indian mobile without +91, spaces or a leading 0. */
export function normaliseMobile(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export function gstinProblem(raw: string): string | null {
  const g = normaliseId(raw);
  if (g.length !== 15) return "A GSTIN has 15 characters.";
  if (!GSTIN_RE.test(g)) return "That is not a valid GSTIN format.";
  if (!GST_STATE_CODES.has(g.slice(0, 2))) return "The first two digits are not a GST state code.";
  if (gstinCheckChar(g.slice(0, 14)) !== g[14]) return "The last character does not match — check for a typo.";
  return null;
}

/** PAN is characters 3–12 of a GSTIN. */
export const panFromGstin = (gstin: string) => normaliseId(gstin).slice(2, 12);

export const last4 = (value: string) => value.slice(-4);

/** "XXXXXX1234" */
export const maskTail = (last: string, length = 10) => `${"X".repeat(Math.max(0, length - last.length))}${last}`;

/* --------------------------------------------------------------- schemas */

const trimmed = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`);

export const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address").max(254);

export const mobileSchema = z
  .string()
  .transform(normaliseMobile)
  .refine((m) => MOBILE_RE.test(m), "Enter a 10-digit Indian mobile number");

export const passwordSchema = z
  .string()
  .min(10, "Use at least 10 characters")
  .max(128, "Use 128 characters or fewer")
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), "Use letters and numbers");

export const signUpSchema = z.object({
  fullName: trimmed(2, 80, "Full name"),
  businessType: z.enum(BUSINESS_TYPES),
  email: emailSchema,
  mobile: mobileSchema,
  password: passwordSchema,
  acceptTerms: z.literal(true, { error: "Accept the seller terms to continue" }),
});

export const signInSchema = z.object({
  /** Email or mobile. */
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
});

export const otpSchema = z.object({
  channel: z.enum(["email", "mobile"]),
  code: z.string().regex(/^[0-9]{6}$/, "Enter the 6-digit code"),
});

const departmentSlugs = DEPARTMENTS.map((d) => d.slug) as [DepartmentSlug, ...DepartmentSlug[]];
export const departmentSchema = z.enum(departmentSlugs);

/** A department + group pair that exists in the taxonomy. */
export function groupExists(department: DepartmentSlug, group: string): boolean {
  return DEPARTMENTS.find((d) => d.slug === department)?.groups.some((g) => g.slug === group) ?? false;
}

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Use at least 3 characters")
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and single hyphens");

/** Lowercase, hyphenated, ASCII. */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}

export const taxStepSchema = z
  .object({
    gstExempt: z.boolean(),
    gstin: z.string().nullable(),
    legalName: trimmed(2, 120, "Legal name"),
    tradeName: z.string().trim().max(120).nullable(),
    /** Required when there is no GSTIN; otherwise derived from it. */
    pan: z.string().nullable(),
    idType: z.enum(ID_TYPES),
    idLast4: z.string().trim().regex(/^[A-Z0-9]{4}$/i, "Enter the last 4 characters of the ID"),
  })
  .superRefine((v, ctx) => {
    if (!v.gstExempt) {
      const problem = v.gstin ? gstinProblem(v.gstin) : "GSTIN is required";
      if (problem) ctx.addIssue({ code: "custom", path: ["gstin"], message: problem });
    } else if (!v.pan || !PAN_RE.test(normaliseId(v.pan))) {
      ctx.addIssue({ code: "custom", path: ["pan"], message: "Enter a valid 10-character PAN" });
    }
  });

export const storeStepSchema = z.object({
  storeName: trimmed(3, 60, "Store name"),
  slug: slugSchema,
  sellerType: z.enum(SELLER_TYPES),
  description: trimmed(20, 600, "Store description"),
  departments: z.array(departmentSchema).min(1, "Pick at least one department").max(8),
  brands: z
    .array(z.object({ name: trimmed(1, 60, "Brand"), authType: z.enum(BRAND_AUTH_TYPES) }))
    .min(1, "Add at least one brand you sell")
    .max(30),
  logoFileId: z.string().nullable(),
  bannerFileId: z.string().nullable(),
});

export const INDIAN_STATES = [
  "Andaman and Nicobar Islands", "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chandigarh",
  "Chhattisgarh", "Dadra and Nagar Haveli and Daman and Diu", "Delhi", "Goa", "Gujarat", "Haryana",
  "Himachal Pradesh", "Jammu and Kashmir", "Jharkhand", "Karnataka", "Kerala", "Ladakh", "Lakshadweep",
  "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Puducherry",
  "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
  "West Bengal",
] as const;

export const addressSchema = z.object({
  line1: trimmed(3, 120, "Address"),
  line2: z.string().trim().max(120).nullable(),
  city: trimmed(2, 60, "City"),
  state: z.enum(INDIAN_STATES),
  pincode: z.string().trim().regex(PINCODE_RE, "Enter a 6-digit pincode"),
});

export const shippingStepSchema = z.object({
  pickup: addressSchema,
  contactPhone: mobileSchema,
  handlingDays: z.number().int().min(0).max(10),
  shipsTo: z.enum(["pan_india", "own_state"]),
  acceptsReturns: z.boolean(),
  returnWindowDays: z.number().int().min(0).max(30),
});

export const bankStepSchema = z
  .object({
    holderName: trimmed(2, 100, "Account holder name"),
    accountNumber: z.string().regex(/^[0-9]{9,18}$/, "Account numbers are 9 to 18 digits"),
    confirmAccountNumber: z.string(),
    ifsc: z
      .string()
      .transform(normaliseId)
      .refine((v) => IFSC_RE.test(v), "Enter a valid 11-character IFSC"),
  })
  .refine((v) => v.accountNumber === v.confirmAccountNumber, {
    path: ["confirmAccountNumber"],
    message: "Account numbers do not match",
  });

export const documentsStepSchema = z.object({
  files: z
    .array(z.object({ kind: z.enum(DOCUMENT_KINDS), fileId: z.string().min(1), name: trimmed(1, 120, "File name") }))
    .max(10),
  signatoryName: trimmed(2, 100, "Signatory name"),
  acceptAgreement: z.literal(true, { error: "Accept the seller agreement to submit" }),
});

/** Documents an application must include before it can be submitted. */
export function requiredDocuments(gstExempt: boolean): (typeof DOCUMENT_KINDS)[number][] {
  return gstExempt ? ["doc_pan", "doc_cheque"] : ["doc_pan", "doc_gst", "doc_cheque"];
}

/* --------------------------------------------------------------- product */

export const productContentSchema = z
  .object({
    title: trimmed(5, 120, "Title"),
    brand: trimmed(1, 60, "Brand"),
    department: departmentSchema,
    groupSlug: z.string().min(1),
    partType: z.enum(PART_TYPES),
    hsn: z
      .string()
      .trim()
      .regex(/^[0-9]{4}([0-9]{2}){0,2}$/, "HSN codes are 4, 6 or 8 digits")
      .nullable(),
    gstRate: z
      .number()
      .refine((r): r is GstRate => (GST_RATES as readonly number[]).includes(r), "Pick a GST rate"),
    warrantyMonths: z.number().int().min(0).max(120).nullable(),
    summary: z.string().trim().max(1500).nullable(),
    highlights: z.array(trimmed(2, 140, "Highlight")).max(8),
    specs: z.array(z.object({ label: trimmed(1, 40, "Spec name"), value: trimmed(1, 120, "Spec value") })).max(20),
    fitment: z.array(z.string().min(1).max(40)).min(1, "Say which vehicles it fits, or choose universal").max(60),
    images: z.array(z.string().min(1)).min(1, "Add at least one photo").max(8),
  })
  .superRefine((v, ctx) => {
    if (!groupExists(v.department, v.groupSlug)) {
      ctx.addIssue({ code: "custom", path: ["groupSlug"], message: "Pick a category in this department" });
    }
    if (v.fitment.includes("universal") && v.fitment.length > 1) {
      ctx.addIssue({ code: "custom", path: ["fitment"], message: "Universal products should not list models too" });
    }
  });

export const skuSchema = z
  .string()
  .trim()
  .min(1, "SKU is required")
  .max(40)
  .regex(/^[A-Za-z0-9._/-]+$/, "Use letters, numbers and . _ / - only");

export const productCommercialSchema = z
  .object({
    sku: skuSchema,
    mrp: z.number().int().min(1).max(10_000_000),
    price: z.number().int().min(1).max(10_000_000),
    stock: z.number().int().min(0).max(100_000),
    lowStockAt: z.number().int().min(0).max(10_000),
  })
  .refine((v) => v.price <= v.mrp, { path: ["price"], message: "Selling price cannot be above MRP" });

/** Draft products may be saved incomplete; only these fields are required. */
export const productDraftSchema = z.object({
  title: trimmed(1, 120, "Title"),
  sku: skuSchema,
});
