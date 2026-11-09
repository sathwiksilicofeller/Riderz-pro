# Go-live checklist (riderzpro.com)

Tick each line on the day, in order. The steps themselves are in [`DEPLOY.md`](DEPLOY.md) and the
team files; this list only says what must be true and where to look. Staging first, then production.

## Before the day

- [ ] **Settings** in the server's `.env` match [DEPLOY.md §2](DEPLOY.md#2-settings-hosting-dashboard--environment-variables);
      `chmod 600`. The log shows `[config] features on: …` and no unexpected `[config]` warnings.
      Owner: Hema.
- [ ] **`VENDOR_DATA_KEY` saved** in the company password manager, the same value as on the server,
      and Muni/Vamsi told. Never changed after this ([`Vamsi_work.md`](team/Vamsi_work.md) step 4).
- [ ] **Backups** on for the production database ([`Vamsi_work.md`](team/Vamsi_work.md) step 3), and
      **one test restore done** into a scratch database (never the live one): the restored copy opens
      and has today's orders. Note the date of the test here: ________.
- [ ] **Sign-in codes, SMS and email** from Amrutha ([`Amrutha_work.md`](team/Amrutha_work.md)):
      rotated Resend/Twilio keys, MSG91 (or Twilio) OTP and DLT templates, Resend domain verified. A
      real code arrives by email and by SMS.

## Server

- [ ] **Redeploy** the latest `old-deploy` with `deploy/redeploy.sh`
      ([DEPLOY.md §6](DEPLOY.md#6-redeploying-the-live-server-old-deploy)). `/api/health` is OK, no
      `[error]` lines.
- [ ] **nginx** per [DEPLOY.md §7](DEPLOY.md#7-nginx) (`deploy/nginx/riderzpro.com.conf`): 10 MB
      uploads, real visitor IP in `rate_limits`, port 3000 not reachable from outside.
- [ ] **Hourly job** installed ([DEPLOY.md §8](DEPLOY.md#8-hourly-cleanup-job)); `~/riderzpro-cron.log`
      shows a successful run after the next full hour.
- [ ] **Uptime monitor** on `https://riderzpro.com/api/health` every 5 minutes, alerts to two people
      ([DEPLOY.md §10](DEPLOY.md#10-uptime-and-logs)).

## Payments (Sathwik, [DEPLOY.md §9](DEPLOY.md#9-turning-on-online-payment))

- [ ] **Test mode:** test keys and the test webhook on the server; the log says
      `Razorpay is in TEST mode`. Card and UPI test payments turn the order "Paid"; refund ₹1 works.
- [ ] **KYC approved** in the Razorpay dashboard.
- [ ] **Live:** live `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET`, a **live-mode** webhook
      ([DEPLOY.md §3 step 6](DEPLOY.md#3-first-deploy)) and its own `RAZORPAY_WEBHOOK_SECRET` (the test
      webhook's secret doesn't work for live), then restart. The TEST mode warning is gone.
- [ ] **One real small payment** end to end, then refund it from the admin order page.

## Clean up

- [ ] **Cancel every test order** (test payments, shop-screen and rider tests) in `/admin/orders`.
- [ ] **Remove demo content:** test products, test sellers/riders/customer accounts and placeholder
      text. Ask the owner before touching the Indus Enterprises store: it is the pilot shop, not a demo.
- [ ] Admin: the owner signs in at `/admin/sign-in` and the team is invited from `/admin/team`.

## Go live

- [ ] Domain switch per [`Hema_work.md`](team/Hema_work.md) "Go-live day"; old site kept on a spare
      address for a week ([DEPLOY.md §5](DEPLOY.md#5-going-live-and-rolling-back)).
- [ ] **Smoke test** on production: every line of [DEPLOY.md §4](DEPLOY.md#4-smoke-test-staging-then-production-right-after-the-switch).
- [ ] Read the log for `[config]` / `[error]` lines one hour and one day after the switch.
- [ ] Announce the site only once live payment keys are on.

Rollback: [DEPLOY.md §5](DEPLOY.md#5-going-live-and-rolling-back) (domain) or
`deploy/redeploy.sh --rollback` (code).
