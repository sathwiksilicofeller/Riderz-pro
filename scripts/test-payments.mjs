#!/usr/bin/env node
/**
 * End-to-end payment checks against a local dev server and a MOCK Razorpay API (no real keys,
 * no real money, nothing leaves this machine). Uses the embedded database in .data/pglite.
 *
 *   node scripts/test-payments.mjs            (stop any dev server using this folder first)
 *
 * It seeds a test seller + product, starts `next dev -p 3102` with fake Razorpay keys and
 * RAZORPAY_API_BASE pointing at the mock (honoured only outside production), and checks:
 * server pricing, tampered amounts, checkout signature, webhook signature / dedupe / amount match,
 * payment.failed, refunds (partial, over-limit, refused, webhook-settled, full), the unpaid-order
 * release with stock coming back, a late payment after release, and the no-keys behaviour.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3102;
const MOCK_PORT = 4599;
const BASE = `http://localhost:${PORT}`;
const KEY_ID = "rzp_test_FAKE0000000001";
const KEY_SECRET = "fake_key_secret_not_real";
const WH_SECRET = "fake_webhook_secret_not_real";
const PRICE = 1500; // test product, rupees
const STOCK = 6;
const SLUG = "paytest-seat-cover";

let passed = 0;
const ok = (name) => {
  passed++;
  console.log(`ok  ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hmac = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");
const alnum = (n) => randomBytes(n).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, n).padEnd(n, "X");

/* ------------------------------------------------------------ database */

async function openDb() {
  const { PGlite } = await import("@electric-sql/pglite");
  const dir = path.join(ROOT, ".data", "pglite");
  mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  await db.waitReady;
  return db;
}

/** Apply the app's migrations (same rule as src/lib/db/client.ts) so the seed can run before the server. */
async function migrate(db) {
  const src = readFileSync(path.join(ROOT, "src/lib/db/migrations.ts"), "utf8").replace('import "server-only";', "");
  const tmpDir = path.join(ROOT, ".data", "test-tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, `migrations-${Date.now()}.ts`);
  writeFileSync(tmp, src);
  const { MIGRATIONS } = await import(pathToFileURL(tmp).href);
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await db.query("SELECT id FROM schema_migrations")).rows.map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    await db.exec("BEGIN");
    await db.exec(m.sql);
    await db.query("INSERT INTO schema_migrations (id) VALUES ($1)", [m.id]);
    await db.exec("COMMIT");
  }
}

async function seed(db) {
  await db.query(
    `INSERT INTO vendors (id, email, mobile, password_hash, full_name, business_type, status, store_name, slug)
     VALUES ('ven_paytest000000000001','paytest@example.test','9000000001','x','Pay Test','proprietorship','approved','Paytest Store','paytest-store')
     ON CONFLICT (id) DO NOTHING`,
  );
  await db.query(
    `INSERT INTO vendor_products (id, vendor_id, slug, status, title, brand, department, group_slug, sku, mrp, price, stock, low_stock_at)
     VALUES ('vp_paytest000000000001','ven_paytest000000000001',$1,'live','Paytest Seat Cover','Paytest','interior','seat-covers','PAYTEST-1',$2,$2,$3,0)
     ON CONFLICT (id) DO UPDATE SET stock = EXCLUDED.stock, price = EXCLUDED.price, mrp = EXCLUDED.mrp, status = 'live'`,
    [SLUG, PRICE, STOCK],
  );
  // Leave no earlier unpaid test orders around to be released mid-run.
  await db.query(
    `UPDATE orders SET status = 'cancelled', payment_status = 'failed'
      WHERE payment_method = 'online' AND status = 'placed' AND customer_phone = '9123400000'`,
  );
}

/* ---------------------------------------------------------- mock Razorpay */

const mock = { orders: [], orderPayments: {}, payments: {}, refunds: [], refundFail: false, authBad: 0 };
const mockServer = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const send = (status, data) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const expected = "Basic " + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64");
  if (req.headers.authorization !== expected) {
    mock.authBad++;
    return send(401, { error: { code: "BAD_REQUEST_ERROR", description: "Authentication failed" } });
  }
  const url = new URL(req.url, "http://mock");
  let m;
  if (req.method === "POST" && url.pathname === "/v1/orders") {
    const b = JSON.parse(body);
    const o = { id: `order_${alnum(14)}`, entity: "order", amount: b.amount, currency: b.currency, receipt: b.receipt, notes: b.notes, status: "created" };
    mock.orders.push(o);
    return send(200, o);
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\/v1\/payments\/([^/]+)$/))) {
    const p = mock.payments[m[1]];
    return p ? send(200, p) : send(400, { error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" } });
  }
  if (req.method === "GET" && (m = url.pathname.match(/^\/v1\/orders\/([^/]+)\/payments$/))) {
    return send(200, { entity: "collection", items: mock.orderPayments[m[1]] ?? [] });
  }
  if (req.method === "POST" && (m = url.pathname.match(/^\/v1\/payments\/([^/]+)\/refund$/))) {
    const b = JSON.parse(body);
    if (mock.refundFail) return send(400, { error: { code: "BAD_REQUEST_ERROR", description: "The refund amount provided is greater than amount captured" } });
    const r = { id: `rfnd_${alnum(14)}`, entity: "refund", payment_id: m[1], amount: b.amount, status: "pending", notes: b.notes, receipt: b.receipt };
    mock.refunds.push(r);
    return send(200, r);
  }
  send(404, { error: { code: "NOT_FOUND", description: "no such mock route" } });
});

/* ------------------------------------------------------------ dev server */

let server = null;
async function startServer(withKeys) {
  const env = { ...process.env, NODE_ENV: "development", PORT: String(PORT) };
  // Empty, not deleted: Next fills in missing variables from .env.local, which may hold real
  // (test) keys; a variable already set, even to "", is left alone, so "no keys" really means none.
  for (const k of ["RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "RAZORPAY_WEBHOOK_SECRET", "RAZORPAY_API_BASE"]) env[k] = "";
  if (withKeys) {
    Object.assign(env, {
      RAZORPAY_KEY_ID: KEY_ID,
      RAZORPAY_KEY_SECRET: KEY_SECRET,
      RAZORPAY_WEBHOOK_SECRET: WH_SECRET,
      RAZORPAY_API_BASE: `http://127.0.0.1:${MOCK_PORT}`,
    });
  }
  server = spawn(process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "dev", "-p", String(PORT)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  server.stdout.on("data", (d) => (log += d));
  server.stderr.on("data", (d) => (log += d));
  server.logText = () => log;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    try {
      const r = await fetch(`${BASE}/api/payments/razorpay/config`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
  }
  throw new Error("dev server did not start:\n" + log.slice(-2000));
}
async function stopServer() {
  if (!server) return;
  const s = server;
  server = null;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(s.pid), "/t", "/f"]);
  else s.kill("SIGTERM");
  await new Promise((r) => {
    s.once("exit", r);
    setTimeout(r, 8000);
  });
  await sleep(1500); // let the database lock go
}

/* ---------------------------------------------------------------- client */

let ipSeq = 0;
async function call(method, p, body, headers = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      // A fresh client address per request keeps the per-IP order rate limit out of the way.
      "X-Forwarded-For": `10.77.${Math.floor(ipSeq / 250) % 250}.${(ipSeq++ % 250) + 1}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { Origin: BASE } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* none */
  }
  return { status: res.status, data };
}

const customer = { name: "Pay Tester", mobile: "9123400000", email: "pay@example.test", address: "12 Test Street, Sector 5", city: "Gurugram", state: "Haryana", pincode: "122001" };
const line = (qty) => ({ id: `vendor:${SLUG}`, qty, install: false });
const placeOnline = (qty, extra = {}) => call("POST", "/api/orders", { customer, lines: [line(qty)], paymentMethod: "online", ...extra });

/** Stock left, read from the "Only N left" answer to an impossible order (places nothing). */
async function stockLeft() {
  const r = await call("POST", "/api/orders", { customer, lines: [line(99)], paymentMethod: "online" });
  assert.equal(r.status, 409, `stock probe: ${JSON.stringify(r.data)}`);
  const m = r.data.message.match(/Only (\d+) of/);
  return m ? Number(m[1]) : 0;
}

async function adminOrder(number) {
  const r = await call("GET", `/api/admin/orders?q=${encodeURIComponent(number)}`);
  assert.equal(r.status, 200);
  const o = r.data.orders.find((x) => x.number === number);
  assert.ok(o, `admin sees ${number}`);
  return o;
}

let eventSeq = 0;
function webhook(event, payload, { secret = WH_SECRET, eventId = `evt_${alnum(14)}${eventSeq++}`, tamper = false } = {}) {
  const raw = JSON.stringify({ entity: "event", account_id: "acc_test", event, contains: Object.keys(payload), payload, created_at: Math.floor(Date.now() / 1000) });
  const sig = hmac(secret, raw);
  return {
    eventId,
    send: () =>
      fetch(`${BASE}/api/payments/razorpay/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Razorpay-Signature": sig, "X-Razorpay-Event-Id": eventId },
        body: tamper ? raw.replace(/"amount":(\d+)/, '"amount":100') : raw,
      }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) })),
  };
}
const paymentEntity = (o, pid, amount, status = "captured") => ({ payment: { entity: { id: pid, entity: "payment", order_id: o, amount, currency: "INR", status, method: "upi" } } });

/* ------------------------------------------------------------------ run */

async function main() {
  await new Promise((r) => mockServer.listen(MOCK_PORT, "127.0.0.1", r));

  let db = await openDb();
  await migrate(db);
  await seed(db);
  await db.query("DELETE FROM rate_limits"); // left by an earlier run of this script
  await db.close();

  await startServer(true);
  console.log("dev server up (fake keys, mock Razorpay)\n");

  /* config */
  let r = await call("GET", "/api/payments/razorpay/config");
  assert.deepEqual(r.data, { ok: true, enabled: true });
  assert.ok(!JSON.stringify(r.data).includes(KEY_SECRET));
  ok("config: online payment enabled, no secret exposed");

  assert.equal(await stockLeft(), STOCK);

  /* 1. server-priced order, tampered amounts ignored */
  r = await placeOnline(2, { total: 1, amount: 100, price: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const expectedTotal = PRICE * 2; // ≥ ₹2000 ships free
  assert.equal(r.data.order.total, expectedTotal);
  assert.equal(r.data.payment.amountPaise, expectedTotal * 100);
  assert.equal(r.data.payment.keyId, KEY_ID);
  assert.equal(r.data.payment.currency, "INR");
  assert.ok(!JSON.stringify(r.data).includes(KEY_SECRET), "no secret in the response");
  const sent = mock.orders.at(-1);
  assert.equal(sent.amount, expectedTotal * 100, "Razorpay order created for the server total in paise");
  assert.equal(sent.receipt, r.data.order.number);
  const o1 = { number: r.data.order.number, rp: r.data.payment.razorpayOrderId, paise: r.data.payment.amountPaise };
  ok(`order ${o1.number}: server price ₹${expectedTotal} → ${o1.paise} paise; browser total/amount/price ignored`);

  const tampered = await call("POST", "/api/orders", { customer, lines: [{ ...line(1), price: 1, unit: 1 }], paymentMethod: "online", payment: { amountPaise: 100 } });
  assert.equal(tampered.status, 201);
  assert.equal(mock.orders.at(-1).amount, (PRICE + 149) * 100, "₹1500 + ₹149 shipping, whatever the browser says");
  const o2 = { number: tampered.data.order.number, rp: tampered.data.payment.razorpayOrderId, paise: tampered.data.payment.amountPaise };
  ok(`tampered line price ignored: ${o2.number} charged ${o2.paise} paise`);

  assert.equal(await stockLeft(), STOCK - 3);
  ok("stock reserved when the online order is created (6 → 3)");

  let a1 = await adminOrder(o1.number);
  assert.equal(a1.paymentMethod, "online");
  assert.equal(a1.paymentStatus, "pending");
  assert.equal(a1.status, "placed");
  r = await call("POST", `/api/admin/orders/${a1.id}/order-status`, { to: "confirmed" });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "awaiting_payment");
  ok("admin can't confirm an unpaid online order by hand");

  /* 2. checkout verify */
  const pid1 = `pay_${alnum(14)}`;
  mock.payments[pid1] = { id: pid1, order_id: o1.rp, amount: o1.paise, currency: "INR", status: "captured", method: "upi" };
  r = await call("POST", "/api/payments/razorpay/verify", { razorpay_order_id: o1.rp, razorpay_payment_id: pid1, razorpay_signature: hmac("wrong-secret", `${o1.rp}|${pid1}`) });
  assert.equal(r.status, 400);
  assert.equal(r.data.error, "bad_signature");
  r = await call("POST", "/api/payments/razorpay/verify", { razorpay_order_id: o2.rp, razorpay_payment_id: pid1, razorpay_signature: hmac(KEY_SECRET, `${o1.rp}|${pid1}`) });
  assert.equal(r.status, 400, "signature for another order");
  assert.equal((await adminOrder(o1.number)).paymentStatus, "pending");
  ok("verify: wrong secret and wrong order id both rejected, nothing marked paid");

  r = await fetch(`${BASE}/api/payments/razorpay/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ razorpay_order_id: o1.rp, razorpay_payment_id: pid1, razorpay_signature: hmac(KEY_SECRET, `${o1.rp}|${pid1}`) }),
  });
  assert.equal(r.status, 403);
  ok("verify: cross-site Origin blocked");

  const goodSig = hmac(KEY_SECRET, `${o1.rp}|${pid1}`);
  r = await call("POST", "/api/payments/razorpay/verify", { razorpay_order_id: o1.rp, razorpay_payment_id: pid1, razorpay_signature: goodSig });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.order.paymentStatus, "paid");
  assert.equal(r.data.order.orderStatus, "confirmed");
  a1 = await adminOrder(o1.number);
  assert.equal(a1.paymentStatus, "paid");
  assert.equal(a1.status, "confirmed");
  ok("verify: good signature → paid and confirmed");

  r = await call("POST", "/api/payments/razorpay/verify", { razorpay_order_id: o1.rp, razorpay_payment_id: pid1, razorpay_signature: goodSig });
  assert.equal(r.status, 200);
  assert.equal(r.data.order.paymentStatus, "paid");
  ok("verify: repeated call is idempotent");

  /* 3. webhooks */
  let w = webhook("payment.captured", paymentEntity(o1.rp, pid1, o1.paise), { secret: "not-the-secret" });
  r = await w.send();
  assert.equal(r.status, 401);
  w = webhook("payment.captured", paymentEntity(o1.rp, pid1, o1.paise), { tamper: true });
  r = await w.send();
  assert.equal(r.status, 401);
  ok("webhook: wrong secret and tampered body rejected (401)");

  w = webhook("payment.captured", paymentEntity(o1.rp, pid1, o1.paise));
  r = await w.send();
  assert.equal(r.status, 200);
  assert.equal(r.data.outcome, "already");
  r = await w.send();
  assert.equal(r.data.status, "duplicate");
  ok("webhook: capture after verify is a no-op; same event id again → duplicate");

  const pid2 = `pay_${alnum(14)}`;
  r = await webhook("payment.captured", paymentEntity(o2.rp, pid2, 100)).send();
  assert.equal(r.status, 200);
  assert.equal(r.data.outcome, "amount_mismatch");
  assert.equal((await adminOrder(o2.number)).paymentStatus, "pending");
  ok("webhook: captured amount ≠ server amount → not marked paid");

  r = await webhook("order.paid", {
    ...paymentEntity(o2.rp, pid2, o2.paise),
    order: { entity: { id: o2.rp, entity: "order", amount: o2.paise, amount_paid: o2.paise, currency: "INR", status: "paid" } },
  }).send();
  assert.equal(r.data.outcome, "confirmed", JSON.stringify(r.data));
  const a2 = await adminOrder(o2.number);
  assert.equal(a2.paymentStatus, "paid");
  assert.equal(a2.status, "confirmed");
  ok("webhook: order.paid with the right amount confirms the order (no browser needed)");

  /* 4. payment.failed on a third order */
  r = await placeOnline(1);
  const o3 = { number: r.data.order.number, rp: r.data.payment.razorpayOrderId, paise: r.data.payment.amountPaise };
  r = await webhook("payment.failed", {
    payment: { entity: { id: `pay_${alnum(14)}`, order_id: o3.rp, amount: o3.paise, currency: "INR", status: "failed", error_code: "BAD_REQUEST_ERROR", error_description: "Payment was declined by the bank" } },
  }).send();
  assert.equal(r.data.outcome, "failed");
  let a3 = await adminOrder(o3.number);
  assert.equal(a3.paymentStatus, "failed");
  assert.equal(a3.status, "placed", "still open for a retry");
  ok("webhook: payment.failed → payment failed, order kept for a retry");

  /* 5. refunds */
  r = await call("POST", `/api/admin/orders/${a1.id}/refund`, { amount: expectedTotal + 1, reason: "Too much" });
  assert.equal(r.status, 400);
  ok("refund: more than paid rejected");
  r = await call("POST", `/api/admin/orders/${a1.id}/refund`, { amount: 500, reason: "x" });
  assert.equal(r.status, 400, "reason required");
  r = await call("POST", `/api/admin/orders/${a1.id}/refund`, { amount: 500, reason: "Seat cover colour mismatch" });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.refund.amountPaise, 50000);
  assert.equal(r.data.refund.status, "pending");
  const rf1 = mock.refunds.at(-1);
  assert.equal(rf1.amount, 50000);
  assert.equal(rf1.payment_id, pid1);
  assert.equal((await adminOrder(o1.number)).paymentStatus, "partially_refunded");
  ok("refund: partial ₹500 sent to Razorpay as 50000 paise → partly refunded");

  r = await webhook("refund.processed", { refund: { entity: { ...rf1, status: "processed" } } }).send();
  assert.equal(r.data.outcome, "refund_processed");
  ok("webhook: refund.processed settles it");

  mock.refundFail = true;
  r = await call("POST", `/api/admin/orders/${a1.id}/refund`, { amount: 100, reason: "Testing a refusal" });
  assert.equal(r.status, 502);
  assert.equal(r.data.error, "refund_failed");
  mock.refundFail = false;
  ok("refund: Razorpay refusal → 502, recorded as failed, not counted");

  r = await call("POST", `/api/admin/orders/${a1.id}/refund`, { amount: expectedTotal - 500 + 1, reason: "Over the remainder" });
  assert.equal(r.status, 400);
  r = await call("POST", `/api/admin/orders/${a1.id}/refund`, { amount: null, reason: "Order cancelled by customer" });
  assert.equal(r.status, 200);
  assert.equal(r.data.refund.amountPaise, (expectedTotal - 500) * 100);
  assert.equal((await adminOrder(o1.number)).paymentStatus, "refunded");
  r = await call("POST", `/api/admin/orders/${a1.id}/refund`, { amount: null, reason: "Once more" });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "fully_refunded");
  ok("refund: full remainder → refunded; nothing left to refund afterwards");

  r = await webhook("refund.failed", { refund: { entity: { ...mock.refunds.at(-1), status: "failed" } } }).send();
  assert.equal(r.data.outcome, "refund_failed");
  assert.equal((await adminOrder(o1.number)).paymentStatus, "partially_refunded");
  ok("webhook: refund.failed puts the amount back as refundable");

  r = await webhook("refund.processed", { refund: { entity: { id: `rfnd_${alnum(14)}`, payment_id: pid2, amount: 10000, status: "processed", notes: {} } } }).send();
  assert.equal(r.data.outcome, "refund_processed");
  assert.equal((await adminOrder(o2.number)).paymentStatus, "partially_refunded");
  ok("webhook: a refund made in the Razorpay dashboard is recorded too");

  r = await call("POST", `/api/admin/orders/${a3.id}/refund`, { amount: null, reason: "Not paid" });
  assert.equal(r.status, 409);
  ok("refund: unpaid order can't be refunded");

  /* 6. unpaid release — set up three stale orders */
  r = await placeOnline(1);
  const o4 = { number: r.data.order.number, rp: r.data.payment.razorpayOrderId, paise: r.data.payment.amountPaise };
  r = await placeOnline(1);
  const o5 = { number: r.data.order.number, rp: r.data.payment.razorpayOrderId, paise: r.data.payment.amountPaise };
  const pid5 = `pay_${alnum(14)}`;
  mock.orderPayments[o5.rp] = [{ id: pid5, order_id: o5.rp, amount: o5.paise, currency: "INR", status: "captured", method: "card" }];
  assert.equal(await stockLeft(), 0, "3 + 1 + 1 + 1 of 6 taken");
  r = await call("POST", "/api/orders", { customer, lines: [line(1)], paymentMethod: "online" });
  assert.equal(r.status, 409);
  ok("held stock really is held: a further order is refused as sold out");

  await stopServer();
  db = await openDb();
  await db.query("UPDATE orders SET created_at = now() - interval '40 minutes' WHERE number = ANY($1)", [[o3.number, o4.number, o5.number]]);
  await db.query("DELETE FROM rate_limits"); // this script places more orders than one customer may
  await db.close();
  await startServer(true);

  r = await call("POST", "/api/orders", { customer, lines: [{ id: "vendor:does-not-exist", qty: 1, install: false }], paymentMethod: "online" }); // any order request kicks off the release
  assert.equal(r.status, 409);
  let released = false;
  for (let i = 0; i < 20 && !released; i++) {
    await sleep(500);
    released = (await adminOrder(o4.number)).status === "cancelled";
  }
  assert.ok(released, "release ran");
  a3 = await adminOrder(o3.number);
  const a4 = await adminOrder(o4.number);
  const a5 = await adminOrder(o5.number);
  assert.equal(a3.status, "cancelled");
  assert.equal(a3.paymentStatus, "failed");
  assert.equal(a4.status, "cancelled");
  assert.equal(a4.parts[0].status, "cancelled");
  assert.equal(a5.status, "confirmed", "captured on Razorpay → kept and confirmed");
  assert.equal(a5.paymentStatus, "paid");
  assert.equal(await stockLeft(), 2, "o3 + o4 stock back");
  ok("release: unpaid orders older than 30 min cancelled, stock back (0 → 2); one paid on Razorpay was confirmed instead");

  const pid4 = `pay_${alnum(14)}`;
  r = await webhook("payment.captured", paymentEntity(o4.rp, pid4, o4.paise)).send();
  assert.equal(r.data.outcome, "paid_after_cancel");
  const a4b = await adminOrder(o4.number);
  assert.equal(a4b.status, "cancelled");
  assert.equal(a4b.paymentStatus, "paid");
  r = await call("POST", `/api/admin/orders/${a4b.id}/refund`, { amount: null, reason: "Paid after the order expired" });
  assert.equal(r.status, 200);
  ok("late payment after release: kept as paid on a cancelled order (flagged) and refundable in full");

  const page = await fetch(`${BASE}/admin/orders/${a1.id}`).then((x) => x.text());
  assert.ok(page.includes("Refundable") && page.includes(pid1), "admin page shows the payment card");
  assert.ok(!page.includes(KEY_SECRET) && !page.includes(WH_SECRET));
  ok("admin order page renders the payment card, no secrets");

  /* 7. no keys */
  await stopServer();
  await startServer(false);
  r = await call("GET", "/api/payments/razorpay/config");
  assert.equal(r.data.enabled, false);
  r = await placeOnline(1);
  assert.equal(r.status, 503);
  assert.equal(r.data.error, "payments_unavailable");
  r = await call("POST", "/api/payments/razorpay/verify", { razorpay_order_id: o1.rp, razorpay_payment_id: pid1, razorpay_signature: goodSig });
  assert.equal(r.status, 503);
  r = await webhook("payment.captured", paymentEntity(o1.rp, pid1, o1.paise)).send();
  assert.equal(r.status, 503);
  for (const refused of [{ paymentMethod: "whatsapp" }, {}]) {
    r = await call("POST", "/api/orders", { customer, lines: [line(1)], ...refused });
    assert.equal(r.status, 400, "only online orders are accepted");
  }
  ok("no keys: online option off, online order refused, verify/webhook 503, WhatsApp and no-method orders refused");
  await stopServer();

  /* 8. database trail */
  db = await openDb();
  assert.equal((await db.query("SELECT stock FROM vendor_products WHERE slug = $1", [SLUG])).rows[0].stock, 2, "nothing reserved without keys");
  const ev = (await db.query("SELECT count(*)::int AS n FROM payment_webhook_events")).rows[0].n;
  const refunds = (await db.query("SELECT status, source, amount_paise FROM refunds WHERE order_id = (SELECT id FROM orders WHERE number = $1) ORDER BY created_at", [o1.number])).rows;
  const auditRows = (await db.query("SELECT action FROM audit_log WHERE action LIKE 'payment.%' OR action = 'order.payment_expired'")).rows.map((x) => x.action);
  const told = (await db.query("SELECT title, body FROM notifications WHERE vendor_id = 'ven_paytest000000000001' AND type = 'order'")).rows;
  await db.close();
  const toldAbout = (n) => told.filter((x) => x.title === `New order ${n}`);
  assert.equal(toldAbout(o1.number).length, 1, "paid order: seller told once");
  assert.ok(toldAbout(o1.number)[0].body.includes("Paid online"));
  assert.equal(toldAbout(o5.number).length, 1, "reconciled order: seller told");
  assert.equal(toldAbout(o3.number).length, 0, "never-paid order: seller never told");
  assert.equal(toldAbout(o4.number).length, 0, "paid only after expiry: seller not told");
  ok("sellers hear about an online order only once it is paid, exactly once");
  assert.ok(ev >= 8);
  assert.deepEqual(refunds.map((x) => x.status), ["processed", "failed", "failed"]);
  for (const a of ["payment.paid", "payment.amount_mismatch", "payment.refund_requested", "payment.refund_refused", "payment.paid_after_cancel", "order.payment_expired"]) {
    assert.ok(auditRows.includes(a), `audit has ${a}`);
  }
  ok("database: webhook events stored once each; refund rows and audit trail present");

  console.log(`\nall ${passed} payment checks passed`);
}

main()
  .catch(async (err) => {
    console.error("\nFAILED:", err?.message ?? err);
    if (server?.logText) console.error("\n--- dev server log (tail) ---\n" + server.logText().slice(-3000));
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServer();
    mockServer.close();
  });
