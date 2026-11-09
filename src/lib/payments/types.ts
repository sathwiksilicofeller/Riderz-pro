/**
 * Payment types and labels shared by the server, the cart and the admin / account pages.
 * Client-safe: no secrets, no server imports.
 *
 * Units: order totals are integer RUPEES (as everywhere on the site). Anything named `*Paise`
 * is integer PAISE (1 rupee = 100 paise), the unit Razorpay uses.
 */

export type PaymentMethod = "whatsapp" | "cod" | "online" | "counter";
export type PaymentStatus = "pending" | "paid" | "failed" | "refunded" | "partially_refunded";
export type RefundStatus = "requested" | "pending" | "processed" | "failed";

/**
 * New website orders are online only and shop screen orders are "online" or "counter".
 * "whatsapp" and "cod" stay so orders placed before that still read correctly.
 */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  whatsapp: "Old WhatsApp order",
  cod: "Cash on delivery (old order)",
  online: "Paid online",
  counter: "Pay at the shop counter",
};

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  pending: "Awaiting payment",
  paid: "Paid",
  failed: "Payment failed",
  refunded: "Refunded",
  partially_refunded: "Partly refunded",
};

export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
  requested: "Sent to Razorpay",
  pending: "Refund in progress",
  processed: "Refunded",
  failed: "Refund failed",
};

/** Minutes an unpaid online order holds its stock before it is cancelled and the stock released. */
export const UNPAID_HOLD_MINUTES = 30;

/** What the browser needs to open Razorpay Checkout. Never contains a secret. */
export type OnlinePaymentStart = {
  keyId: string;
  razorpayOrderId: string;
  /** Integer paise, exactly as the Razorpay order was created. */
  amountPaise: number;
  currency: "INR";
  /** Checkout closes itself after this many seconds (well inside the hold time). */
  timeoutSeconds: number;
};

/** Payment facts for the customer's own order page (/account/orders/[number]). */
export type CustomerPaymentView = {
  method: PaymentMethod;
  status: PaymentStatus;
  /** Plain words for the customer, e.g. "Paid online on 17 Oct" or "Refund of ₹500 in progress". */
  label: string;
  paidAt: string | null;
  /** Integer rupees refunded or being refunded (pending + processed). */
  refundedRupees: number;
  refunds: { amountRupees: number; status: RefundStatus; at: string }[];
};

export type AdminPaymentRow = {
  id: string;
  razorpayOrderId: string;
  razorpayPaymentId: string | null;
  amountPaise: number;
  status: "created" | "failed" | "paid" | "expired";
  method: string | null;
  error: string | null;
  failedAttempts: number;
  verifiedVia: string | null;
  paidAt: string | null;
  createdAt: string;
};

export type AdminRefundRow = {
  id: string;
  razorpayRefundId: string | null;
  amountPaise: number;
  status: RefundStatus;
  reason: string;
  source: "admin" | "dashboard";
  createdBy: string;
  error: string | null;
  createdAt: string;
  processedAt: string | null;
};

export type AdminPaymentSummary = {
  method: PaymentMethod;
  status: PaymentStatus;
  configured: boolean;
  payments: AdminPaymentRow[];
  refunds: AdminRefundRow[];
  paidPaise: number;
  /** Requested + pending + processed refunds (what counts against the limit). */
  refundedPaise: number;
  /** Most that can still be refunded. */
  refundablePaise: number;
  /** A sensible default for the refund box: the whole remainder for a cancelled order, else cancelled/returned seller parts. */
  suggestedRefundPaise: number;
  /** Payment arrived after the order had been cancelled (e.g. expired unpaid): refund it. */
  paidAfterCancel: boolean;
};

/** "₹1,234" or "₹1,234.50" from paise. */
export function paiseToText(paise: number): string {
  const rupees = paise / 100;
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(rupees);
}
