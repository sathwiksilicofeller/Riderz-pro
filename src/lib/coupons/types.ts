/**
 * Coupons. Client-safe (checkout, /offers and the admin page use it); the server rules are in
 * src/lib/server/coupons.ts.
 *
 * A coupon lowers Riderzpro's own part of an order only: its products and installation (percent or
 * flat), or the delivery charge (free_shipping). Marketplace sellers' items keep their price.
 * Amounts are integer rupees.
 */
import { z } from "@/lib/zod";

export const COUPON_KINDS = ["percent", "flat", "free_shipping"] as const;
export type CouponKind = (typeof COUPON_KINDS)[number];

export const COUPON_KIND_LABELS: Record<CouponKind, string> = {
  percent: "% off",
  flat: "₹ off",
  free_shipping: "Free delivery",
};

/** Codes are stored upper case without spaces: "save 10" → "SAVE10". */
export const normaliseCode = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const codeSchema = z
  .string()
  .max(40)
  .transform(normaliseCode)
  .refine((v) => /^[A-Z0-9]{3,20}$/.test(v), "Codes are 3 to 20 letters or numbers");

/** What a coupon gives, in words: "10% off (up to ₹500)", "₹200 off", "Free delivery". */
export function couponOffer(c: { kind: CouponKind; value: number; maxDiscount: number | null }): string {
  const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
  if (c.kind === "percent") return `${c.value}% off${c.maxDiscount ? ` (up to ${inr(c.maxDiscount)})` : ""}`;
  if (c.kind === "flat") return `${inr(c.value)} off`;
  return "Free delivery";
}

/** A coupon as shoppers see it on /offers. */
export type PublicCoupon = {
  code: string;
  title: string;
  description: string | null;
  kind: CouponKind;
  value: number;
  maxDiscount: number | null;
  minOrder: number;
  endsAt: string | null;
};

/** A coupon as the admin page sees it. */
export type AdminCoupon = PublicCoupon & {
  id: string;
  startsAt: string | null;
  usageLimit: number | null;
  perCustomer: number;
  public: boolean;
  status: "active" | "paused" | "ended";
  used: number;
  discountGiven: number;
  createdBy: string;
  createdAt: string;
};

/** The answer to "apply this code" at checkout. */
export type CouponQuote = {
  code: string;
  title: string;
  discount: number;
  freeShipping: boolean;
  subtotal: number;
  shipping: number;
  total: number;
};

const optDate = z
  .string()
  .trim()
  .max(40)
  .optional()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || !Number.isNaN(Date.parse(v)), "Enter a valid date");
const optInt = (max: number) => z.number().int().min(1).max(max).nullable().optional().transform((v) => v ?? null);

export const couponInputSchema = z
  .object({
    code: codeSchema,
    title: z.string().trim().min(3, "Title is required").max(80),
    description: z.string().trim().max(300).optional().transform((v) => v || null),
    kind: z.enum(COUPON_KINDS),
    value: z.number().int().min(0).max(100_000),
    maxDiscount: optInt(100_000),
    minOrder: z.number().int().min(0).max(1_000_000).default(0),
    startsAt: optDate,
    endsAt: optDate,
    usageLimit: optInt(1_000_000),
    perCustomer: z.number().int().min(1).max(100).default(1),
    public: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "percent" && (v.value < 1 || v.value > 90)) ctx.addIssue({ code: "custom", path: ["value"], message: "Use 1 to 90 percent" });
    if (v.kind === "flat" && v.value < 1) ctx.addIssue({ code: "custom", path: ["value"], message: "Enter the rupees off" });
    if (v.startsAt && v.endsAt && Date.parse(v.endsAt) <= Date.parse(v.startsAt)) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "The end must be after the start" });
  });
export type CouponInput = z.output<typeof couponInputSchema>;

export const couponActionSchema = z.object({ action: z.enum(["pause", "resume", "end", "public", "private"]) });
