/**
 * AI shopping assistant: what the browser sends and gets back. Client-safe.
 * The server side is src/lib/server/assistant/*.
 *
 * The browser keeps the conversation (text only) and sends it with each question; the server
 * re-checks every limit. Products the assistant showed travel back as ids so it can refer to them.
 */
import { z } from "@/lib/zod";

export const ASSISTANT_MAX_TURNS = 12;
export const ASSISTANT_MAX_CHARS = 600;

export const assistantRequestSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().max(4000),
        /** Ids of products the assistant showed with this reply. */
        products: z.array(z.string().max(200)).max(8).optional(),
      }),
    )
    .min(1)
    .max(40),
  /** The shopper's saved car (garage) or the car picked on the store screen: a model slug. */
  car: z.string().regex(/^[a-z0-9-]{1,80}$/).optional(),
});
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;

export type AssistantMessage = { role: "user" | "assistant"; content: string; products?: string[] };

/** Starters shown before the first question. */
export const WEB_STARTERS = [
  "Seat covers for my Creta under ₹8,000",
  "Best floor mats for a Thar?",
  "Ambient lighting that fits a Scorpio-N",
  "What's your return policy?",
];

export const STORE_STARTERS = [
  "Show me dashcams",
  "Seat covers for my car",
  "What's the best value here?",
  "5000 tak ka dashcam dikhao",
];
