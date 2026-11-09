import { z } from "@/lib/zod";
import { ApiError, guardMutation, ok, rateLimit, readJson, route } from "@/lib/server/http";
import { CAN_SELL, requireVendor } from "@/lib/server/session";
import { askStoreAssistant, fullSalesmanFor } from "@/lib/server/assistant/store";
import { askStoreLocal } from "@/lib/server/assistant/store-local";
import { screenCategories, screenProducts, screenStore } from "@/lib/server/store-screen";
import { isHinglish } from "@/lib/server/assistant/local";
import { suggestionsFor } from "@/components/vendor/store-screen/lib";
import type { ScreenProduct } from "@/components/vendor/store-screen/types";
import { createOffer, liveOffer, nextBargainStep, payOptions, storeSettings } from "@/lib/server/store-sales";
import { CONVERSATION_ID, logSalesmanTurn } from "@/lib/server/salesman-log";
import { ASSISTANT_MAX_CHARS, ASSISTANT_MAX_TURNS, assistantRequestSchema } from "@/lib/assistant/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = assistantRequestSchema.extend({
  cart: z.array(z.object({ id: z.string().max(80), qty: z.number().int().min(1).max(99) })).max(60).default([]),
  offerId: z.string().regex(/^sof_[A-Za-z0-9_-]{6,40}$/).nullable().optional(),
  /** The chat on the shop screen (for the Salesman AI log); none from the seller's practice page. */
  conversationId: z.string().regex(CONVERSATION_ID).optional(),
});

/**
 * The shop screen's AI salesperson (the signed-in seller's screen; works while it is locked).
 * Full mode (Claude: needs ANTHROPIC_API_KEY, and the shop in SALESMAN_FULL_AI_SHOPS when that is
 * set). Otherwise, when its limits are used up, or when Claude doesn't answer, Basic mode
 * (store-local.ts, free) answers instead. Both bargain on the same ladder within the seller's limits.
 */
type Answer = { text: string; products: string[]; actions: { type: string; id?: string; qty?: number }[] };

/**
 * After Salesman AI puts something in the order (either mode), it also names a few products that
 * go well with it, like the screen does: "Car Cover" → mats, car care. Same pairs as the screen.
 */
async function withSuggestions<T extends Answer>(r: T, vendorId: string, cart: { id: string; qty: number }[], car: string | null, question: string, known?: ScreenProduct[]): Promise<T> {
  const added = r.actions.filter((a) => a.type === "add" && a.id).map((a) => ({ id: a.id!, qty: a.qty ?? 1 }));
  if (!added.length) return r;
  try {
    return await addSuggestions(r, added, vendorId, cart, car, question, known);
  } catch (err) {
    // Suggestions are extra: the answer goes out without them.
    console.error("[store-assistant] suggestions skipped:", err instanceof Error ? err.message : err);
    return r;
  }
}

async function addSuggestions<T extends Answer>(
  r: T,
  added: { id: string; qty: number }[],
  vendorId: string,
  cart: { id: string; qty: number }[],
  car: string | null,
  question: string,
  known?: ScreenProduct[],
): Promise<T> {
  const [products, categories] = await Promise.all([known ?? screenProducts(vendorId), screenCategories(vendorId)]);
  const inOrder: Record<string, number> = {};
  for (const l of [...cart, ...added]) inOrder[l.id] = (inOrder[l.id] ?? 0) + l.qty;
  const from = added.map((a) => products.find((p) => p.id === a.id)).filter((p): p is ScreenProduct => Boolean(p));
  const picks = suggestionsFor(from, products, categories, inOrder, car ? { slug: car, name: "", brand: "" } : null, 3);
  if (!picks.length) return r;
  const list = picks.map((p) => `${p.title} (₹${p.price.toLocaleString("en-IN")})`).join(", ");
  const line = isHinglish(question) ? `Iske saath ye bhi achha rahega: ${list}.` : `Goes well with it: ${list}.`;
  return { ...r, text: `${r.text.trim()}\n\n${line}`, products: [...new Set([...r.products, ...picks.map((p) => p.id)])] };
}

export const POST = route(async (req: Request) => {
  guardMutation(req);
  const vendor = await requireVendor(CAN_SELL, { whileLocked: true });
  const settings = await storeSettings(vendor.id);
  if (!settings.aiEnabled) throw new ApiError(403, "assistant_off", "Salesman AI is switched off for this shop. Turn it on in Offline Store settings.");
  const body = await readJson(req, schema, 64 * 1024);
  const last = body.messages[body.messages.length - 1];
  if (last.role !== "user" || !last.content.trim()) throw new ApiError(400, "invalid", "Say or type a question first.");
  if (last.content.length > ASSISTANT_MAX_CHARS) throw new ApiError(400, "too_long", "Please keep it shorter.");
  await rateLimit(`store-assistant-local:${vendor.id}`, 200, 10 * 60);
  const messages = body.messages.slice(-ASSISTANT_MAX_TURNS);
  const car = body.car ?? null;
  const log = (mode: "full" | "basic", r: { text: string; products: string[]; actions: Parameters<typeof logSalesmanTurn>[0]["actions"]; usage?: { input: number; output: number } }) =>
    body.conversationId
      ? logSalesmanTurn({ vendorId: vendor.id, conversationId: body.conversationId, mode, question: last.content, reply: r.text, products: r.products, actions: r.actions, usage: r.usage })
      : Promise.resolve();

  if (fullSalesmanFor(vendor.slug)) {
    try {
      await rateLimit(`store-assistant:${vendor.id}`, 60, 10 * 60);
      await rateLimit(`store-assistant-day:${vendor.id}`, Number(process.env.STORE_ASSISTANT_DAILY_LIMIT ?? 800), 24 * 60 * 60);
      const r = await withSuggestions(await askStoreAssistant(vendor, { messages, cart: body.cart, car, offerId: body.offerId ?? null }), vendor.id, body.cart, car, last.content);
      await log("full", r);
      return ok({ reply: r.text, products: r.products, actions: r.actions, mode: "full" });
    } catch (err) {
      console.error("[store-assistant] Claude unavailable, answering in basic mode:", err instanceof Error ? err.message : err);
    }
  }
  const [products, offer] = await Promise.all([screenProducts(vendor.id), body.offerId ? liveOffer(vendor.id, body.offerId) : null]);
  const current = offer?.percent ?? 0;
  const bargain = settings.bargainEnabled && settings.maxDiscountPct > 0
    ? {
        current,
        next: nextBargainStep(current, settings),
        make: (percent: number) => createOffer(vendor.id, percent, body.cart, "Basic mode bargaining ladder"),
      }
    : null;
  const r0 = await askStoreLocal(products, { messages, cart: body.cart, car, storeName: screenStore(vendor).name, pay: payOptions(settings), bargain });
  const r = await withSuggestions(r0, vendor.id, body.cart, car, last.content, products);
  await log("basic", r);
  return ok({ reply: r.text, products: r.products, actions: r.actions, mode: "basic" });
});
