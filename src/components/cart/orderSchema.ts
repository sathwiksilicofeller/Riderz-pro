/**
 * Delivery details collected at checkout. Shared by the cart form (instant
 * feedback) and POST /api/orders (the check that counts). Client-safe.
 */
import { z } from "@/lib/zod";
import { INDIAN_STATES, mobileSchema, PINCODE_RE } from "@/lib/vendor/validators";
import { pointSchema } from "@/lib/tracking/geo";
import { codeSchema } from "@/lib/coupons/types";

const text = (min: number, max: number, label: string) =>
  z.string().trim().min(min, `${label} is required`).max(max, `${label} must be ${max} characters or fewer`);

export const customerSchema = z.object({
  name: text(2, 80, "Name"),
  mobile: mobileSchema,
  email: z
    .string()
    .trim()
    .max(254)
    .optional()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid email address"),
  address: text(5, 240, "Address"),
  city: text(2, 60, "City"),
  state: z.enum(INDIAN_STATES, { error: "Pick your state" }),
  pincode: z.string().trim().regex(PINCODE_RE, "Enter a 6-digit pincode"),
  notes: z
    .string()
    .trim()
    .max(300, "Notes must be 300 characters or fewer")
    .optional()
    .transform((v) => (v ? v : null)),
});

export const placeOrderSchema = z.object({
  customer: customerSchema,
  lines: z
    .array(
      z.object({
        id: z.string().min(1).max(300),
        qty: z.number().int().min(1).max(99),
        install: z.boolean(),
      }),
    )
    .min(1)
    .max(50),
  /** Online payment (Razorpay) is the only way to order. Required, so an out-of-date page that doesn't send it is refused. */
  paymentMethod: z.literal("online"),
  /** The customer's GPS point from "Detect my location", for the rider map and arrival alerts. */
  deliveryPoint: pointSchema.optional(),
  /** A coupon code; the server checks it and works out the discount. */
  couponCode: codeSchema.optional(),
});

export type PlaceOrderInput = z.output<typeof placeOrderSchema>;
export type CustomerDetails = z.output<typeof customerSchema>;
