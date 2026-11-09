import "server-only";

import { z } from "@/lib/zod";
import { sql, transaction, type Query } from "@/lib/db/client";
import { STORE_CATEGORIES_MAX, STORE_CATEGORY_NAME_MAX, STORE_SUGGEST_MAX, type StoreCategory } from "@/lib/vendor/store-categories";
import { ApiError } from "./http";
import { newId } from "./security";
import { audit } from "./vendors";

/**
 * A seller's own shop categories (see src/lib/vendor/store-categories.ts). They only shape the
 * Offline Store screen: the marketplace department and group of each product stay as they are.
 */

const name = z
  .string()
  .trim()
  .min(1, "Enter a name")
  .max(STORE_CATEGORY_NAME_MAX, `Keep it under ${STORE_CATEGORY_NAME_MAX} characters`);
const id = z.string().min(1).max(80);

export const storeCategoryActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name, parentId: id.nullable().default(null) }),
  z.object({ action: z.literal("rename"), id, name }),
  z.object({ action: z.literal("move"), id, dir: z.enum(["up", "down"]) }),
  z.object({ action: z.literal("delete"), id }),
  z.object({ action: z.literal("bestseller"), id, on: z.boolean() }),
  z.object({ action: z.literal("suggest"), id, ids: z.array(id).max(STORE_SUGGEST_MAX, `Pick up to ${STORE_SUGGEST_MAX}`) }),
]);

type Row = {
  id: string;
  name: string;
  parent_id: string | null;
  position: number;
  products: number;
  bestseller: boolean;
  suggest_ids: string[] | null;
};

export async function listStoreCategories(vendorId: string, q: Query = sql): Promise<StoreCategory[]> {
  const rows = await q<Row>(
    `SELECT c.id, c.name, c.parent_id, c.position, c.bestseller, c.suggest_ids,
            (SELECT count(*)::int FROM vendor_products p WHERE p.store_category_id = c.id AND p.status <> 'archived') AS products
       FROM store_categories c
      WHERE c.vendor_id = $1
      ORDER BY c.position, lower(c.name)`,
    [vendorId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
    position: r.position,
    products: r.products,
    bestseller: Boolean(r.bestseller),
    suggestIds: r.suggest_ids ?? [],
  }));
}

async function own(q: Query, vendorId: string, categoryId: string) {
  const row = await sqlOneQ<{ id: string; parent_id: string | null; position: number }>(
    q,
    "SELECT id, parent_id, position FROM store_categories WHERE id = $1 AND vendor_id = $2",
    [categoryId, vendorId],
  );
  if (!row) throw new ApiError(404, "not_found", "That category was not found. Refresh and try again.");
  return row;
}

async function sqlOneQ<T extends Record<string, unknown>>(q: Query, text: string, params: unknown[]): Promise<T | null> {
  return (await q<T>(text, params))[0] ?? null;
}

/** Throws unless `categoryId` (when given) is one of this seller's categories. */
export async function assertOwnStoreCategory(vendorId: string, categoryId: string | null | undefined, q: Query = sql) {
  if (!categoryId) return;
  const row = await sqlOneQ<{ one: number }>(q, "SELECT 1 AS one FROM store_categories WHERE id = $1 AND vendor_id = $2", [categoryId, vendorId]);
  if (!row) throw new ApiError(400, "invalid", "Some details need fixing.", { storeCategoryId: "Pick one of your shop categories." });
}

const nameTaken = () =>
  new ApiError(409, "name_taken", "You already have a category with this name here.", { name: "You already have a category with this name here." });

export async function storeCategoryAction(vendorId: string, input: z.infer<typeof storeCategoryActionSchema>): Promise<StoreCategory[]> {
  try {
    await transaction(async (q) => {
      if (input.action === "create") {
        const count = await sqlOneQ<{ n: number }>(q, "SELECT count(*)::int AS n FROM store_categories WHERE vendor_id = $1", [vendorId]);
        if ((count?.n ?? 0) >= STORE_CATEGORIES_MAX) {
          throw new ApiError(400, "too_many", `A shop can have up to ${STORE_CATEGORIES_MAX} categories and sub-categories.`);
        }
        if (input.parentId) {
          const parent = await own(q, vendorId, input.parentId);
          if (parent.parent_id) throw new ApiError(400, "too_deep", "Sub-categories can't have their own sub-categories.");
        }
        const next = await sqlOneQ<{ p: number }>(
          q,
          "SELECT coalesce(max(position), 0) + 1 AS p FROM store_categories WHERE vendor_id = $1 AND parent_id IS NOT DISTINCT FROM $2",
          [vendorId, input.parentId],
        );
        const newIdValue = newId("sc");
        await q("INSERT INTO store_categories (id, vendor_id, parent_id, name, position) VALUES ($1, $2, $3, $4, $5)", [
          newIdValue,
          vendorId,
          input.parentId,
          input.name,
          next?.p ?? 1,
        ]);
        await audit({ type: "vendor", id: vendorId }, "store_category.create", { vendorId, detail: { id: newIdValue, name: input.name } }, q);
        return;
      }

      const row = await own(q, vendorId, input.id);
      if (input.action === "rename") {
        await q("UPDATE store_categories SET name = $1 WHERE id = $2", [input.name, row.id]);
      } else if (input.action === "bestseller") {
        await q("UPDATE store_categories SET bestseller = $1 WHERE id = $2", [input.on, row.id]);
      } else if (input.action === "suggest") {
        // Only this seller's other main categories.
        const mains = await q<{ id: string }>(
          "SELECT id FROM store_categories WHERE vendor_id = $1 AND parent_id IS NULL AND id = ANY($2) AND id <> $3",
          [vendorId, input.ids, row.id],
        );
        const ok = new Set(mains.map((m) => m.id));
        await q("UPDATE store_categories SET suggest_ids = $1 WHERE id = $2", [input.ids.filter((x) => ok.has(x)), row.id]);
      } else if (input.action === "delete") {
        // Products in it (or in its sub-categories) simply leave the category (ON DELETE SET NULL).
        await q("DELETE FROM store_categories WHERE id = $1", [row.id]);
        await audit({ type: "vendor", id: vendorId }, "store_category.delete", { vendorId, detail: { id: row.id } }, q);
      } else {
        // Swap places with the neighbour above or below among its siblings.
        const siblings = await q<{ id: string; position: number }>(
          "SELECT id, position FROM store_categories WHERE vendor_id = $1 AND parent_id IS NOT DISTINCT FROM $2 ORDER BY position, lower(name)",
          [vendorId, row.parent_id],
        );
        const at = siblings.findIndex((s) => s.id === row.id);
        const to = input.dir === "up" ? at - 1 : at + 1;
        if (at < 0 || to < 0 || to >= siblings.length) return;
        [siblings[at], siblings[to]] = [siblings[to], siblings[at]];
        for (const [i, s] of siblings.entries()) {
          await q("UPDATE store_categories SET position = $1 WHERE id = $2", [i + 1, s.id]);
        }
      }
    });
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "23505") throw nameTaken();
    throw err;
  }
  return listStoreCategories(vendorId);
}

