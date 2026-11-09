import "server-only";

import { after } from "next/server";
import { sql, transaction, type Query } from "@/lib/db/client";
import {
  PAYMENT_STATUS_LABELS,
  UNPAID_HOLD_MINUTES,
  paiseToText,
  type AdminPaymentRow,
  type AdminPaymentSummary,
  type AdminRefundRow,
  type CustomerPaymentView,
  type OnlinePaymentStart,
  type PaymentMethod,
  type PaymentStatus,
  type RefundStatus,
} from "@/lib/payments/types";
import { rupeesToPaise, verifyCheckoutSignature, verifyWebhookSignature } from "@/lib/payments/signature";
import { ApiError } from "./http";
import { cancelUnpaidOnlineOrder, notifySellersOfOrder, type PlacedOrderRecord } from "./orders";
import { onOrderConfirmed } from "./payments-hooks";
import {
  RazorpayError,
  createRazorpayOrder,
  createRazorpayRefund,
  fetchOrderPayments,
  fetchPayment,
  razorpayKeys,
  webhookSecret,
  type RazorpayPayment,
} from "./payments-razorpay";
import { newId, sha256 } from "./security";
import { audit } from "./vendors";

/**
 * ONLINE PAYMENTS (Razorpay)
 *
 *   1. POST /api/orders {paymentMethod:"online"} → placeOrder prices everything from the server's own
 *      data and takes the stock, then startOnlinePayment creates a Razorpay order for exactly that
 *      total. The browser gets only the key id, the Razorpay order id and the amount.
 *   2. Razorpay Checkout → POST /api/payments/razorpay/verify: HMAC signature check, then markPaid.
 *   3. Webhook (payment.captured / order.paid / payment.failed / refund.*) does the same server to
 *      server, deduplicated by event id, so a closed tab never loses a payment.
 *   4. releaseUnpaidOrders cancels online orders still unpaid after UNPAID_HOLD_MINUTES and puts
 *      their stock back (it asks Razorpay first, so a payment that did go through is kept).
 *   5. Refunds are started by an admin (adminRefund) and settled by refund.* webhooks.
 *
 * Units: orders.total is integer RUPEES; every `*_paise` / `*Paise` value is integer PAISE.
 * Without RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET online payment is switched off everywhere (the
 * cart shows it as unavailable); there is no simulated payment, in development or production.
 */

/** Checkout closes itself after this long, well inside the stock hold, so a late payment is rare. */
const CHECKOUT_TIMEOUT_SECONDS = 15 * 60;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const SYSTEM = { type: "system" as const, id: "payments" };

export function onlinePaymentsEnabled(): boolean {
  return razorpayKeys() !== null;
}

function requireKeys() {
  const keys = razorpayKeys();
  if (!keys) throw new ApiError(503, "payments_unavailable", "Online payment isn't available right now. Please try again in a few minutes.");
  return keys;
}

/* ------------------------------------------------------------ start */

/**
 * Create the Razorpay order for an order placed with method "online". If Razorpay can't be
 * reached the order is cancelled straight away (stock released) so nothing is left holding stock.
 */
export async function startOnlinePayment(order: PlacedOrderRecord): Promise<OnlinePaymentStart> {
  const keys = requireKeys();
  const amountPaise = rupeesToPaise(order.total);
  const giveUp = async (why: string) => {
    console.error("[payments] could not start payment", order.number, why);
    await transaction((q) => cancelUnpaidOnlineOrder(q, order.id, "Payment could not be started")).catch(() => {});
    throw new ApiError(502, "payment_start_failed", "We couldn't start the payment. Nothing was charged. Please try again in a few minutes.");
  };

  let rp;
  try {
    rp = await createRazorpayOrder({ amountPaise, receipt: order.number, notes: { order_number: order.number, order_id: order.id } });
  } catch (err) {
    return giveUp(err instanceof Error ? err.message : "unknown error");
  }
  if (!rp || typeof rp.id !== "string" || !/^order_[A-Za-z0-9]+$/.test(rp.id) || rp.amount !== amountPaise || rp.currency !== "INR") {
    return giveUp("unexpected order response");
  }
  await sql("INSERT INTO payments (id, order_id, razorpay_order_id, amount_paise, currency) VALUES ($1,$2,$3,$4,'INR')", [
    newId("pmt"),
    order.id,
    rp.id,
    amountPaise,
  ]);
  return { keyId: keys.keyId, razorpayOrderId: rp.id, amountPaise, currency: "INR", timeoutSeconds: CHECKOUT_TIMEOUT_SECONDS };
}

/* ------------------------------------------------------- paid / failed */

type PaidOutcome = "confirmed" | "already" | "paid_after_cancel" | "unknown_order" | "amount_mismatch" | "other_payment";

/**
 * Record a successful payment. Idempotent: the checkout verify, the webhook and the reconcile
 * step may all report the same payment; only the first one moves anything. `amountPaise` is what
 * Razorpay says was paid (null when only the checkout signature is known; the signature binds the
 * Razorpay order, whose amount the server set).
 */
async function markPaid(
  q: Query,
  input: {
    razorpayOrderId: string;
    paymentId: string;
    amountPaise: number | null;
    currency: string | null;
    method: string | null;
    via: "checkout" | "webhook" | "reconcile";
    eventId?: string;
  },
): Promise<{ outcome: PaidOutcome; orderId?: string }> {
  const p = (
    await q<{ id: string; order_id: string; status: string; amount_paise: number; currency: string; razorpay_payment_id: string | null; order_status: string; number: string }>(
      `SELECT p.id, p.order_id, p.status, p.amount_paise, p.currency, p.razorpay_payment_id, o.status AS order_status, o.number
         FROM payments p JOIN orders o ON o.id = p.order_id
        WHERE p.razorpay_order_id = $1 FOR UPDATE OF p, o`,
      [input.razorpayOrderId],
    )
  )[0];
  if (!p) return { outcome: "unknown_order" };

  const detail = { orderId: p.order_id, number: p.number, razorpayOrderId: input.razorpayOrderId, paymentId: input.paymentId, via: input.via };
  if (input.amountPaise !== null && (input.amountPaise !== p.amount_paise || (input.currency ?? "INR") !== p.currency)) {
    await audit(SYSTEM, "payment.amount_mismatch", { detail: { ...detail, expected: p.amount_paise, got: input.amountPaise, currency: input.currency } }, q);
    return { outcome: "amount_mismatch", orderId: p.order_id };
  }
  if (p.status === "paid") {
    if (p.razorpay_payment_id === input.paymentId) return { outcome: "already", orderId: p.order_id };
    await audit(SYSTEM, "payment.second_payment", { detail: { ...detail, firstPaymentId: p.razorpay_payment_id } }, q);
    return { outcome: "other_payment", orderId: p.order_id };
  }

  await q(
    `UPDATE payments SET status = 'paid', razorpay_payment_id = $2, method = COALESCE($3, method), verified_via = $4,
            last_event_id = COALESCE($5, last_event_id), paid_at = now(), updated_at = now()
      WHERE id = $1`,
    [p.id, input.paymentId, input.method, input.via, input.eventId ?? null],
  );
  if (p.order_status === "cancelled") {
    // e.g. it expired unpaid and the stock went back on sale, then the money arrived: refund it.
    await q("UPDATE orders SET payment_status = 'paid', paid_at = now(), updated_at = now() WHERE id = $1", [p.order_id]);
    await audit(SYSTEM, "payment.paid_after_cancel", { detail: { ...detail, amountPaise: p.amount_paise } }, q);
    return { outcome: "paid_after_cancel", orderId: p.order_id };
  }
  await q(
    `UPDATE orders SET payment_status = 'paid', paid_at = now(), updated_at = now(),
            status = CASE WHEN status = 'placed' THEN 'confirmed' ELSE status END
      WHERE id = $1`,
    [p.order_id],
  );
  await audit(SYSTEM, "payment.paid", { detail: { ...detail, amountPaise: p.amount_paise } }, q);
  return { outcome: "confirmed", orderId: p.order_id };
}

/** A payment attempt failed. The order stays open (the shopper can try again) until it expires. */
async function markFailed(q: Query, input: { razorpayOrderId: string; code: string | null; description: string | null; eventId: string }): Promise<string> {
  const rows = await q<{ order_id: string }>(
    `UPDATE payments SET status = 'failed', failed_attempts = failed_attempts + 1, error_code = $2, error_description = $3,
            last_event_id = $4, updated_at = now()
      WHERE razorpay_order_id = $1 AND status IN ('created','failed') RETURNING order_id`,
    [input.razorpayOrderId, input.code?.slice(0, 80) ?? null, input.description?.slice(0, 300) ?? null, input.eventId],
  );
  if (!rows[0]) return "ignored";
  await q("UPDATE orders SET payment_status = 'failed', updated_at = now() WHERE id = $1 AND payment_method = 'online' AND payment_status = 'pending'", [
    rows[0].order_id,
  ]);
  return "failed";
}

/** After a payment first confirms an order (after commit; never throws). */
async function afterPaid(orderId: string): Promise<void> {
  try {
    await notifySellersOfOrder(orderId);
    await onOrderConfirmed(orderId, "online_paid");
  } catch (err) {
    console.error("[payments] after-paid step failed", err instanceof Error ? err.message : err);
  }
}

/* -------------------------------------------------------- checkout verify */

export type VerifyInput = { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string };
export type VerifyResult = { number: string; total: number; paymentStatus: PaymentStatus; orderStatus: string; paidAfterCancel: boolean };

/** Razorpay Checkout's success handler → here. The signature is checked before anything is touched. */
export async function verifyCheckoutPayment(input: VerifyInput): Promise<VerifyResult> {
  const keys = requireKeys();
  if (!verifyCheckoutSignature(input.razorpayOrderId, input.razorpayPaymentId, input.razorpaySignature, keys.keySecret)) {
    throw new ApiError(400, "bad_signature", "We couldn't confirm this payment. If money left your account, contact us with your order number.");
  }

  // Cross-check with Razorpay when it answers; the signature alone is enough when it doesn't.
  let fetched: RazorpayPayment | null = null;
  try {
    fetched = await fetchPayment(input.razorpayPaymentId);
  } catch (err) {
    console.warn("[payments] payment lookup failed; relying on the signature", err instanceof Error ? err.message : err);
  }
  if (fetched && (fetched.order_id !== input.razorpayOrderId || fetched.status === "failed" || fetched.status === "created")) {
    throw new ApiError(400, "payment_mismatch", "We couldn't confirm this payment. If money left your account, contact us with your order number.");
  }

  const res = await transaction((q) =>
    markPaid(q, {
      razorpayOrderId: input.razorpayOrderId,
      paymentId: input.razorpayPaymentId,
      amountPaise: fetched ? fetched.amount : null,
      currency: fetched ? fetched.currency : null,
      method: fetched?.method ?? null,
      via: "checkout",
    }),
  );
  if (res.outcome === "unknown_order") throw new ApiError(404, "not_found", "We couldn't find the order for this payment.");
  if (res.outcome === "amount_mismatch") throw new ApiError(400, "payment_mismatch", "The amount paid doesn't match the order. Please contact us.");
  if (res.outcome === "confirmed") await afterPaid(res.orderId!);

  const o = (
    await sql<{ number: string; total: number; status: string; payment_status: PaymentStatus }>(
      "SELECT number, total, status, payment_status FROM orders WHERE id = $1",
      [res.orderId],
    )
  )[0];
  return { number: o.number, total: o.total, paymentStatus: o.payment_status, orderStatus: o.status, paidAfterCancel: o.status === "cancelled" };
}

/* ---------------------------------------------------------------- webhook */

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : null);
const int = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const entity = (payload: Record<string, unknown>, key: string) => obj(obj(payload[key]).entity);

export type WebhookResult = { status: "processed" | "duplicate" | "ignored"; outcome: string };

/**
 * POST /api/payments/razorpay/webhook. `raw` is the exact request body. The signature is checked
 * first; each event id is handled once (the dedupe row and the effects commit together, so a
 * failure is retried by Razorpay and a success never repeats).
 */
export async function handleRazorpayWebhook(raw: string, signature: string | null, eventIdHeader: string | null): Promise<WebhookResult> {
  const secret = webhookSecret();
  if (!secret) throw new ApiError(503, "not_configured", "Webhook not configured.");
  if (!verifyWebhookSignature(raw, signature, secret)) throw new ApiError(401, "bad_signature", "Invalid signature.");

  let body: Record<string, unknown>;
  try {
    body = obj(JSON.parse(raw));
  } catch {
    throw new ApiError(400, "bad_json", "Unreadable body.");
  }
  const event = str(body.event) ?? "unknown";
  const payload = obj(body.payload);
  const headerId = eventIdHeader?.trim();
  const eventId = headerId && /^[A-Za-z0-9_.:-]{1,100}$/.test(headerId) ? headerId : `body:${sha256(raw)}`;
  const pay = entity(payload, "payment");
  const ord = entity(payload, "order");
  const refund = entity(payload, "refund");
  const razorpayOrderId = str(pay.order_id) ?? str(ord.id);

  let confirmed: string | null = null;
  const result = await transaction(async (q): Promise<WebhookResult> => {
    const fresh = await q("INSERT INTO payment_webhook_events (event_id, event, razorpay_order_id) VALUES ($1,$2,$3) ON CONFLICT (event_id) DO NOTHING RETURNING event_id", [
      eventId,
      event,
      razorpayOrderId,
    ]);
    if (!fresh[0]) return { status: "duplicate", outcome: "duplicate" };

    let outcome = "ignored";
    switch (event) {
      case "payment.captured":
      case "order.paid": {
        const paymentId = str(pay.id);
        // order.paid carries the order's amount_paid; payment.captured the payment's amount.
        const amount = event === "order.paid" ? int(ord.amount_paid) ?? int(pay.amount) : int(pay.amount);
        if (!razorpayOrderId || !paymentId || amount === null) break;
        const r = await markPaid(q, {
          razorpayOrderId,
          paymentId,
          amountPaise: amount,
          currency: str(pay.currency) ?? str(ord.currency) ?? "INR",
          method: str(pay.method),
          via: "webhook",
          eventId,
        });
        outcome = r.outcome;
        if (r.outcome === "confirmed") confirmed = r.orderId!;
        break;
      }
      case "payment.failed":
        if (razorpayOrderId) {
          outcome = await markFailed(q, { razorpayOrderId, code: str(pay.error_code), description: str(pay.error_description), eventId });
        }
        break;
      case "refund.processed":
      case "refund.failed":
      case "refund.created":
        outcome = await applyRefundEvent(q, refund, event === "refund.processed" ? "processed" : event === "refund.failed" ? "failed" : "pending");
        break;
    }
    await q("UPDATE payment_webhook_events SET result = $2 WHERE event_id = $1", [eventId, outcome]);
    return { status: outcome === "ignored" ? "ignored" : "processed", outcome };
  });
  if (confirmed) await afterPaid(confirmed);
  return result;
}

/* ---------------------------------------------------------------- refunds */

/** Refunds that count against the paid amount (anything not failed). */
async function refundedSoFar(q: Query, paymentId: string): Promise<number> {
  const r = await q<{ n: number }>(
    "SELECT COALESCE(sum(amount_paise), 0)::int AS n FROM refunds WHERE payment_id = $1 AND status IN ('requested','pending','processed')",
    [paymentId],
  );
  return r[0]?.n ?? 0;
}

/** orders.payment_status from the refunds Razorpay has accepted (pending or processed). */
async function settleRefundStatus(q: Query, paymentId: string): Promise<void> {
  const r = (
    await q<{ order_id: string; amount_paise: number; refunded: number }>(
      `SELECT p.order_id, p.amount_paise,
              COALESCE((SELECT sum(r.amount_paise) FROM refunds r WHERE r.payment_id = p.id AND r.status IN ('pending','processed')), 0)::int AS refunded
         FROM payments p WHERE p.id = $1`,
      [paymentId],
    )
  )[0];
  if (!r) return;
  const next: PaymentStatus = r.refunded >= r.amount_paise ? "refunded" : r.refunded > 0 ? "partially_refunded" : "paid";
  await q(
    "UPDATE orders SET payment_status = $2, updated_at = now() WHERE id = $1 AND payment_status IN ('paid','refunded','partially_refunded') AND payment_status <> $2",
    [r.order_id, next],
  );
}

/** refund.* webhook: update our row (matched by Razorpay id or our own id in the notes), or record a dashboard refund. */
async function applyRefundEvent(q: Query, r: Record<string, unknown>, status: RefundStatus): Promise<string> {
  const refundId = str(r.id);
  const paymentId = str(r.payment_id);
  const amount = int(r.amount);
  if (!refundId || !paymentId || amount === null || amount <= 0) return "ignored";
  const p = (await q<{ id: string; order_id: string }>("SELECT id, order_id FROM payments WHERE razorpay_payment_id = $1 FOR UPDATE", [paymentId]))[0];
  if (!p) return "unknown_payment";
  const ours = str(obj(r.notes).refund_id) ?? str(r.receipt);

  const existing = (
    await q<{ id: string; status: RefundStatus }>(
      `SELECT id, status FROM refunds
        WHERE payment_id = $1 AND (razorpay_refund_id = $2 OR (razorpay_refund_id IS NULL AND id = $3))
        ORDER BY (razorpay_refund_id = $2) DESC NULLS LAST LIMIT 1 FOR UPDATE`,
      [p.id, refundId, ours],
    )
  )[0];
  if (existing) {
    // Never step back from a final state.
    if (existing.status === "processed" || (existing.status === "failed" && status !== "processed")) {
      await q("UPDATE refunds SET razorpay_refund_id = COALESCE(razorpay_refund_id, $2), updated_at = now() WHERE id = $1", [existing.id, refundId]);
    } else {
      await q(
        `UPDATE refunds SET razorpay_refund_id = $2, status = $3, updated_at = now(),
                processed_at = CASE WHEN $3 = 'processed' THEN now() ELSE processed_at END,
                error = CASE WHEN $3 = 'failed' THEN 'Razorpay reported the refund as failed' ELSE NULL END
          WHERE id = $1`,
        [existing.id, refundId, status],
      );
    }
  } else {
    await q(
      `INSERT INTO refunds (id, payment_id, order_id, razorpay_refund_id, amount_paise, status, reason, source, created_by, processed_at)
       VALUES ($1,$2,$3,$4,$5,$6,'Refund made in the Razorpay dashboard','dashboard','razorpay', CASE WHEN $6 = 'processed' THEN now() END)`,
      [newId("rfd"), p.id, p.order_id, refundId, amount, status],
    );
  }
  await settleRefundStatus(q, p.id);
  await audit(SYSTEM, `payment.refund_${status}`, { detail: { orderId: p.order_id, razorpayRefundId: refundId, amountPaise: amount } }, q);
  return `refund_${status}`;
}

export type RefundInput = { amountRupees: number | null; reason: string };

/**
 * Admin refund, full (`amountRupees: null`) or partial (whole rupees). Limit: the paid amount minus
 * every refund not failed. The row is written (and counted) before Razorpay is called, so two
 * clicks can never refund twice; Razorpay's answer, then the refund.* webhook, settle it.
 */
export async function adminRefund(actor: string, orderId: string, input: RefundInput, ip: string | null = null): Promise<{ id: string; status: RefundStatus; amountPaise: number }> {
  requireKeys();
  const reason = input.reason.trim();
  const prep = await transaction(async (q) => {
    const p = (
      await q<{ id: string; razorpay_payment_id: string; amount_paise: number; number: string }>(
        `SELECT p.id, p.razorpay_payment_id, p.amount_paise, o.number FROM payments p JOIN orders o ON o.id = p.order_id
          WHERE p.order_id = $1 AND p.status = 'paid' FOR UPDATE OF p`,
        [orderId],
      )
    )[0];
    if (!p) throw new ApiError(409, "not_paid", "This order has no online payment to refund.");
    const remaining = p.amount_paise - (await refundedSoFar(q, p.id));
    if (remaining <= 0) throw new ApiError(409, "fully_refunded", "This payment has already been refunded in full.");
    const amountPaise = input.amountRupees === null ? remaining : rupeesToPaise(input.amountRupees);
    if (amountPaise <= 0 || amountPaise > remaining) {
      throw new ApiError(400, "invalid", `At most ${paiseToText(remaining)} can be refunded.`, { amount: `At most ${paiseToText(remaining)}` });
    }
    const id = newId("rfd");
    await q(
      "INSERT INTO refunds (id, payment_id, order_id, amount_paise, status, reason, source, created_by) VALUES ($1,$2,$3,$4,'requested',$5,'admin',$6)",
      [id, p.id, orderId, amountPaise, reason, actor],
    );
    await audit({ type: "admin", id: actor }, "payment.refund_requested", { detail: { orderId, number: p.number, refundId: id, amountPaise, reason, full: amountPaise === remaining }, ip }, q);
    return { id, paymentRowId: p.id, razorpayPaymentId: p.razorpay_payment_id, amountPaise, number: p.number };
  });

  let rf;
  try {
    rf = await createRazorpayRefund(prep.razorpayPaymentId, {
      amountPaise: prep.amountPaise,
      receipt: prep.id,
      notes: { refund_id: prep.id, order_number: prep.number, reason: reason.slice(0, 200) },
    });
  } catch (err) {
    if (err instanceof RazorpayError) {
      await transaction(async (q) => {
        await q("UPDATE refunds SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 AND status = 'requested'", [prep.id, err.description]);
        await audit({ type: "admin", id: actor }, "payment.refund_refused", { detail: { orderId, refundId: prep.id, code: err.code, description: err.description }, ip }, q);
      });
      throw new ApiError(502, "refund_failed", `Razorpay refused the refund: ${err.description}`);
    }
    await sql("UPDATE refunds SET error = $2, updated_at = now() WHERE id = $1", [prep.id, "No answer from Razorpay when the refund was sent."]);
    throw new ApiError(
      504,
      "refund_unknown",
      "Razorpay didn't answer, so the refund may or may not have gone through. Check the Razorpay dashboard before trying again; it stays counted until Razorpay confirms it.",
    );
  }

  const status: RefundStatus = rf.status === "processed" ? "processed" : rf.status === "failed" ? "failed" : "pending";
  await transaction(async (q) => {
    await q(
      `UPDATE refunds SET razorpay_refund_id = COALESCE(razorpay_refund_id, $2), updated_at = now(),
              status = CASE WHEN status = 'requested' THEN $3 ELSE status END,
              processed_at = CASE WHEN status = 'requested' AND $3 = 'processed' THEN now() ELSE processed_at END
        WHERE id = $1`,
      [prep.id, typeof rf.id === "string" ? rf.id.slice(0, 80) : null, status],
    );
    await settleRefundStatus(q, prep.paymentRowId);
  });
  return { id: prep.id, status, amountPaise: prep.amountPaise };
}

/* ------------------------------------------------------- unpaid release */

/**
 * Cancel online orders still unpaid after `olderThanMinutes` and put their stock back. Before
 * releasing one it asks Razorpay whether a payment did go through (then it's confirmed instead);
 * if Razorpay can't be asked it waits, up to six hours. Safe to run often and on several servers.
 *
 * Call it from housekeeping (and it also runs, throttled, on new orders: releaseUnpaidOrdersSoon).
 */
export async function releaseUnpaidOrders(opts: { olderThanMinutes?: number; limit?: number } = {}): Promise<{ released: string[]; paid: string[]; waiting: string[] }> {
  const minutes = Math.max(1, Math.floor(opts.olderThanMinutes ?? UNPAID_HOLD_MINUTES));
  const rows = await sql<{ id: string; number: string; created_at: Date; total: number; razorpay_order_id: string | null }>(
    `SELECT o.id, o.number, o.created_at, o.total,
            (SELECT p.razorpay_order_id FROM payments p WHERE p.order_id = o.id ORDER BY p.created_at DESC LIMIT 1) AS razorpay_order_id
       FROM orders o
      WHERE o.payment_method = 'online' AND o.payment_status IN ('pending','failed') AND o.status = 'placed'
        AND o.created_at < now() - make_interval(mins => $1)
      ORDER BY o.created_at LIMIT $2`,
    [minutes, Math.min(Math.max(1, opts.limit ?? 50), 200)],
  );
  const out = { released: [] as string[], paid: [] as string[], waiting: [] as string[] };
  const keys = razorpayKeys();

  for (const r of rows) {
    if (keys && r.razorpay_order_id) {
      try {
        const payments = await fetchOrderPayments(r.razorpay_order_id);
        const captured = payments.find((p) => p.status === "captured");
        if (captured) {
          const res = await transaction((q) =>
            markPaid(q, {
              razorpayOrderId: r.razorpay_order_id!,
              paymentId: captured.id,
              amountPaise: captured.amount,
              currency: captured.currency,
              method: captured.method ?? null,
              via: "reconcile",
            }),
          );
          if (res.outcome === "confirmed") await afterPaid(res.orderId!);
          if (res.outcome === "confirmed" || res.outcome === "already") {
            out.paid.push(r.number);
            continue;
          }
        } else if (payments.some((p) => p.status === "authorized")) {
          out.waiting.push(r.number); // being captured right now
          continue;
        }
      } catch (err) {
        const ageHours = (Date.now() - new Date(r.created_at).getTime()) / 3_600_000;
        if (ageHours < 6) {
          console.warn("[payments] reconcile lookup failed; will retry", r.number, err instanceof Error ? err.message : err);
          out.waiting.push(r.number);
          continue;
        }
      }
    }
    const released = await transaction(async (q) => {
      const done = await cancelUnpaidOnlineOrder(q, r.id, "Online payment not completed in time");
      if (done) await q("UPDATE payments SET status = 'expired', updated_at = now() WHERE order_id = $1 AND status IN ('created','failed')", [r.id]);
      return done;
    });
    if (released) out.released.push(r.number);
  }
  return out;
}

const RELEASE_EVERY_MS = 5 * 60 * 1000;
let lastRelease = 0;

/** Throttled background release (at most every 5 minutes per server instance). Never throws. */
export function releaseUnpaidOrdersSoon(): void {
  const now = Date.now();
  if (now - lastRelease < RELEASE_EVERY_MS) return;
  lastRelease = now;
  const task = () => releaseUnpaidOrders().then(
    () => undefined,
    (err) => console.error("[payments] release failed", err instanceof Error ? err.message : err),
  );
  try {
    after(task); // after the response, kept alive on serverless hosts
  } catch {
    void task();
  }
}

/* ------------------------------------------------------------ read views */

export async function adminPaymentSummary(orderId: string): Promise<AdminPaymentSummary | null> {
  const o = (
    await sql<{ status: string; payment_method: PaymentMethod; payment_status: PaymentStatus }>(
      "SELECT status, payment_method, payment_status FROM orders WHERE id = $1",
      [orderId],
    )
  )[0];
  if (!o) return null;
  const payments = await sql<{
    id: string;
    razorpay_order_id: string;
    razorpay_payment_id: string | null;
    amount_paise: number;
    status: AdminPaymentRow["status"];
    method: string | null;
    error_description: string | null;
    failed_attempts: number;
    verified_via: string | null;
    paid_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, razorpay_order_id, razorpay_payment_id, amount_paise, status, method, error_description, failed_attempts, verified_via, paid_at, created_at
       FROM payments WHERE order_id = $1 ORDER BY created_at`,
    [orderId],
  );
  const refunds = await sql<{
    id: string;
    razorpay_refund_id: string | null;
    amount_paise: number;
    status: RefundStatus;
    reason: string;
    source: "admin" | "dashboard";
    created_by: string;
    error: string | null;
    created_at: Date;
    processed_at: Date | null;
  }>(
    `SELECT id, razorpay_refund_id, amount_paise, status, reason, source, created_by, error, created_at, processed_at
       FROM refunds WHERE order_id = $1 ORDER BY created_at`,
    [orderId],
  );
  const closedParts = await sql<{ n: number }>(
    "SELECT COALESCE(sum(subtotal), 0)::int AS n FROM vendor_orders WHERE order_id = $1 AND status IN ('cancelled','returned')",
    [orderId],
  );

  const paid = payments.find((p) => p.status === "paid");
  const paidPaise = paid?.amount_paise ?? 0;
  const refundedPaise = refunds.filter((r) => r.status !== "failed").reduce((n, r) => n + r.amount_paise, 0);
  const refundablePaise = Math.max(0, paidPaise - refundedPaise);
  const suggested =
    o.status === "cancelled" ? refundablePaise : Math.max(0, Math.min(refundablePaise, (closedParts[0]?.n ?? 0) * 100 - refundedPaise));

  return {
    method: o.payment_method,
    status: o.payment_status,
    configured: onlinePaymentsEnabled(),
    payments: payments.map((p) => ({
      id: p.id,
      razorpayOrderId: p.razorpay_order_id,
      razorpayPaymentId: p.razorpay_payment_id,
      amountPaise: p.amount_paise,
      status: p.status,
      method: p.method,
      error: p.error_description,
      failedAttempts: p.failed_attempts,
      verifiedVia: p.verified_via,
      paidAt: iso(p.paid_at),
      createdAt: iso(p.created_at)!,
    })),
    refunds: refunds.map(
      (r): AdminRefundRow => ({
        id: r.id,
        razorpayRefundId: r.razorpay_refund_id,
        amountPaise: r.amount_paise,
        status: r.status,
        reason: r.reason,
        source: r.source,
        createdBy: r.created_by,
        error: r.error,
        createdAt: iso(r.created_at)!,
        processedAt: iso(r.processed_at),
      }),
    ),
    paidPaise,
    refundedPaise,
    refundablePaise,
    suggestedRefundPaise: suggested,
    paidAfterCancel: o.status === "cancelled" && refundablePaise > 0,
  };
}

const dayFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

/**
 * Payment facts for a signed-in customer's own order (identity from the session: pass the
 * session's customer id). Null when the order isn't theirs.
 */
export async function customerOrderPayment(customerId: string, number: string): Promise<CustomerPaymentView | null> {
  const o = (
    await sql<{ id: string; status: string; payment_method: PaymentMethod; payment_status: PaymentStatus; paid_at: Date | null }>(
      "SELECT id, status, payment_method, payment_status, paid_at FROM orders WHERE number = $1 AND customer_id = $2",
      [number, customerId],
    )
  )[0];
  if (!o) return null;
  const refunds = await sql<{ amount_paise: number; status: RefundStatus; created_at: Date }>(
    "SELECT amount_paise, status, created_at FROM refunds WHERE order_id = $1 AND status <> 'failed' ORDER BY created_at",
    [o.id],
  );
  const live = refunds.filter((r) => r.status === "pending" || r.status === "processed");
  const refundedPaise = live.reduce((n, r) => n + r.amount_paise, 0);
  const inProgress = live.some((r) => r.status === "pending");

  let label: string;
  if (o.payment_method !== "online") {
    label =
      o.payment_status === "paid" ? "Paid" : o.payment_method === "counter" ? "Pay at the shop counter" : "Old WhatsApp order: payment arranged outside the site";
  } else if (o.payment_status === "paid") {
    label = o.paid_at ? `Paid online on ${dayFmt.format(new Date(o.paid_at))}` : "Paid online";
  } else if (o.payment_status === "refunded") {
    label = inProgress ? `Refund of ${paiseToText(refundedPaise)} in progress` : "Refunded in full";
  } else if (o.payment_status === "partially_refunded") {
    label = `${inProgress ? "Refund in progress" : "Refunded"}: ${paiseToText(refundedPaise)}`;
  } else if (o.status === "cancelled") {
    label = "Payment not received; order cancelled";
  } else {
    label = o.payment_status === "failed" ? "Payment didn't go through" : PAYMENT_STATUS_LABELS.pending;
  }

  return {
    method: o.payment_method,
    status: o.payment_status,
    label,
    paidAt: iso(o.paid_at),
    refundedRupees: Math.floor(refundedPaise / 100),
    refunds: live.map((r) => ({ amountRupees: Math.floor(r.amount_paise / 100), status: r.status, at: iso(r.created_at)! })),
  };
}
