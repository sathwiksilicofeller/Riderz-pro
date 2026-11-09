import "server-only";

import { sql, transaction } from "@/lib/db/client";
import { SETTLEMENT_DELAY_DAYS, settlementFor } from "@/lib/vendor/types";
import type { PayoutOverview, PayoutRow, SettlementRow, DueVendor } from "@/components/vendor/payments/types";
import { ApiError } from "./http";
import { newId } from "./security";
import { audit, notifyVendor } from "./vendors";

/**
 * PAYOUTS
 *
 * A vendor order becomes payable SETTLEMENT_DELAY_DAYS after delivery (the
 * return window). Until an admin records a bank transfer against it, it has no
 * payout_id. Amounts are always recomputed here from the stored subtotal and the
 * commission rate snapshotted when the order was placed — never taken from a client.
 * Offline Store screen sales (orders.channel = 'store') carry no commission: until paid out,
 * their rate is read as 0 whatever is stored (STORE_FREE_RATE).
 */

/** The commission rate to settle at: 0 for an unpaid Offline Store screen sale. Needs `vo` and `o`. */
const STORE_FREE_RATE = "CASE WHEN o.channel = 'store' AND vo.payout_id IS NULL THEN 0 ELSE vo.commission_rate END AS commission_rate";

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

type SettleRow = {
  id: string;
  number: string;
  subtotal: number;
  commission_rate: string;
  delivered_at: Date;
  due: boolean;
  payout_id: string | null;
  reference: string | null;
};

export async function payoutOverview(vendorId: string): Promise<PayoutOverview> {
  const rows = await sql<SettleRow>(
    `SELECT vo.id, o.number, vo.subtotal, ${STORE_FREE_RATE}, vo.delivered_at, vo.payout_id, p.reference,
            (vo.delivered_at <= now() - make_interval(days => $2)) AS due
       FROM vendor_orders vo JOIN orders o ON o.id = vo.order_id
       LEFT JOIN vendor_payouts p ON p.id = vo.payout_id
      WHERE vo.vendor_id = $1 AND vo.status = 'delivered' AND vo.delivered_at IS NOT NULL AND vo.collected_by = 'platform'
      ORDER BY vo.delivered_at DESC LIMIT 500`,
    [vendorId, SETTLEMENT_DELAY_DAYS],
  );
  const settlements: SettlementRow[] = rows.map((r) => ({
    id: r.id,
    number: r.number,
    deliveredAt: iso(r.delivered_at)!,
    state: r.payout_id ? "paid" : r.due ? "due" : "in_window",
    reference: r.reference,
    ...settlementFor(r.subtotal, Number(r.commission_rate)),
  }));

  const payouts = (
    await sql<{ id: string; gross: number; commission: number; commission_gst: number; net: number; reference: string | null; paid_at: Date | null; created_at: Date; orders: number }>(
      `SELECT p.id, p.gross, p.commission, p.commission_gst, p.net, p.reference, p.paid_at, p.created_at,
              (SELECT count(*)::int FROM vendor_orders vo WHERE vo.payout_id = p.id) AS orders
         FROM vendor_payouts p WHERE p.vendor_id = $1 AND p.status = 'paid' ORDER BY p.created_at DESC LIMIT 100`,
      [vendorId],
    )
  ).map<PayoutRow>((p) => ({
    id: p.id,
    gross: p.gross,
    commission: p.commission,
    commissionGst: p.commission_gst,
    net: p.net,
    reference: p.reference,
    paidAt: iso(p.paid_at ?? p.created_at)!,
    orders: p.orders,
  }));

  const sum = (state: SettlementRow["state"]) => {
    const list = settlements.filter((s) => s.state === state);
    return { count: list.length, net: list.reduce((n, s) => n + s.net, 0) };
  };

  const bank = (
    await sql<{ bank_holder: string | null; bank_account_last4: string | null; bank_ifsc: string | null }>(
      "SELECT bank_holder, bank_account_last4, bank_ifsc FROM vendor_secrets WHERE vendor_id = $1",
      [vendorId],
    )
  )[0];

  return {
    delayDays: SETTLEMENT_DELAY_DAYS,
    summary: {
      inWindow: sum("in_window"),
      due: sum("due"),
      paid: { count: payouts.length, net: payouts.reduce((n, p) => n + p.net, 0) },
    },
    settlements,
    payouts,
    bank:
      bank?.bank_account_last4 && bank.bank_ifsc
        ? { holder: bank.bank_holder ?? "", last4: bank.bank_account_last4, ifsc: bank.bank_ifsc }
        : null,
  };
}

/* ------------------------------------------------------------------ admin */

/** Vendors with money due, and the orders that make it up. Bank number is masked (last four only). */
export async function dueVendors(): Promise<DueVendor[]> {
  const rows = await sql<{
    vendor_order_id: string;
    vendor_id: string;
    store_name: string | null;
    number: string;
    subtotal: number;
    commission_rate: string;
    delivered_at: Date;
    bank_holder: string | null;
    bank_account_last4: string | null;
    bank_ifsc: string | null;
  }>(
    `SELECT vo.id AS vendor_order_id, vo.vendor_id, v.store_name, o.number, vo.subtotal, ${STORE_FREE_RATE}, vo.delivered_at,
            s.bank_holder, s.bank_account_last4, s.bank_ifsc
       FROM vendor_orders vo
       JOIN orders o ON o.id = vo.order_id
       JOIN vendors v ON v.id = vo.vendor_id
       LEFT JOIN vendor_secrets s ON s.vendor_id = vo.vendor_id
      WHERE vo.status = 'delivered' AND vo.payout_id IS NULL AND vo.collected_by = 'platform'
        AND vo.delivered_at <= now() - make_interval(days => $1)
      ORDER BY v.store_name, vo.delivered_at`,
    [SETTLEMENT_DELAY_DAYS],
  );
  const byVendor = new Map<string, DueVendor>();
  for (const r of rows) {
    let v = byVendor.get(r.vendor_id);
    if (!v) {
      v = {
        vendorId: r.vendor_id,
        storeName: r.store_name ?? "Seller",
        bank:
          r.bank_account_last4 && r.bank_ifsc
            ? { holder: r.bank_holder ?? "", last4: r.bank_account_last4, ifsc: r.bank_ifsc }
            : null,
        orders: [],
        net: 0,
      };
      byVendor.set(r.vendor_id, v);
    }
    const s = settlementFor(r.subtotal, Number(r.commission_rate));
    v.orders.push({ id: r.vendor_order_id, number: r.number, deliveredAt: iso(r.delivered_at)!, ...s });
    v.net += s.net;
  }
  return [...byVendor.values()];
}

/** Record a bank transfer made by hand against some delivered, unpaid, past-the-window orders of one vendor. */
export async function recordPayout(
  actor: string,
  input: { vendorId: string; vendorOrderIds: string[]; reference: string },
): Promise<{ id: string; net: number; orders: number }> {
  const ids = [...new Set(input.vendorOrderIds)];
  const result = await transaction(async (q) => {
    const rows = await q<{ id: string; subtotal: number; commission_rate: string }>(
      `SELECT vo.id, vo.subtotal, ${STORE_FREE_RATE}
         FROM vendor_orders vo JOIN orders o ON o.id = vo.order_id
        WHERE vo.id = ANY($1) AND vo.vendor_id = $2 AND vo.status = 'delivered' AND vo.payout_id IS NULL AND vo.collected_by = 'platform'
          AND vo.delivered_at <= now() - make_interval(days => $3)
        FOR UPDATE OF vo`,
      [ids, input.vendorId, SETTLEMENT_DELAY_DAYS],
    );
    if (rows.length !== ids.length) {
      throw new ApiError(409, "not_payable", "Some of those orders are not payable (already paid, not delivered, or still in the return window). Refresh and try again.");
    }
    const total = { gross: 0, commission: 0, commissionGst: 0, net: 0 };
    for (const r of rows) {
      const s = settlementFor(r.subtotal, Number(r.commission_rate));
      total.gross += s.gross;
      total.commission += s.commission;
      total.commissionGst += s.commissionGst;
      total.net += s.net;
    }
    const id = newId("pay");
    await q(
      `INSERT INTO vendor_payouts (id, vendor_id, gross, commission, commission_gst, net, status, reference, paid_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'paid',$7,now(),$8)`,
      [id, input.vendorId, total.gross, total.commission, total.commissionGst, total.net, input.reference, actor],
    );
    await q("UPDATE vendor_orders SET payout_id = $1, updated_at = now() WHERE id = ANY($2)", [id, ids]);
    await audit(
      { type: "admin", id: actor },
      "payout.record",
      { vendorId: input.vendorId, detail: { payoutId: id, reference: input.reference, net: total.net, orders: ids.length } },
      q,
    );
    await notifyVendor(
      input.vendorId,
      {
        type: "payout",
        title: "Payout sent",
        body: `Rs ${total.net.toLocaleString("en-IN")} for ${ids.length} order${ids.length === 1 ? "" : "s"}. Reference ${input.reference}.`,
        link: "/vendor/dashboard/payments",
      },
      q,
    );
    return { id, net: total.net, orders: ids.length };
  });
  return result;
}
