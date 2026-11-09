import "server-only";

import { sql, sqlOne } from "@/lib/db/client";
import { SITE } from "@/lib/data/site";
import { rupees } from "@/lib/format";
import { issueCustomerInvoice } from "./customer-invoice";
import { env, sendEmail, sendOnce, sendTemplateSms, type SendResult } from "./messaging";

/**
 * ORDER CONFIRMATION (email + SMS)
 *
 * `onOrderConfirmedMessages(orderId)` is the one call to make once an order is confirmed: paid online
 * (Razorpay webhook / signature check), or an old WhatsApp / cash on delivery order an admin confirms. It issues the
 * Riderzpro tax invoice, then emails and texts the customer, each once per order (message_log).
 * It never throws: messages must not undo an order.
 */

/** Absolute links in messages. NEXT_PUBLIC_SITE_URL overrides the live address (e.g. a preview). */
export const siteUrl = () => (env("NEXT_PUBLIC_SITE_URL") || SITE.url).replace(/\/+$/, "");

type OrderForMail = {
  id: string;
  number: string;
  status: string;
  customer_name: string;
  customer_phone: string;
  customer_email: string | null;
  account_email: string | null;
  address: string;
  city: string;
  state: string;
  pincode: string;
  subtotal: number;
  shipping: number;
  discount: number;
  coupon_code: string | null;
  total: number;
  created_at: Date;
};

type ItemForMail = { title: string; variant: string | null; qty: number; unit_price: number; install_price: number; line_total: number; seller: string | null };

const loadOrder = (orderId: string) =>
  sqlOne<OrderForMail>(
    `SELECT o.id, o.number, o.status, o.customer_name, o.customer_phone, o.customer_email,
            CASE WHEN c.email_verified_at IS NOT NULL THEN c.email END AS account_email,
            o.address, o.city, o.state, o.pincode, o.subtotal, o.shipping, o.discount, o.coupon_code, o.total, o.created_at
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1`,
    [orderId],
  );

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The email, as HTML and plain text. Exported for the test script. */
export function confirmationEmail(o: OrderForMail, items: ItemForMail[], invoiceNumber: string | null) {
  const base = siteUrl();
  const orderUrl = `${base}/account/orders/${encodeURIComponent(o.number)}`;
  const invoiceUrl = `${orderUrl}/invoice`;
  const first = o.customer_name.trim().split(/\s+/)[0] || "there";
  const subject = `Order ${o.number} confirmed: ${rupees(o.total)}`;
  const itemText = (i: ItemForMail) =>
    `${i.title}${i.variant ? ` (${i.variant})` : ""} x ${i.qty}${i.install_price ? " + installation" : ""}${i.seller ? `, sold by ${i.seller}` : ""}: ${rupees(i.line_total)}`;

  const text = [
    `Hi ${first},`,
    "",
    `Thank you for shopping with Riderzpro. Your order ${o.number} is confirmed.`,
    "",
    ...items.map((i) => `- ${itemText(i)}`),
    "",
    `Items: ${rupees(o.subtotal)}`,
    `Delivery: ${o.shipping ? rupees(o.shipping) : "Free"}`,
    ...(o.coupon_code ? [`Coupon ${o.coupon_code}: ${o.discount ? `-${rupees(o.discount)}` : "free delivery"}`] : []),
    `Total: ${rupees(o.total)} (prices include GST)`,
    "",
    "Delivering to:",
    o.customer_name,
    o.address,
    `${o.city}, ${o.state} ${o.pincode}`,
    `+91 ${o.customer_phone}`,
    "",
    `Track your order: ${orderUrl}`,
    ...(invoiceNumber ? [`Tax invoice ${invoiceNumber}: ${invoiceUrl}`] : []),
    "(Sign in with the mobile number you ordered with to see it.)",
    "",
    `Questions? Reply to this email, write to ${SITE.email} or call ${SITE.phone}.`,
    "",
    `Riderzpro (${SITE.legalName})`,
  ].join("\n");

  const td = 'style="padding:8px 0;border-bottom:1px solid #eee;vertical-align:top"';
  const tdR = 'style="padding:8px 0 8px 12px;border-bottom:1px solid #eee;text-align:right;vertical-align:top;white-space:nowrap"';
  const row = (label: string, value: string, strong = false) =>
    `<tr><td style="padding:4px 0;${strong ? "font-weight:700" : "color:#555"}">${label}</td><td style="padding:4px 0;text-align:right;${strong ? "font-weight:700" : ""}">${value}</td></tr>`;
  const html = `<!doctype html><html><body style="margin:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#111">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:8px">
<tr><td style="padding:24px 24px 8px"><p style="margin:0;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#888">Riderzpro</p>
<h1 style="margin:8px 0 0;font-size:22px">Order ${esc(o.number)} is confirmed</h1>
<p style="margin:12px 0 0;font-size:14px;line-height:1.5">Hi ${esc(first)}, thank you for shopping with Riderzpro.</p></td></tr>
<tr><td style="padding:16px 24px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
${items
  .map(
    (i) =>
      `<tr><td ${td}>${esc(i.title)}${i.variant ? `<br><span style="color:#777;font-size:12px">${esc(i.variant)}</span>` : ""}<br><span style="color:#777;font-size:12px">Qty ${i.qty}${i.install_price ? " · with installation" : ""}${i.seller ? ` · sold by ${esc(i.seller)}` : ""}</span></td><td ${tdR}>${rupees(i.line_total)}</td></tr>`,
  )
  .join("\n")}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin-top:8px">
${row("Items", rupees(o.subtotal))}${row("Delivery", o.shipping ? rupees(o.shipping) : "Free")}${o.coupon_code ? row(`Coupon ${esc(o.coupon_code)}`, o.discount ? `-${rupees(o.discount)}` : "Free delivery") : ""}${row("Total", rupees(o.total), true)}
</table><p style="margin:4px 0 0;font-size:12px;color:#777">Prices include GST.</p></td></tr>
<tr><td style="padding:0 24px 16px;font-size:14px;line-height:1.5"><p style="margin:0;font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#888">Delivering to</p>
<p style="margin:6px 0 0">${esc(o.customer_name)}<br>${esc(o.address)}<br>${esc(o.city)}, ${esc(o.state)} ${esc(o.pincode)}<br>+91 ${esc(o.customer_phone)}</p></td></tr>
<tr><td style="padding:0 24px 24px"><a href="${esc(orderUrl)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:6px;font-size:14px;font-weight:700">Track your order</a>
${invoiceNumber ? `<a href="${esc(invoiceUrl)}" style="display:inline-block;margin-left:8px;color:#111;font-size:14px">Tax invoice ${esc(invoiceNumber)}</a>` : ""}
<p style="margin:12px 0 0;font-size:12px;color:#777">Sign in with the mobile number you ordered with to see your order.</p></td></tr>
<tr><td style="padding:16px 24px;border-top:1px solid #eee;font-size:12px;color:#777;line-height:1.5">Questions? Reply to this email, write to ${esc(SITE.email)} or call ${esc(SITE.phone)}.<br>Riderzpro · ${esc(SITE.legalName)}</td></tr>
</table></td></tr></table></body></html>`;

  return { subject, text, html, orderUrl, invoiceUrl };
}

const skipped = (reason: string): SendResult => ({ status: "skipped", providerId: null, reason });

/** The confirmation email, once per order. Goes to the email given at checkout, else the account's verified one. */
export async function sendOrderConfirmation(orderId: string): Promise<SendResult> {
  const o = await loadOrder(orderId);
  if (!o) return skipped("no_order");
  if (o.status === "cancelled") return skipped("cancelled");
  const to = o.customer_email || o.account_email;
  if (!to) return skipped("no_email");
  return sendOnce({ kind: "order_confirmation", orderId, channel: "email" }, async () => {
    const items = await sql<ItemForMail>(
      `SELECT i.title, i.variant, i.qty, i.unit_price, i.install_price, i.line_total, v.store_name AS seller
         FROM order_items i
         LEFT JOIN vendor_orders vo ON vo.id = i.vendor_order_id
         LEFT JOIN vendors v ON v.id = vo.vendor_id
        WHERE i.order_id = $1 ORDER BY i.id`,
      [orderId],
    );
    const inv = await sqlOne<{ number: string }>("SELECT number FROM customer_invoices WHERE order_id = $1", [orderId]);
    const mail = confirmationEmail(o, items, inv?.number ?? null);
    return sendEmail({ to, subject: mail.subject, html: mail.html, text: mail.text, replyTo: SITE.email });
  });
}

/** "Order confirmed" SMS (DLT template MSG91_TEMPLATE_ORDER_CONFIRMED), once per order. */
export async function smsOrderConfirmed(orderId: string): Promise<SendResult> {
  const o = await loadOrder(orderId);
  if (!o) return skipped("no_order");
  if (o.status === "cancelled") return skipped("cancelled");
  return sendOnce({ kind: "order_confirmed", orderId, channel: "sms" }, () =>
    // DLT variables hold at most 30 characters, so the link goes without "https://".
    sendTemplateSms("order_confirmed", o.customer_phone, [o.number, String(o.total), `${siteUrl().replace(/^https?:\/\//, "")}/account/orders`]),
  );
}

export type ConfirmedMessages = { invoice: string | null; email: SendResult; sms: SendResult };

/**
 * Everything that follows a confirmed order: the tax invoice, the email and the SMS. Idempotent (safe
 * to call from both the payment webhook and the browser's payment callback). Never throws.
 */
export async function onOrderConfirmedMessages(orderId: string): Promise<ConfirmedMessages> {
  const failed = (step: string, err: unknown): SendResult => {
    console.error(`[order-messages] ${step} failed:`, err instanceof Error ? err.message : "error");
    return { status: "failed", providerId: null, reason: "error" };
  };
  let invoice: string | null = null;
  try {
    invoice = (await issueCustomerInvoice(orderId))?.number ?? null;
  } catch (err) {
    failed("invoice", err);
  }
  const email = await sendOrderConfirmation(orderId).catch((err) => failed("email", err));
  const sms = await smsOrderConfirmed(orderId).catch((err) => failed("sms", err));
  return { invoice, email, sms };
}
