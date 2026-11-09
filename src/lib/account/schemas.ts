/**
 * Customer account input checks. Shared by the account pages (instant feedback) and the
 * /api/account routes (the check that counts). Client-safe.
 */
import { z } from "@/lib/zod";
import { MEDIA, type MediaKey } from "@/lib/media";
import { INDIAN_STATES, MOBILE_RE, PINCODE_RE, emailSchema, mobileSchema, normaliseMobile } from "@/lib/vendor/validators";

const text = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .min(min, `${label} is too short`)
    .max(max, `${label} must be ${max} characters or fewer`);

/** A mobile number or an email address, as typed in the sign-in box. */
export type Identifier = { channel: "mobile" | "email"; target: string };

export const identifierSchema = z
  .string()
  .trim()
  .min(1, "Enter your mobile number or email")
  .max(254, "That is too long")
  .transform((raw, ctx): Identifier => {
    if (raw.includes("@")) {
      const email = emailSchema.safeParse(raw);
      if (email.success) return { channel: "email", target: email.data };
      ctx.addIssue({ code: "custom", message: "Enter a valid email address" });
      return z.NEVER;
    }
    const mobile = normaliseMobile(raw);
    if (MOBILE_RE.test(mobile)) return { channel: "mobile", target: mobile };
    ctx.addIssue({ code: "custom", message: "Enter a 10-digit Indian mobile number or an email" });
    return z.NEVER;
  });

export const codeSchema = z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code");

export const sendCodeSchema = z.object({ identifier: identifierSchema });
export const verifyCodeSchema = z.object({ identifier: identifierSchema, code: codeSchema });

export const profileSchema = z.object({ name: text(2, 80, "Name") });

export const addressSchema = z.object({
  label: text(1, 30, "Label"),
  name: text(2, 80, "Name"),
  mobile: mobileSchema,
  address: text(5, 240, "Address"),
  city: text(2, 60, "City"),
  state: z.enum(INDIAN_STATES, { error: "Pick your state" }),
  pincode: z.string().trim().regex(PINCODE_RE, "Enter a 6-digit pincode"),
  isDefault: z.boolean(),
});
export type AddressInput = z.output<typeof addressSchema>;

/** A site path such as /products/x, never another site or a script URL. */
const sitePath = z
  .string()
  .max(300)
  .refine((v) => v.startsWith("/") && !v.startsWith("//") && !v.includes("\\"), "Not a site link");

const imageSchema = z.union([
  z.object({ kind: z.literal("media"), key: z.enum(Object.keys(MEDIA) as [MediaKey, ...MediaKey[]]), alt: z.string().max(200) }),
  z.object({
    kind: z.literal("remote"),
    src: z.string().max(500).refine((v) => /^https:\/\//.test(v) || (v.startsWith("/") && !v.startsWith("//")), "Not an image link"),
    alt: z.string().max(200),
    fit: z.enum(["contain", "cover"]),
    tone: z.enum(["light", "dark"]),
  }),
]);

/** One saved product, as the browser's wishlist keeps it (a snapshot; the page overlays the live catalogue). */
export const wishlistItemSchema = z.object({
  slug: z.string().min(1).max(200).regex(/^[a-z0-9][a-z0-9:_-]*$/i),
  href: sitePath,
  title: z.string().min(1).max(200),
  brandName: z.string().max(100),
  price: z.number().int().min(0).max(10_000_000).nullable(),
  mrp: z.number().int().min(0).max(10_000_000).nullable(),
  image: imageSchema.optional(),
  hasOptions: z.boolean(),
  savedAt: z.number().int().min(0),
});
export const WISHLIST_MAX = 50;
export const wishlistSchema = z.object({ items: z.array(wishlistItemSchema).max(WISHLIST_MAX) });

/** The car chosen in "What do you drive?". */
export const carSchema = z.object({
  car: z
    .object({
      brandSlug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
      modelSlug: z.string().min(1).max(60).regex(/^[a-z0-9-]+$/),
      variant: z.string().min(1).max(60),
      year: z.number().int().min(1990).max(2100),
      label: z.string().min(1).max(200),
    })
    .nullable(),
});

export const TICKET_TOPICS = [
  { value: "order", label: "An order I placed" },
  { value: "product", label: "A product question" },
  { value: "fitment", label: "Will it fit my car?" },
  { value: "installation", label: "Installation or garage booking" },
  { value: "returns", label: "Returns, refunds or warranty" },
  { value: "other", label: "Something else" },
] as const;
export type TicketTopic = (typeof TICKET_TOPICS)[number]["value"];

export const ticketSchema = z.object({
  name: text(2, 80, "Name"),
  mobile: mobileSchema,
  email: z
    .string()
    .trim()
    .max(254)
    .optional()
    .transform((v) => (v ? v.toLowerCase() : null))
    .refine((v) => v === null || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Enter a valid email address"),
  orderNumber: z
    .string()
    .trim()
    .max(20)
    .optional()
    .transform((v) => (v ? v.toUpperCase() : null))
    .refine((v) => v === null || /^RZP-[A-Z0-9]{6}$/.test(v), "Order numbers look like RZP-ABC234"),
  topic: z.enum(TICKET_TOPICS.map((t) => t.value) as [TicketTopic, ...TicketTopic[]], {
    error: "Pick what it's about",
  }),
  body: text(10, 2000, "Message"),
});
export type TicketInput = z.output<typeof ticketSchema>;
