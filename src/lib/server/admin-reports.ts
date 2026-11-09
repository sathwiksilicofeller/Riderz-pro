import "server-only";

import { sql, sqlOne, containsPattern } from "@/lib/db/client";
import { settlementFor } from "@/lib/vendor/types";

/**
 * ADMIN: CUSTOMERS AND REPORTS (read only, real data)
 *
 * Customers: accounts with their orders, addresses and messages. Guest orders that never joined an
 * account are not customers here (they are on /admin/orders).
 *
 * Reports: one date range (India time) over orders placed in it. Money is integer rupees, from the
 * orders as stored (server-priced), cancelled orders shown apart and left out of sales.
 *   sales          totals of orders not cancelled
 *   marketplace    seller parts: gross, and Riderzpro's commission on parts delivered in the range
 *   online         Razorpay money in (paid) and refunds processed in the range
 */

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/* -------------------------------------------------------------- customers */

export type AdminCustomerRow = {
  id: string;
  name: string | null;
  mobile: string | null;
  email: string | null;
  mobileVerified: boolean;
  emailVerified: boolean;
  orders: number;
  spent: number;
  lastOrderAt: string | null;
  createdAt: string;
};

export async function listCustomersAdmin(q?: string, before?: string): Promise<{ rows: AdminCustomerRow[]; next: string | null }> {
  const LIMIT = 50;
  const term = q?.trim().slice(0, 80) || null;
  const rows = await sql<{ id: string; name: string | null; mobile: string | null; email: string | null; mobile_verified_at: Date | null; email_verified_at: Date | null; orders: number; spent: number; last_order_at: Date | null; created_at: Date }>(
    `SELECT c.id, c.name, c.mobile, c.email, c.mobile_verified_at, c.email_verified_at, c.created_at,
            count(o.id)::int AS orders, COALESCE(sum(o.total), 0)::int AS spent, max(o.created_at) AS last_order_at
       FROM customers c
       LEFT JOIN orders o ON o.customer_id = c.id AND o.status <> 'cancelled'
      WHERE ($1::text IS NULL OR c.name ILIKE $1 OR c.mobile LIKE $1 OR c.email ILIKE $1)
        AND ($2::timestamptz IS NULL OR c.created_at < $2)
      GROUP BY c.id ORDER BY c.created_at DESC LIMIT ${LIMIT + 1}`,
    [term ? containsPattern(term) : null, before ?? null],
  );
  const page = rows.slice(0, LIMIT).map((r) => ({
    id: r.id,
    name: r.name,
    mobile: r.mobile,
    email: r.email,
    mobileVerified: r.mobile_verified_at !== null,
    emailVerified: r.email_verified_at !== null,
    orders: r.orders,
    spent: r.spent,
    lastOrderAt: iso(r.last_order_at),
    createdAt: iso(r.created_at) as string,
  }));
  return { rows: page, next: rows.length > LIMIT ? page[page.length - 1].createdAt : null };
}

export type AdminCustomerDetail = AdminCustomerRow & {
  car: { make?: string; model?: string; variant?: string; year?: number } | null;
  lastLoginAt: string | null;
  sessions: number;
  wishlist: number;
  addresses: { label: string; name: string; mobile: string; line: string; isDefault: boolean }[];
  orderList: { id: string; number: string; status: string; total: number; paymentMethod: string; paymentStatus: string; createdAt: string }[];
  tickets: { id: string; topic: string; status: string; orderNumber: string | null; createdAt: string }[];
};

export async function customerDetailAdmin(id: string): Promise<AdminCustomerDetail | null> {
  const c = await sqlOne<{ id: string; name: string | null; mobile: string | null; email: string | null; mobile_verified_at: Date | null; email_verified_at: Date | null; car: AdminCustomerDetail["car"]; last_login_at: Date | null; created_at: Date; sessions: number; wishlist: number }>(
    `SELECT c.id, c.name, c.mobile, c.email, c.mobile_verified_at, c.email_verified_at, c.car, c.last_login_at, c.created_at,
            (SELECT count(*)::int FROM customer_sessions s WHERE s.customer_id = c.id AND s.expires_at > now()) AS sessions,
            (SELECT count(*)::int FROM customer_wishlist w WHERE w.customer_id = c.id) AS wishlist
       FROM customers c WHERE c.id = $1`,
    [id],
  );
  if (!c) return null;
  const [addresses, orders, tickets] = await Promise.all([
    sql<{ label: string; name: string; mobile: string; address: string; city: string; state: string; pincode: string; is_default: boolean }>(
      "SELECT label, name, mobile, address, city, state, pincode, is_default FROM customer_addresses WHERE customer_id = $1 ORDER BY is_default DESC, created_at",
      [id],
    ),
    sql<{ id: string; number: string; status: string; total: number; payment_method: string; payment_status: string; created_at: Date }>(
      "SELECT id, number, status, total, payment_method, payment_status, created_at FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 100",
      [id],
    ),
    sql<{ id: string; topic: string; status: string; order_number: string | null; created_at: Date }>(
      "SELECT id, topic, status, order_number, created_at FROM customer_tickets WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50",
      [id],
    ),
  ]);
  const live = orders.filter((o) => o.status !== "cancelled");
  return {
    id: c.id,
    name: c.name,
    mobile: c.mobile,
    email: c.email,
    mobileVerified: c.mobile_verified_at !== null,
    emailVerified: c.email_verified_at !== null,
    orders: live.length,
    spent: live.reduce((n, o) => n + o.total, 0),
    lastOrderAt: iso(orders[0]?.created_at ?? null),
    createdAt: iso(c.created_at) as string,
    car: c.car,
    lastLoginAt: iso(c.last_login_at),
    sessions: c.sessions,
    wishlist: c.wishlist,
    addresses: addresses.map((a) => ({ label: a.label, name: a.name, mobile: a.mobile, line: `${a.address}, ${a.city}, ${a.state} ${a.pincode}`, isDefault: a.is_default })),
    orderList: orders.map((o) => ({ id: o.id, number: o.number, status: o.status, total: o.total, paymentMethod: o.payment_method, paymentStatus: o.payment_status, createdAt: iso(o.created_at) as string })),
    tickets: tickets.map((t) => ({ id: t.id, topic: t.topic, status: t.status, orderNumber: t.order_number, createdAt: iso(t.created_at) as string })),
  };
}

/* ---------------------------------------------------------------- reports */

export type ReportRange = { from: string; to: string };

export type SalesReport = {
  range: ReportRange;
  orders: { placed: number; cancelled: number; byStatus: Record<string, number>; byMethod: Record<string, number> };
  sales: { total: number; items: number; shipping: number; discounts: number; couponDiscounts: number; shopDiscounts: number; average: number; ownItems: number; marketplaceItems: number };
  /** Parts delivered in the range. `counterGross`: paid at the seller's own counter (the seller has the money; no commission). */
  marketplace: { gross: number; deliveredGross: number; commission: number; commissionGst: number; counterGross: number; sellers: number };
  online: { paid: number; paidOrders: number; refunded: number };
  riders: { delivered: number; earnings: number };
  coupons: { orders: number; given: number };
  customers: { newAccounts: number; buyingAccounts: number; guestOrders: number };
  daily: { day: string; orders: number; total: number }[];
  topProducts: { title: string; seller: string | null; qty: number; amount: number }[];
};

/** [from, to] are India dates (YYYY-MM-DD), both included. */
export async function salesReport(range: ReportRange): Promise<SalesReport> {
  const from = `${range.from}T00:00:00+05:30`;
  const to = `${range.to}T23:59:59.999+05:30`;
  const p = [from, to];
  const IN = "o.created_at BETWEEN $1 AND $2";
  const LIVE = `${IN} AND o.status <> 'cancelled'`;

  const [own, status, method, sums, parts, delivered, online, refunds, riders, coupons, accounts, daily, top] = await Promise.all([
    sqlOne<{ amount: number }>(`SELECT COALESCE(sum(i.line_total),0)::int AS amount FROM order_items i JOIN orders o ON o.id = i.order_id WHERE ${LIVE} AND i.vendor_order_id IS NULL`, p),
    sql<{ status: string; n: number }>(`SELECT o.status, count(*)::int AS n FROM orders o WHERE ${IN} GROUP BY 1`, p),
    sql<{ m: string; n: number }>(`SELECT o.payment_method AS m, count(*)::int AS n FROM orders o WHERE ${LIVE} GROUP BY 1`, p),
    sqlOne<{ total: number; items: number; shipping: number; discounts: number; shop_discounts: number; n: number }>(
      `SELECT COALESCE(sum(o.total),0)::int AS total, COALESCE(sum(o.subtotal),0)::int AS items, COALESCE(sum(o.shipping),0)::int AS shipping,
              COALESCE(sum(o.discount),0)::int AS discounts,
              COALESCE(sum(o.discount) FILTER (WHERE o.channel = 'store'),0)::int AS shop_discounts, count(*)::int AS n
         FROM orders o WHERE ${LIVE}`,
      p,
    ),
    sqlOne<{ gross: number; sellers: number }>(
      `SELECT COALESCE(sum(vo.subtotal),0)::int AS gross, count(DISTINCT vo.vendor_id)::int AS sellers
         FROM vendor_orders vo JOIN orders o ON o.id = vo.order_id
        WHERE ${LIVE} AND vo.status NOT IN ('cancelled','returned')`,
      p,
    ),
    sql<{ subtotal: number; commission_rate: string; collected_by: "platform" | "seller" }>(
      // No commission on Offline Store screen sales (unless already paid out at an older rate).
      `SELECT vo.subtotal, CASE WHEN o.channel = 'store' AND vo.payout_id IS NULL THEN 0 ELSE vo.commission_rate END AS commission_rate, vo.collected_by
         FROM vendor_orders vo JOIN orders o ON o.id = vo.order_id
        WHERE vo.status = 'delivered' AND vo.delivered_at BETWEEN $1 AND $2`,
      p,
    ),
    sqlOne<{ paise: string; n: number }>(
      "SELECT COALESCE(sum(amount_paise),0)::bigint AS paise, count(DISTINCT order_id)::int AS n FROM payments WHERE status = 'paid' AND paid_at BETWEEN $1 AND $2",
      p,
    ),
    sqlOne<{ paise: string }>("SELECT COALESCE(sum(amount_paise),0)::bigint AS paise FROM refunds WHERE status = 'processed' AND COALESCE(processed_at, updated_at) BETWEEN $1 AND $2", p),
    sqlOne<{ n: number; earnings: number }>(
      "SELECT count(*)::int AS n, COALESCE(sum(earning),0)::int AS earnings FROM rider_jobs WHERE status = 'delivered' AND delivered_at BETWEEN $1 AND $2",
      p,
    ),
    sqlOne<{ n: number; given: number }>(
      `SELECT count(*)::int AS n, COALESCE(sum(r.amount),0)::int AS given FROM coupon_redemptions r JOIN orders o ON o.id = r.order_id WHERE ${LIVE}`,
      p,
    ),
    sqlOne<{ fresh: number; buying: number; guests: number }>(
      `SELECT (SELECT count(*)::int FROM customers WHERE created_at BETWEEN $1 AND $2) AS fresh,
              (SELECT count(DISTINCT o.customer_id)::int FROM orders o WHERE ${LIVE} AND o.customer_id IS NOT NULL) AS buying,
              (SELECT count(*)::int FROM orders o WHERE ${LIVE} AND o.customer_id IS NULL) AS guests`,
      p,
    ),
    sql<{ day: string; n: number; total: number }>(
      `SELECT to_char(o.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS day, count(*)::int AS n, COALESCE(sum(o.total),0)::int AS total
         FROM orders o WHERE ${LIVE} GROUP BY 1 ORDER BY 1`,
      p,
    ),
    sql<{ title: string; seller: string | null; qty: number; amount: number }>(
      `SELECT i.title, v.store_name AS seller, sum(i.qty)::int AS qty, sum(i.line_total)::int AS amount
         FROM order_items i JOIN orders o ON o.id = i.order_id
         LEFT JOIN vendor_orders vo ON vo.id = i.vendor_order_id LEFT JOIN vendors v ON v.id = vo.vendor_id
        WHERE ${LIVE} GROUP BY i.title, v.store_name ORDER BY amount DESC LIMIT 10`,
      p,
    ),
  ]);

  const byStatus = Object.fromEntries(status.map((r) => [r.status, r.n]));
  const settled = delivered.filter((d) => d.collected_by === "platform").map((d) => settlementFor(d.subtotal, Number(d.commission_rate)));
  const counterGross = delivered.filter((d) => d.collected_by === "seller").reduce((n, d) => n + d.subtotal, 0);
  const total = sums?.total ?? 0;
  const placed = sums?.n ?? 0;
  const marketplaceGross = parts?.gross ?? 0;
  return {
    range,
    orders: { placed, cancelled: byStatus.cancelled ?? 0, byStatus, byMethod: Object.fromEntries(method.map((r) => [r.m, r.n])) },
    sales: {
      total,
      items: sums?.items ?? 0,
      shipping: sums?.shipping ?? 0,
      discounts: sums?.discounts ?? 0,
      couponDiscounts: coupons?.given ?? 0,
      shopDiscounts: sums?.shop_discounts ?? 0,
      average: placed ? Math.round(total / placed) : 0,
      ownItems: own?.amount ?? 0,
      marketplaceItems: marketplaceGross,
    },
    marketplace: {
      gross: marketplaceGross,
      deliveredGross: settled.reduce((n, s) => n + s.gross, 0),
      commission: settled.reduce((n, s) => n + s.commission, 0),
      commissionGst: settled.reduce((n, s) => n + s.commissionGst, 0),
      counterGross,
      sellers: parts?.sellers ?? 0,
    },
    online: { paid: Math.round(Number(online?.paise ?? 0) / 100), paidOrders: online?.n ?? 0, refunded: Math.round(Number(refunds?.paise ?? 0) / 100) },
    riders: { delivered: riders?.n ?? 0, earnings: riders?.earnings ?? 0 },
    coupons: { orders: coupons?.n ?? 0, given: coupons?.given ?? 0 },
    customers: { newAccounts: accounts?.fresh ?? 0, buyingAccounts: accounts?.buying ?? 0, guestOrders: accounts?.guests ?? 0 },
    daily: daily.map((d) => ({ day: d.day, orders: d.n, total: d.total })),
    topProducts: top,
  };
}

/** Orders in the range as CSV rows (for the accountant). Header row first. */
export async function ordersCsv(range: ReportRange): Promise<string[][]> {
  const rows = await sql<{ number: string; created_at: Date; status: string; customer_name: string; city: string; state: string; pincode: string; subtotal: number; shipping: number; discount: number; coupon_code: string | null; total: number; payment_method: string; payment_status: string; invoice: string | null }>(
    `SELECT o.number, o.created_at, o.status, o.customer_name, o.city, o.state, o.pincode, o.subtotal, o.shipping, o.discount, o.coupon_code,
            o.total, o.payment_method, o.payment_status, i.number AS invoice
       FROM orders o LEFT JOIN customer_invoices i ON i.order_id = o.id
      WHERE o.created_at BETWEEN $1 AND $2 ORDER BY o.created_at`,
    [`${range.from}T00:00:00+05:30`, `${range.to}T23:59:59.999+05:30`],
  );
  const when = (d: Date) => new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  return [
    ["Order", "Placed (IST)", "Status", "Customer", "City", "State", "Pincode", "Items", "Delivery", "Discount", "Coupon", "Total", "Payment", "Payment status", "Riderzpro invoice"],
    ...rows.map((r) => [r.number, when(r.created_at), r.status, r.customer_name, r.city, r.state, r.pincode, String(r.subtotal), String(r.shipping), String(r.discount), r.coupon_code ?? "", String(r.total), r.payment_method, r.payment_status, r.invoice ?? ""]),
  ];
}
