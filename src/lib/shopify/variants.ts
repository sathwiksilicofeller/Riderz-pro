import "server-only";
import { getProductDetail } from "@/lib/store/products";
import { cartLineId, type ProductDetail } from "@/lib/store/types";
import { isVendorLineSlug } from "@/lib/vendor/types";
import { storefront } from "./client";

export type LineRequest = { id: string; qty: number };

export type LineResult =
  | { ok: true; id: string; variantId: string; qty: number }
  | { ok: false; id: string; reason: string };

/** Splits `slug?optId=valId&…` into the slug and its choices. Null when malformed. */
export function parseLineId(id: string): { slug: string; choices: Record<string, string> } | null {
  const q = id.indexOf("?");
  const slug = q === -1 ? id : id.slice(0, q);
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug)) return null;
  const choices: Record<string, string> = {};
  if (q !== -1) {
    for (const part of id.slice(q + 1).split("&")) {
      const eq = part.indexOf("=");
      if (eq <= 0) return null;
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      if (!k || !v || k in choices) return null;
      choices[k] = v;
    }
  }
  return { slug, choices };
}

type VariantNode = {
  id: string;
  availableForSale: boolean;
  selectedOptions: { name: string; value: string }[];
};
type ProductQuery = {
  product: { variants: { nodes: VariantNode[] } } | null;
};

const PRODUCT_VARIANTS = /* GraphQL */ `
  query ProductVariants($handle: String!) {
    product(handle: $handle) {
      variants(first: 250) {
        nodes {
          id
          availableForSale
          selectedOptions {
            name
            value
          }
        }
      }
    }
  }
`;

/** Same line, same id: option order in the query string does not matter. */
export function canonicalLineId(id: string): string | null {
  const parsed = parseLineId(id);
  return parsed ? cartLineId(parsed.slug, parsed.choices) : null;
}

export type Buyable =
  | { ok: true; detail: ProductDetail; wanted: Map<string, string> }
  | { ok: false; reason: string };

/**
 * Whether a cart line can be bought at all, judged from the catalogue alone
 * (no Shopify call): the product exists, has a price, is purchasable and
 * indexable, and every option choice is present, known and available.
 * `wanted` maps option name -> value label, which is how Shopify names variants.
 */
export function checkBuyable(id: string): Buyable {
  // Marketplace items are not in Shopify; they are ordered through /api/orders and paid online (Razorpay).
  if (isVendorLineSlug(id)) return { ok: false, reason: "Marketplace items are ordered through the site checkout" };
  const parsed = parseLineId(id);
  if (!parsed) return { ok: false, reason: "Invalid cart line" };
  const detail = getProductDetail(parsed.slug);
  if (!detail) return { ok: false, reason: "Unknown product" };
  if (detail.price === null) return { ok: false, reason: "Price on request" };
  if (detail.availability === "coming-soon") return { ok: false, reason: "Not available to order yet" };
  if (!detail.indexable) return { ok: false, reason: "Not available to order yet" };

  const wanted = new Map<string, string>();
  for (const opt of detail.options) {
    const valueId = parsed.choices[opt.id];
    if (!valueId) return { ok: false, reason: `Missing choice for ${opt.name}` };
    const value = opt.values.find((v) => v.id === valueId);
    if (!value || !value.available) return { ok: false, reason: `${opt.name} choice is not available` };
    wanted.set(opt.name, value.label);
  }
  for (const k of Object.keys(parsed.choices)) {
    if (!detail.options.some((o) => o.id === k)) return { ok: false, reason: "Unknown option on cart line" };
  }
  return { ok: true, detail, wanted };
}

/**
 * Maps a cart line to the Shopify variant (merchandise) id.
 * Product handle = store slug; option/value ids are translated to their labels,
 * which is how the CSV export names variants in Shopify.
 */
export async function resolveLine(line: LineRequest): Promise<LineResult> {
  const fail = (reason: string): LineResult => ({ ok: false, id: line.id, reason });

  const buyable = checkBuyable(line.id);
  if (!buyable.ok) return fail(buyable.reason);
  const { detail, wanted } = buyable;

  const data = await storefront<ProductQuery>(PRODUCT_VARIANTS, { handle: detail.slug });
  const variants = data.product?.variants.nodes;
  if (!variants) return fail("Product is not in the Shopify store yet");

  let match: VariantNode | undefined;
  if (wanted.size === 0) {
    match = variants[0];
  } else {
    match = variants.find(
      (v) =>
        v.selectedOptions.length === wanted.size &&
        v.selectedOptions.every((o) => wanted.get(o.name) === o.value),
    );
  }
  if (!match) return fail("This option combination is not in the Shopify store");
  if (!match.availableForSale) return fail("Currently unavailable");
  return { ok: true, id: line.id, variantId: match.id, qty: line.qty };
}

/** Resolves all lines, one product query per line. */
export async function resolveLines(lines: LineRequest[]): Promise<LineResult[]> {
  return Promise.all(lines.map(resolveLine));
}
