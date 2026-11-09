# Sathwik: plan for 6 Nov 2026

From the team task list of 5 Nov 2026. Covers the deploy and payments tasks marked **Now**. The code
and docs are on branch `sathwik/deploy-and-payments`. The steps below need the server or a Razorpay
login. Runbook: `docs/DEPLOY.md`, sections 6 to 9.

## Order for today

Do these in order. Steps 1 to 4 use today's `old-deploy` and don't depend on this branch.

| Step | Task | What to do | Done when |
| --- | --- | --- | --- |
| 1 | #3 Server settings | Check `.env` against `DEPLOY.md` section 2. **Keep the current `VENDOR_DATA_KEY`** (see "Decided"). | No unexpected `[config]` lines in the log |
| 2 | #1 Redeploy | Deploy the latest `old-deploy` using section 6. Fill in the real folder and process name. | Log shows `[indus] Indus Enterprises set up`; `/api/health` is OK |
| 3 | #5 nginx | Apply section 7. Check `client_max_body_size` too: the 1 MB default blocks seller uploads over 1 MB. | `rate_limits` shows a phone's real address |
| 4 | #4 Cleanup job | Apply section 8. | Manual call returns `"ok":true`; the log has a new line after the next hour |
| 5 | #7 Razorpay | Submit KYC. Add test keys and the webhook using section 9. | Log shows `Razorpay is in TEST mode` |
| 6 | #6 and #2 | Open a Pull Request from this branch into `old-deploy` and get it reviewed. **Merge only after step 5.** | Reviewed |
| 7 | #8 Payment test | After merging and redeploying: test card and UPI, order turns Paid, invoice opens, refund ₹1. Cancel the test orders. | All pass |

## Decided

1. **`VENDOR_DATA_KEY`: keep the current live key as the final one.** Save it in the password manager
   and tell Muni/Vamsi. The code can only use one key (`src/lib/server/security.ts`) and nothing
   re-encrypts saved data, so a new key would make sellers' bank details and PAN unreadable.
2. **Online-only checkout: merge once Razorpay test keys work on the server.** WhatsApp is how the live
   site takes orders today, and after this branch is deployed no order can be placed without keys.
   Don't announce the site until live keys are on.

## Status of every task

| # | Task | When | Status |
| --- | --- | --- | --- |
| 1 | Redeploy | Now | Server step |
| 2 | Deploy steps in `DEPLOY.md` | Now | **Written**; confirm the real folder and process name on the server |
| 3 | Server settings | Now | Server step; Amrutha's keys follow when ready |
| 4 | Hourly cleanup job | Now | **Steps written**; server step |
| 5 | nginx real IP | Now | **Config written**; server step |
| 6 | Remove WhatsApp ordering (server) | Now | **Code done on this branch**; merge after step 5 |
| 7 | Razorpay | Now | Test keys create orders from a local run; still to do: server, webhook, KYC, then live keys at go-live |
| 8 | Payment test | Next | After step 6. Mock-API run passes (`scripts/test-payments.mjs`) |
| 9 | GST check with the accountant | Next | Not started |
| 10 | No commission on shop-screen sales | Next | New sales are 0%. See "Still open on commission" |
| 11 | Uptime and logs | Next | Not started; log guide is in section 6 |
| 12 | CSP header and zod 4 | Later | Not started |

## What changed on this branch

- `POST /api/orders` only accepts `paymentMethod: "online"`. A request without it gets a 400. Before
  this fix, the old cart's WhatsApp button created an unpaid online order, told the customer it was
  placed, and the order was released 30 minutes later.
- The cart and checkout offer online payment only. This overlaps Sathese's task 2, as the task list
  expects ("with Sathwik").
- Old WhatsApp orders stay readable: the database values and labels are kept, and no migration is
  needed. `/admin/orders` had no WhatsApp filter to remove.
- Ask AI no longer tells customers to order on WhatsApp.
- `scripts/test-payments.mjs` now expects online-only behaviour.

## Still open on commission (#10)

New shop-screen sales save a 0% rate, but three things remain:

- Shop-screen orders placed **before** this release keep their saved rate, and any not yet paid out
  would still have commission deducted. Count them with:
  `SELECT count(*), sum(vo.subtotal) FROM vendor_orders vo JOIN orders o ON o.id = vo.order_id WHERE o.channel = 'store' AND vo.commission_rate <> 0 AND vo.payout_id IS NULL;`
  If any exist, zero them with a new migration, which changes live data, so have it reviewed.
- Admin Reports still shows "Commission on counter sales … billing rule to be decided".
- The seller Payments page still describes commission on every order.

## For teammates

- **Sathese:** start your WhatsApp work after this merges, because `CheckoutForm.tsx` and `CartView.tsx`
  changed and `cartMessage.ts` is gone.
- **Hima Bindu:** the admin Reports page counts WhatsApp orders, and `PaymentCard.tsx` tells admins
  that every non-online order, including shop counter orders, is arranged on WhatsApp.
- **Needs an owner:** `src/lib/data/policies.ts` and `faq.ts` still tell customers that orders are
  confirmed and tracked on WhatsApp. Only the "How to pay" section is fixed here. The rest should go
  live with or soon after this branch.
- **Whoever owns the task list:** it points to `docs/GO_LIVE.md`, which isn't on `main` or `old-deploy`.

## Update 9 Nov 2026

Done on this branch since 6 Nov:

- **#7 Razorpay test keys checked** against the Razorpay test account from a local run: real test orders
  are created; signed webhooks and the client check mark orders paid; bad signatures are refused;
  repeated events are ignored; a refused refund returns a clean error. Still to do on the server: keys
  in `.env`, the webhook in the Razorpay dashboard (`DEPLOY.md` §9), a real test-card/UPI payment and a
  ₹1 refund (#8), KYC, then live keys.
- **#10 No commission on shop-screen sales: done.** Migration `019_store_sales_no_commission` zeroes the
  rate on older screen sales not yet paid out (run the count query above before deploying). Payouts
  and Reports read unpaid screen sales as 0%. Reports and the seller Payments page say so.
- **#2, #4, #5, #11: scripts and config in `deploy/`** (redeploy with rollback, nginx, systemd, hourly
  job installer, health check). `DEPLOY.md` §10 covers uptime and logs.
- **#12:** CSP added as **Report-Only** (`next.config.ts`, `DEPLOY.md` §11): test with the frontend team,
  then enforce. `chore/zod-4` merged here and tested (lint, typecheck, build, 29 payment checks).
- Customer policies/FAQ, admin PaymentCard and Reports no longer say orders go through WhatsApp.
- `docs/GO_LIVE.md` now exists.
