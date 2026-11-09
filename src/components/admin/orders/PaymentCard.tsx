import { fmtDateTime } from "@/components/vendor/orders/format";
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  REFUND_STATUS_LABELS,
  paiseToText,
  type AdminPaymentSummary,
  type PaymentStatus,
} from "@/lib/payments/types";
import { RefundForm } from "./RefundForm";

export const PAYMENT_TONE: Record<PaymentStatus, string> = {
  pending: "text-gold border-gold/40",
  paid: "text-accent border-accent/40",
  failed: "text-danger border-danger/40",
  refunded: "text-ash border-tint/30",
  partially_refunded: "text-gold border-gold/40",
};

/** The admin order page's payment card: Razorpay attempts, refunds, and the refund form. */
export function PaymentCard({ orderId, summary }: { orderId: string; summary: AdminPaymentSummary }) {
  const s = summary;
  return (
    <div className="card p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="eyebrow">Payment</h2>
        <span className={`chip bg-transparent ${PAYMENT_TONE[s.status]}`}>
          {s.method === "online" ? PAYMENT_STATUS_LABELS[s.status] : PAYMENT_METHOD_LABELS[s.method]}
        </span>
      </div>

      {s.method === "counter" ? (
        <p className="text-xs text-ash">Shop screen order, paid at the seller&apos;s counter. The seller collects the money, so it isn&apos;t tracked here.</p>
      ) : s.method !== "online" ? (
        <p className="text-xs text-ash">
          Placed before checkout went online only. Payment was arranged with the customer outside the site and isn&apos;t tracked here.
        </p>
      ) : (
        <>
          {s.paidAfterCancel && (
            <p role="alert" className="mb-3 rounded-sm border border-danger/40 p-3 text-xs text-danger">
              This order is cancelled but {paiseToText(s.refundablePaise)} of its payment hasn&apos;t been refunded. Refund it below.
            </p>
          )}
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between"><dt className="text-ash">Paid</dt><dd className="tnum">{paiseToText(s.paidPaise)}</dd></div>
            <div className="flex justify-between"><dt className="text-ash">Refunded or in progress</dt><dd className="tnum">{paiseToText(s.refundedPaise)}</dd></div>
            <div className="flex justify-between border-t border-tint/8 pt-1.5"><dt className="font-bold">Refundable</dt><dd className="tnum font-bold">{paiseToText(s.refundablePaise)}</dd></div>
          </dl>

          <ul className="mt-4 space-y-2 border-t border-tint/8 pt-3 text-xs">
            {s.payments.map((p) => (
              <li key={p.id} className="text-ash">
                <span className="font-semibold text-chalk">{paiseToText(p.amountPaise)}</span> · {p.status}
                {p.method ? ` · ${p.method}` : ""}
                <br />
                <span className="break-all">{p.razorpayOrderId}{p.razorpayPaymentId ? ` · ${p.razorpayPaymentId}` : ""}</span>
                <br />
                {p.paidAt ? `Paid ${fmtDateTime(p.paidAt)} (confirmed by ${p.verifiedVia})` : `Started ${fmtDateTime(p.createdAt)}`}
                {p.failedAttempts > 0 ? ` · ${p.failedAttempts} failed attempt${p.failedAttempts === 1 ? "" : "s"}` : ""}
                {p.error ? ` · last error: ${p.error}` : ""}
              </li>
            ))}
            {s.payments.length === 0 && <li className="text-ash">No Razorpay order was created.</li>}
          </ul>

          {s.refunds.length > 0 && (
            <ul className="mt-3 space-y-2 border-t border-tint/8 pt-3 text-xs">
              {s.refunds.map((r) => (
                <li key={r.id} className="text-ash">
                  <span className="font-semibold text-chalk">{paiseToText(r.amountPaise)}</span> · {REFUND_STATUS_LABELS[r.status]} ·{" "}
                  {fmtDateTime(r.createdAt)} by {r.createdBy}
                  <br />
                  {r.reason}
                  {r.razorpayRefundId ? ` · ${r.razorpayRefundId}` : ""}
                  {r.error ? <span className="text-danger"> · {r.error}</span> : null}
                </li>
              ))}
            </ul>
          )}

          {s.refundablePaise > 0 &&
            (s.configured ? (
              <RefundForm orderId={orderId} refundablePaise={s.refundablePaise} suggestedPaise={s.suggestedRefundPaise} />
            ) : (
              <p className="mt-4 border-t border-tint/8 pt-3 text-xs text-dim">Razorpay keys aren&apos;t set here, so refunds can&apos;t be sent.</p>
            ))}
        </>
      )}
    </div>
  );
}
