import "server-only";

/**
 * Schema migrations, applied in order on first database use and recorded in
 * `schema_migrations`. Never edit a migration that has shipped — add a new one.
 *
 * Conventions
 *   ids        text, prefixed (ven_, vp_, ord_ …), generated in application code
 *   money      integer rupees, GST inclusive, as everywhere else on the site
 *   times      timestamptz
 *   statuses   text with a CHECK; the allowed values mirror src/lib/vendor/types.ts
 *   secrets    bank account and PAN are stored sealed (AES-256-GCM, src/lib/crypto/sealed.ts);
 *              only the last four characters are stored in the clear
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_vendor_marketplace",
    sql: `
CREATE TABLE vendors (
  id                 text PRIMARY KEY,
  email              text NOT NULL,
  mobile             text NOT NULL,
  password_hash      text NOT NULL,
  full_name          text NOT NULL,
  business_type      text NOT NULL,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','submitted','under_review','approved','changes_requested','rejected','suspended')),
  email_verified_at  timestamptz,
  mobile_verified_at timestamptz,
  store_name         text,
  slug               text,
  onboarding         jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_step       integer NOT NULL DEFAULT 1,
  completed_steps    integer[] NOT NULL DEFAULT '{}',
  commission_rate    numeric(5,2),
  tier               text CHECK (tier IN ('standard','gold','platinum')),
  holiday_mode       boolean NOT NULL DEFAULT false,
  changes_requested  jsonb,
  rejection_reason   text,
  status_before_suspension text,
  submitted_at       timestamptz,
  approved_at        timestamptz,
  approved_by        text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX vendors_email_key ON vendors (lower(email));
CREATE UNIQUE INDEX vendors_mobile_key ON vendors (mobile);
CREATE UNIQUE INDEX vendors_store_name_key ON vendors (lower(store_name)) WHERE store_name IS NOT NULL;
CREATE UNIQUE INDEX vendors_slug_key ON vendors (slug) WHERE slug IS NOT NULL;
CREATE INDEX vendors_status_idx ON vendors (status);

CREATE TABLE vendor_sessions (
  token_hash   text PRIMARY KEY,
  vendor_id    text NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text
);
CREATE INDEX vendor_sessions_vendor_idx ON vendor_sessions (vendor_id);

CREATE TABLE vendor_otps (
  id          text PRIMARY KEY,
  vendor_id   text REFERENCES vendors(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('email','mobile')),
  target      text NOT NULL,
  purpose     text NOT NULL CHECK (purpose IN ('verify','login','reset')),
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_otps_target_idx ON vendor_otps (target, purpose);

CREATE TABLE rate_limits (
  key          text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL
);

CREATE TABLE vendor_secrets (
  vendor_id         text PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  pan_sealed        text,
  pan_last4         text,
  bank_holder       text,
  bank_account_sealed text,
  bank_account_last4  text,
  bank_ifsc         text,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE files (
  id          text PRIMARY KEY,
  vendor_id   text REFERENCES vendors(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('doc_pan','doc_gst','doc_cheque','doc_trade_license','doc_brand_auth','logo','banner','product_image')),
  mime        text NOT NULL,
  size_bytes  integer NOT NULL,
  data        bytea NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX files_vendor_idx ON files (vendor_id, kind);

CREATE TABLE vendor_products (
  id               text PRIMARY KEY,
  vendor_id        text NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  slug             text NOT NULL UNIQUE,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','pending_review','live','changes_requested','rejected','archived')),
  title            text NOT NULL,
  brand            text NOT NULL,
  department       text NOT NULL,
  group_slug       text NOT NULL,
  sku              text NOT NULL,
  hsn              text,
  gst_rate         integer NOT NULL DEFAULT 18 CHECK (gst_rate IN (0,5,12,18,28)),
  mrp              integer NOT NULL CHECK (mrp > 0),
  price            integer NOT NULL CHECK (price > 0),
  stock            integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  low_stock_at     integer NOT NULL DEFAULT 3 CHECK (low_stock_at >= 0),
  part_type        text NOT NULL DEFAULT 'aftermarket' CHECK (part_type IN ('oem','genuine','aftermarket')),
  warranty_months  integer CHECK (warranty_months >= 0),
  summary          text,
  highlights       jsonb NOT NULL DEFAULT '[]'::jsonb,
  specs            jsonb NOT NULL DEFAULT '[]'::jsonb,
  fitment          jsonb NOT NULL DEFAULT '[]'::jsonb,
  images           jsonb NOT NULL DEFAULT '[]'::jsonb,
  pending_revision jsonb,
  review_notes     jsonb,
  rejection_reason text,
  submitted_at     timestamptz,
  approved_at      timestamptz,
  approved_by      text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (price <= mrp)
);
CREATE UNIQUE INDEX vendor_products_sku_key ON vendor_products (vendor_id, lower(sku));
CREATE INDEX vendor_products_status_idx ON vendor_products (status);
CREATE INDEX vendor_products_vendor_idx ON vendor_products (vendor_id, status);

CREATE TABLE orders (
  id             text PRIMARY KEY,
  number         text NOT NULL UNIQUE,
  status         text NOT NULL DEFAULT 'placed'
                 CHECK (status IN ('placed','confirmed','completed','cancelled')),
  customer_name  text NOT NULL,
  customer_phone text NOT NULL,
  customer_email text,
  address        text NOT NULL,
  city           text NOT NULL,
  state          text NOT NULL,
  pincode        text NOT NULL,
  notes          text,
  subtotal       integer NOT NULL,
  shipping       integer NOT NULL,
  total          integer NOT NULL,
  channel        text NOT NULL DEFAULT 'whatsapp',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_created_idx ON orders (created_at DESC);

CREATE TABLE vendor_orders (
  id              text PRIMARY KEY,
  order_id        text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  vendor_id       text NOT NULL REFERENCES vendors(id),
  status          text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','accepted','packed','shipped','delivered','cancelled','return_requested','returned')),
  subtotal        integer NOT NULL,
  commission_rate numeric(5,2) NOT NULL,
  courier         text,
  tracking_number text,
  cancel_reason   text,
  accepted_at     timestamptz,
  packed_at       timestamptz,
  shipped_at      timestamptz,
  delivered_at    timestamptz,
  cancelled_at    timestamptz,
  returned_at     timestamptz,
  payout_id       text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, vendor_id)
);
CREATE INDEX vendor_orders_vendor_idx ON vendor_orders (vendor_id, status);

CREATE TABLE order_items (
  id              text PRIMARY KEY,
  order_id        text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  vendor_order_id text REFERENCES vendor_orders(id) ON DELETE CASCADE,
  product_kind    text NOT NULL CHECK (product_kind IN ('house','vendor')),
  product_ref     text NOT NULL,
  title           text NOT NULL,
  variant         text,
  unit_price      integer NOT NULL,
  install_price   integer NOT NULL DEFAULT 0,
  qty             integer NOT NULL CHECK (qty BETWEEN 1 AND 99),
  line_total      integer NOT NULL
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE vendor_payouts (
  id            text PRIMARY KEY,
  vendor_id     text NOT NULL REFERENCES vendors(id),
  gross         integer NOT NULL,
  commission    integer NOT NULL,
  commission_gst integer NOT NULL,
  net           integer NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  reference     text,
  paid_at       timestamptz,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_payouts_vendor_idx ON vendor_payouts (vendor_id, created_at DESC);

CREATE TABLE vendor_change_requests (
  id          text PRIMARY KEY,
  vendor_id   text NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('bank')),
  payload_sealed text NOT NULL,
  summary     text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id         text PRIMARY KEY,
  vendor_id  text NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  type       text NOT NULL CHECK (type IN ('account','product','order','stock','payout','support')),
  title      text NOT NULL,
  body       text NOT NULL,
  link       text,
  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_vendor_idx ON notifications (vendor_id, created_at DESC);

CREATE TABLE support_tickets (
  id          text PRIMARY KEY,
  vendor_id   text NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  subject     text NOT NULL,
  body        text NOT NULL,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  admin_reply text,
  replied_by  text,
  replied_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX support_tickets_vendor_idx ON support_tickets (vendor_id, created_at DESC);

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL CHECK (actor_type IN ('vendor','admin','system','customer')),
  actor      text NOT NULL,
  vendor_id  text,
  action     text NOT NULL,
  detail     jsonb,
  ip         text
);
CREATE INDEX audit_log_vendor_idx ON audit_log (vendor_id, at DESC);
`,
  },
  {
    // One pending change request per vendor and kind. The insert's NOT EXISTS check alone
    // lets two simultaneous requests both through; this makes the database refuse the second.
    id: "002_one_pending_change_request",
    sql: `
CREATE UNIQUE INDEX vendor_change_requests_one_pending ON vendor_change_requests (vendor_id, kind) WHERE status = 'pending';
`,
  },
  {
    // A session showing the seller's offline store screen is locked to it: the dashboard and
    // seller APIs refuse it until the seller unlocks with their password (src/lib/server/session.ts).
    id: "003_store_screen_lock",
    sql: `
ALTER TABLE vendor_sessions ADD COLUMN kiosk_locked_at timestamptz;
`,
  },
  {
    // Customer accounts (src/lib/server/customers.ts): sign-in with a one-time code to a mobile or
    // an email, no password. Orders link to the account that placed them; guest checkout stays.
    id: "004_customer_accounts",
    sql: `
CREATE TABLE customers (
  id                 text PRIMARY KEY,
  name               text,
  mobile             text,
  email              text,
  mobile_verified_at timestamptz,
  email_verified_at  timestamptz,
  car                jsonb,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (mobile IS NOT NULL OR email IS NOT NULL)
);
CREATE UNIQUE INDEX customers_mobile_key ON customers (mobile) WHERE mobile IS NOT NULL;
CREATE UNIQUE INDEX customers_email_key ON customers (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE customer_sessions (
  token_hash   text PRIMARY KEY,
  customer_id  text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text
);
CREATE INDEX customer_sessions_customer_idx ON customer_sessions (customer_id);

CREATE TABLE customer_addresses (
  id          text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label       text NOT NULL,
  name        text NOT NULL,
  mobile      text NOT NULL,
  address     text NOT NULL,
  city        text NOT NULL,
  state       text NOT NULL,
  pincode     text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_addresses_customer_idx ON customer_addresses (customer_id);
CREATE UNIQUE INDEX customer_addresses_one_default ON customer_addresses (customer_id) WHERE is_default;

CREATE TABLE customer_wishlist (
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  item        jsonb NOT NULL,
  saved_at    timestamptz NOT NULL,
  PRIMARY KEY (customer_id, slug)
);

-- Help-desk messages from shoppers (signed in or not). Seller tickets stay in support_tickets.
CREATE TABLE customer_tickets (
  id           text PRIMARY KEY,
  customer_id  text REFERENCES customers(id) ON DELETE SET NULL,
  name         text NOT NULL,
  mobile       text NOT NULL,
  email        text,
  order_number text,
  topic        text NOT NULL CHECK (topic IN ('order','product','fitment','installation','returns','other')),
  body         text NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  admin_reply  text,
  replied_by   text,
  replied_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_tickets_status_idx ON customer_tickets (status, created_at);
CREATE INDEX customer_tickets_customer_idx ON customer_tickets (customer_id, created_at DESC);

ALTER TABLE orders ADD COLUMN customer_id text REFERENCES customers(id) ON DELETE SET NULL;
CREATE INDEX orders_customer_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_customer_phone_idx ON orders (customer_phone) WHERE customer_id IS NULL;

-- Customer codes get their own purposes, so a seller's code can never sign a customer in.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'vendor_otps'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%purpose%'
  LOOP
    EXECUTE 'ALTER TABLE vendor_otps DROP CONSTRAINT ' || quote_ident(c);
  END LOOP;
END $$;
ALTER TABLE vendor_otps ADD CONSTRAINT vendor_otps_purpose_check
  CHECK (purpose IN ('verify','login','reset','customer_login','customer_contact'));
`,
  },
  {
    // Riderzpro's own delivery riders (src/lib/server/riders.ts): apply with a mobile code, admin
    // review, then deliveries assigned by the admin, proof of delivery with the customer's code,
    // earnings and payouts. No identity documents are stored: the team checks the licence, RC and
    // insurance in person before approval.
    id: "005_riders",
    sql: `
CREATE TABLE riders (
  id               text PRIMARY KEY,
  mobile           text NOT NULL,
  name             text NOT NULL,
  city             text NOT NULL,
  vehicle_type     text NOT NULL CHECK (vehicle_type IN ('bicycle','ev_scooter','scooter','motorcycle')),
  vehicle_number   text,
  status           text NOT NULL DEFAULT 'applied'
                   CHECK (status IN ('applied','approved','changes_requested','rejected','suspended')),
  review_note      text,
  reviewed_by      text,
  reviewed_at      timestamptz,
  consent_version  text NOT NULL,
  consented_at     timestamptz NOT NULL,
  online           boolean NOT NULL DEFAULT false,
  online_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Bicycles and low-speed e-scooters need no registration; everything else does.
  CHECK (vehicle_type IN ('bicycle','ev_scooter') OR vehicle_number IS NOT NULL)
);
CREATE UNIQUE INDEX riders_mobile_key ON riders (mobile);
CREATE INDEX riders_status_idx ON riders (status);

CREATE TABLE rider_sessions (
  token_hash   text PRIMARY KEY,
  mobile       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text
);
CREATE INDEX rider_sessions_mobile_idx ON rider_sessions (mobile);

CREATE TABLE rider_payouts (
  id          text PRIMARY KEY,
  rider_id    text NOT NULL REFERENCES riders(id),
  amount      integer NOT NULL CHECK (amount > 0),
  jobs        integer NOT NULL,
  reference   text NOT NULL,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rider_payouts_rider_idx ON rider_payouts (rider_id, created_at DESC);

-- One delivery: a seller's part of an order (vendor_order_id), or the items Riderzpro sells itself.
CREATE TABLE rider_jobs (
  id                 text PRIMARY KEY,
  order_id           text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  vendor_order_id    text REFERENCES vendor_orders(id) ON DELETE CASCADE,
  rider_id           text NOT NULL REFERENCES riders(id),
  status             text NOT NULL DEFAULT 'offered'
                     CHECK (status IN ('offered','accepted','picked_up','delivered','declined','cancelled')),
  pickup_name        text NOT NULL,
  pickup_address     text NOT NULL,
  pickup_phone       text,
  drop_name          text NOT NULL,
  drop_address       text NOT NULL,
  drop_phone         text NOT NULL,
  city               text NOT NULL,
  earning            integer NOT NULL CHECK (earning >= 0),
  -- Shown to the customer on their order page; the rider enters it to finish the delivery.
  delivery_code      text NOT NULL,
  code_attempts      integer NOT NULL DEFAULT 0,
  note               text,
  cancel_reason      text,
  created_by         text NOT NULL,
  offered_at         timestamptz NOT NULL DEFAULT now(),
  accepted_at        timestamptz,
  picked_up_at       timestamptz,
  delivered_at       timestamptz,
  closed_at          timestamptz,
  payout_id          text REFERENCES rider_payouts(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rider_jobs_rider_idx ON rider_jobs (rider_id, status, created_at DESC);
CREATE INDEX rider_jobs_order_idx ON rider_jobs (order_id);
-- At most one live job per shipment (a declined or cancelled one can be re-offered).
CREATE UNIQUE INDEX rider_jobs_one_live_part ON rider_jobs (vendor_order_id)
  WHERE vendor_order_id IS NOT NULL AND status IN ('offered','accepted','picked_up','delivered');
CREATE UNIQUE INDEX rider_jobs_one_live_house ON rider_jobs (order_id)
  WHERE vendor_order_id IS NULL AND status IN ('offered','accepted','picked_up','delivered');

CREATE TABLE rider_job_events (
  id         bigserial PRIMARY KEY,
  job_id     text NOT NULL REFERENCES rider_jobs(id) ON DELETE CASCADE,
  actor      text NOT NULL,
  from_status text,
  to_status  text NOT NULL,
  note       text,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rider_job_events_job_idx ON rider_job_events (job_id, at);

ALTER TABLE vendor_otps DROP CONSTRAINT vendor_otps_purpose_check;
ALTER TABLE vendor_otps ADD CONSTRAINT vendor_otps_purpose_check
  CHECK (purpose IN ('verify','login','reset','customer_login','customer_contact','rider_login'));
`,
  },
  {
    // Phase 3: live tracking. The rider's phone sends its position only while a job is accepted or
    // picked up, after the rider agrees (riders.location_consent_at). Each live job keeps its latest
    // point and a short trail; the trail is deleted when the job closes, and a delivered job keeps
    // only its last point for 30 days (src/lib/server/tracking.ts, trackingHousekeeping).
    id: "006_live_tracking",
    sql: `
ALTER TABLE riders ADD COLUMN location_consent_at timestamptz;

-- Where the parcel goes. 'device': the customer's own GPS at checkout; 'address': the address
-- geocoded to a street-level point; 'area': only the pincode or locality matched (no geofence);
-- 'failed': geocoding found nothing (the order page shows status without a map); 'pending': a
-- geocode is in flight.
ALTER TABLE orders ADD COLUMN delivery_lat double precision;
ALTER TABLE orders ADD COLUMN delivery_lng double precision;
ALTER TABLE orders ADD COLUMN delivery_geo text CHECK (delivery_geo IN ('device','address','area','failed','pending'));
ALTER TABLE orders ADD COLUMN delivery_geo_at timestamptz;
ALTER TABLE orders ADD CONSTRAINT orders_delivery_point_check
  CHECK ((delivery_lat IS NULL) = (delivery_lng IS NULL)
         AND (delivery_lat IS NULL OR (delivery_lat BETWEEN -90 AND 90 AND delivery_lng BETWEEN -180 AND 180)));

ALTER TABLE customer_addresses ADD COLUMN lat double precision;
ALTER TABLE customer_addresses ADD COLUMN lng double precision;
ALTER TABLE customer_addresses ADD CONSTRAINT customer_addresses_point_check
  CHECK ((lat IS NULL) = (lng IS NULL) AND (lat IS NULL OR (lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180)));

-- The latest point for each live job, plus what the geofence and off-route checks remember.
CREATE TABLE rider_locations (
  job_id          text PRIMARY KEY REFERENCES rider_jobs(id) ON DELETE CASCADE,
  rider_id        text NOT NULL REFERENCES riders(id),
  lat             double precision NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng             double precision NOT NULL CHECK (lng BETWEEN -180 AND 180),
  accuracy_m      integer NOT NULL CHECK (accuracy_m >= 0),
  heading         integer CHECK (heading BETWEEN 0 AND 359),
  speed_kmh       integer CHECK (speed_kmh >= 0),
  at              timestamptz NOT NULL,
  -- Straight-line metres to the delivery point at the last ping (null without a delivery point).
  distance_m      integer,
  -- Off-route check (picked-up jobs only): where the rider was when the trip to the customer began,
  -- the closest they have been since, and when they first looked off route (null = on route).
  start_lat       double precision,
  start_lng       double precision,
  min_distance_m  integer,
  off_route_since timestamptz,
  -- Road route cached for the customer's map: refreshed when the rider has moved or it is old.
  route           jsonb,
  route_m         integer,
  route_s         integer,
  route_from_lat  double precision,
  route_from_lng  double precision,
  route_at        timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rider_locations_rider_idx ON rider_locations (rider_id, at DESC);

-- A short trail of recent points per live job (pruned to the last 30 minutes on every ping).
CREATE TABLE rider_location_trail (
  id         bigserial PRIMARY KEY,
  job_id     text NOT NULL REFERENCES rider_jobs(id) ON DELETE CASCADE,
  lat        double precision NOT NULL,
  lng        double precision NOT NULL,
  accuracy_m integer NOT NULL,
  at         timestamptz NOT NULL
);
CREATE INDEX rider_location_trail_job_idx ON rider_location_trail (job_id, at);

-- Geofence and route alerts. No coordinates are stored here, only the distance.
CREATE TABLE tracking_events (
  id          bigserial PRIMARY KEY,
  job_id      text NOT NULL REFERENCES rider_jobs(id) ON DELETE CASCADE,
  order_id    text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('arriving','arrived','off_route')),
  distance_m  integer,
  detail      text,
  at          timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);
CREATE INDEX tracking_events_job_idx ON tracking_events (job_id, at);
-- "arriving" and "arrived" happen once per job; one open off-route alert per job at a time.
CREATE UNIQUE INDEX tracking_events_once ON tracking_events (job_id, kind) WHERE kind IN ('arriving','arrived');
CREATE UNIQUE INDEX tracking_events_open_off_route ON tracking_events (job_id) WHERE kind = 'off_route' AND resolved_at IS NULL;
`,
  },
  {
    // Online payments (Razorpay). Order totals stay integer RUPEES as everywhere else; every
    // amount in the payment tables is integer PAISE (`*_paise`), the unit Razorpay's API uses.
    id: "007_payments",
    sql: `
ALTER TABLE orders ADD COLUMN payment_method text NOT NULL DEFAULT 'whatsapp'
  CHECK (payment_method IN ('whatsapp','cod','online'));
-- pending: not paid yet (WhatsApp orders are settled offline and stay pending here)
-- failed: the last online attempt failed or the order expired unpaid
ALTER TABLE orders ADD COLUMN payment_status text NOT NULL DEFAULT 'pending'
  CHECK (payment_status IN ('pending','paid','failed','refunded','partially_refunded'));
ALTER TABLE orders ADD COLUMN paid_at timestamptz;
-- The unpaid-order release (releaseUnpaidOrders) scans only these.
CREATE INDEX orders_unpaid_online_idx ON orders (created_at)
  WHERE payment_method = 'online' AND payment_status IN ('pending','failed') AND status = 'placed';

-- One Razorpay order per attempt to pay a Riderzpro order.
CREATE TABLE payments (
  id                  text PRIMARY KEY,
  order_id            text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider            text NOT NULL DEFAULT 'razorpay' CHECK (provider IN ('razorpay')),
  razorpay_order_id   text NOT NULL UNIQUE,
  razorpay_payment_id text UNIQUE,
  amount_paise        integer NOT NULL CHECK (amount_paise > 0),
  currency            text NOT NULL DEFAULT 'INR',
  status              text NOT NULL DEFAULT 'created' CHECK (status IN ('created','failed','paid','expired')),
  method              text,
  error_code          text,
  error_description   text,
  failed_attempts     integer NOT NULL DEFAULT 0,
  verified_via        text CHECK (verified_via IN ('checkout','webhook','reconcile')),
  last_event_id       text,
  paid_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_order_idx ON payments (order_id);
CREATE UNIQUE INDEX payments_one_paid_per_order ON payments (order_id) WHERE status = 'paid';

CREATE TABLE refunds (
  id                 text PRIMARY KEY,
  payment_id         text NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  order_id           text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  razorpay_refund_id text UNIQUE,
  amount_paise       integer NOT NULL CHECK (amount_paise > 0),
  -- requested: sent to Razorpay, no answer yet; pending: accepted by Razorpay; processed: money returned
  status             text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','pending','processed','failed')),
  reason             text NOT NULL,
  source             text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin','dashboard')),
  created_by         text NOT NULL,
  error              text,
  processed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_payment_idx ON refunds (payment_id);
CREATE INDEX refunds_order_idx ON refunds (order_id, created_at);

-- Razorpay retries webhooks; each event id is processed once.
CREATE TABLE payment_webhook_events (
  event_id          text PRIMARY KEY,
  event             text NOT NULL,
  razorpay_order_id text,
  result            text,
  received_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payment_webhook_events_received_idx ON payment_webhook_events (received_at);
`,
  },
  {
    // Riderzpro's own GST tax invoices to customers (src/lib/server/customer-invoice.ts) and a log of
    // order and delivery messages, so each goes out once (src/lib/server/messaging.ts).
    //   invoice_series     one row per financial year; the next number is taken inside the transaction
    //                      that writes the invoice, so numbers are gap-free and never shared
    //   customer_invoices  one per order, with everything printed frozen in "snapshot"
    //   message_log        what was sent, never the message text
    id: "008_customer_invoices",
    sql: `
CREATE TABLE invoice_series (
  fy       text PRIMARY KEY CHECK (fy ~ '^[0-9]{4}-[0-9]{2}$'),
  last_no  integer NOT NULL CHECK (last_no > 0)
);

CREATE TABLE customer_invoices (
  id         text PRIMARY KEY,
  order_id   text NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  number     text NOT NULL UNIQUE,
  fy         text NOT NULL,
  seq        integer NOT NULL,
  issued_at  timestamptz NOT NULL,
  total      integer NOT NULL,
  snapshot   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (fy, seq)
);

CREATE TABLE message_log (
  id          text PRIMARY KEY,
  dedupe_key  text NOT NULL UNIQUE,
  kind        text NOT NULL,
  order_id    text REFERENCES orders(id) ON DELETE SET NULL,
  channel     text NOT NULL CHECK (channel IN ('email','sms')),
  ref         text NOT NULL DEFAULT '',
  status      text NOT NULL CHECK (status IN ('pending','sent','dev','skipped','failed')),
  provider_id text,
  reason      text,
  attempts    integer NOT NULL DEFAULT 1,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_log_order_idx ON message_log (order_id);
`,
  },
  {
    // Admin team accounts (src/lib/server/admin-auth.ts), replacing the single Basic-auth login.
    //   admin_users     one row per team member; role decides what they can open. source 'env' is the
    //                   owner signing in with ADMIN_USER / ADMIN_PASSWORD (no stored password)
    //   admin_sessions  signed-in browsers (token hash only), 12 hours
    //   admin_invites   one-time links to join the team or set a new password (token hash only)
    id: "009_admin_team",
    sql: `
CREATE TABLE admin_users (
  id              text PRIMARY KEY,
  email           text NOT NULL UNIQUE CHECK (email = lower(email)),
  name            text NOT NULL,
  role            text NOT NULL CHECK (role IN ('owner','manager','operations','catalog','finance','support')),
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  source          text NOT NULL DEFAULT 'team' CHECK (source IN ('team','env')),
  password_hash   text,
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  last_sign_in_at timestamptz
);

CREATE TABLE admin_sessions (
  token_hash   text PRIMARY KEY,
  admin_id     text NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  user_agent   text,
  ip           text
);
CREATE INDEX admin_sessions_admin_idx ON admin_sessions (admin_id);

CREATE TABLE admin_invites (
  id         text PRIMARY KEY,
  kind       text NOT NULL CHECK (kind IN ('invite','reset')),
  email      text NOT NULL CHECK (email = lower(email)),
  name       text NOT NULL,
  role       text NOT NULL CHECK (role IN ('owner','manager','operations','catalog','finance','support')),
  token_hash text NOT NULL UNIQUE,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz
);
-- One open link per email at a time.
CREATE UNIQUE INDEX admin_invites_one_open ON admin_invites (email) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
`,
  },
  {
    // Coupons (src/lib/server/coupons.ts). A coupon lowers Riderzpro's own part of an order only
    // (its products, installation and the delivery charge), never a marketplace seller's items, so
    // seller invoices and payouts are untouched and the discount shows on Riderzpro's tax invoice.
    //   coupons             the codes; "public" ones are listed on /offers
    //   coupon_redemptions  one per order; cancelled orders don't count towards the limits
    id: "010_coupons",
    sql: `
CREATE TABLE coupons (
  id               text PRIMARY KEY,
  code             text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{3,20}$'),
  title            text NOT NULL,
  description      text,
  kind             text NOT NULL CHECK (kind IN ('percent','flat','free_shipping')),
  value            integer NOT NULL DEFAULT 0 CHECK (value >= 0),
  max_discount     integer CHECK (max_discount IS NULL OR max_discount > 0),
  min_order        integer NOT NULL DEFAULT 0 CHECK (min_order >= 0),
  starts_at        timestamptz,
  ends_at          timestamptz,
  usage_limit      integer CHECK (usage_limit IS NULL OR usage_limit > 0),
  per_customer     integer NOT NULL DEFAULT 1 CHECK (per_customer > 0),
  public           boolean NOT NULL DEFAULT false,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','ended')),
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'percent' OR value BETWEEN 1 AND 90),
  CHECK (kind <> 'flat' OR value > 0),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE coupon_redemptions (
  id             text PRIMARY KEY,
  coupon_id      text NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
  order_id       text NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  amount         integer NOT NULL CHECK (amount >= 0),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX coupon_redemptions_coupon_idx ON coupon_redemptions (coupon_id, customer_phone);

-- Order totals: total = subtotal + shipping - discount (integer rupees).
ALTER TABLE orders ADD COLUMN discount integer NOT NULL DEFAULT 0 CHECK (discount >= 0);
ALTER TABLE orders ADD COLUMN coupon_code text;
`,
  },
  {
    // Selling from the Offline Store screen (src/lib/server/store-sales.ts).
    //   store_settings  per seller: the AI salesperson, bargaining limits, how customers may pay
    //   store_offers    a discount the AI agreed with a customer at the screen, checked again at
    //                   checkout (never above the seller's limit), usable once
    //   vendor_orders.collected_by  'seller' when the customer paid at the shop's counter: the seller
    //                   already has the money, so it is never paid out again
    //   orders.payment_method 'counter' = pay at the shop's counter
    id: "011_store_sales",
    sql: `
CREATE TABLE store_settings (
  vendor_id           text PRIMARY KEY REFERENCES vendors(id) ON DELETE CASCADE,
  ai_enabled          boolean NOT NULL DEFAULT true,
  bargain_enabled     boolean NOT NULL DEFAULT false,
  max_discount_pct    integer NOT NULL DEFAULT 5 CHECK (max_discount_pct BETWEEN 0 AND 30),
  max_discount_rupees integer CHECK (max_discount_rupees IS NULL OR max_discount_rupees > 0),
  pay_on_screen       boolean NOT NULL DEFAULT true,
  pay_at_counter      boolean NOT NULL DEFAULT true,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE store_offers (
  id            text PRIMARY KEY,
  vendor_id     text NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  percent       integer NOT NULL CHECK (percent BETWEEN 1 AND 30),
  cap           integer NOT NULL CHECK (cap > 0),
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  used_order_id text REFERENCES orders(id) ON DELETE SET NULL
);
CREATE INDEX store_offers_vendor_idx ON store_offers (vendor_id, created_at DESC);

ALTER TABLE vendor_orders ADD COLUMN collected_by text NOT NULL DEFAULT 'platform' CHECK (collected_by IN ('platform','seller'));

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_method_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_method_check CHECK (payment_method IN ('whatsapp','cod','online','counter'));
`,
  },
  {
    // Salesman AI log (src/lib/server/salesman-log.ts): one row per customer question on a shop
    // screen, to measure the salesman (Phase 1). Seller practice chats are not logged.
    //   orders.salesman_conversation  the chat the order came from, so "% paid" can be counted
    id: "012_salesman_log",
    sql: `
CREATE TABLE salesman_turns (
  id              text PRIMARY KEY,
  vendor_id       text NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  conversation_id text NOT NULL,
  mode            text NOT NULL CHECK (mode IN ('full','basic')),
  question        text NOT NULL,
  reply           text NOT NULL,
  shown           integer NOT NULL DEFAULT 0,
  added           integer NOT NULL DEFAULT 0,
  offer_pct       integer,
  checkout        boolean NOT NULL DEFAULT false,
  staff           boolean NOT NULL DEFAULT false,
  input_tokens    integer NOT NULL DEFAULT 0,
  output_tokens   integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX salesman_turns_vendor_idx ON salesman_turns (vendor_id, created_at DESC);
CREATE INDEX salesman_turns_conversation_idx ON salesman_turns (conversation_id);

ALTER TABLE orders ADD COLUMN salesman_conversation text;
`,
  },
  {
    // The shop's address on the Offline Store screen, as the seller wants customers to see it
    // ("Autoform Store, Lajpat Nagar, Delhi"). Empty: the screen shows the pickup address.
    id: "013_store_screen_address",
    sql: `
ALTER TABLE store_settings ADD COLUMN screen_address text CHECK (screen_address IS NULL OR length(screen_address) <= 120);
`,
  },
  {
    // The welcome screen of the Offline Store: the shop's opening hours ("Mon–Sat, 10 am – 8 pm";
    // empty: "Open all days, 10 am – 8 pm") and today's offer ("Free fitting on seat covers today";
    // empty: none shown).
    id: "014_store_screen_hours_offer",
    sql: `
ALTER TABLE store_settings ADD COLUMN screen_hours text CHECK (screen_hours IS NULL OR length(screen_hours) <= 80);
ALTER TABLE store_settings ADD COLUMN screen_offer text CHECK (screen_offer IS NULL OR length(screen_offer) <= 140);
`,
  },
  {
    // Offline Store follow-ups for the seller (store-receipts.ts, store-summary.ts).
    //   store_receipts         each receipt a customer asked for after a screen sale: the channel and
    //                          what happened, never the mobile or email it went to
    //   store_daily_summaries  the "today at your shop screen" notice, once per seller per India day
    id: "015_store_receipts_summary",
    sql: `
CREATE TABLE store_receipts (
  id         text PRIMARY KEY,
  order_id   text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  vendor_id  text NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  channel    text NOT NULL CHECK (channel IN ('email','sms')),
  status     text NOT NULL CHECK (status IN ('sent','dev','skipped','failed')),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX store_receipts_order_idx ON store_receipts (order_id);

CREATE TABLE store_daily_summaries (
  vendor_id  text NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  day        date NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, day)
);
`,
  },
  {
    // A seller's own shop categories (and sub-categories one level down) for the Offline Store
    // screen. A product may sit in one; the marketplace department/group stays as it is.
    id: "016_store_categories",
    sql: `
CREATE TABLE store_categories (
  id         text PRIMARY KEY,
  vendor_id  text NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  parent_id  text REFERENCES store_categories(id) ON DELETE CASCADE,
  name       text NOT NULL,
  position   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX store_categories_vendor_idx ON store_categories (vendor_id, parent_id, position);
CREATE UNIQUE INDEX store_categories_name_key ON store_categories (vendor_id, coalesce(parent_id, ''), lower(name));

ALTER TABLE vendor_products ADD COLUMN store_category_id text REFERENCES store_categories(id) ON DELETE SET NULL;

-- Indus Enterprises' shop categories, as the owner asked (only where that shop exists).
INSERT INTO store_categories (id, vendor_id, parent_id, name, position)
SELECT 'sc_indus_' || c.key, v.id, NULL, c.name, c.pos
  FROM vendors v,
       (VALUES ('seat_cover','Seat Cover',1), ('mats','Mats',2), ('speaker','Speaker',3), ('stereo','Stereo',4),
               ('dashcam','Dashcam',5), ('ortho_cushion','Orthopedic Cushion',6), ('fog_lamp','Fog Lamp',7),
               ('head_lamp','Head Lamp',8), ('lights','Lights',9), ('steering_cover','Steering Cover',10),
               ('protection_guard','Protection Guard',11), ('window_film','Window Film',12), ('car_care','Car Care',13))
         AS c(key, name, pos)
 WHERE v.slug = 'indus-enterprises';
INSERT INTO store_categories (id, vendor_id, parent_id, name, position)
SELECT 'sc_indus_mats_' || c.key, v.id, 'sc_indus_mats', c.name, c.pos
  FROM vendors v, (VALUES ('autoform','Autoform',1), ('gfx_pro','GFX Pro',2)) AS c(key, name, pos)
 WHERE v.slug = 'indus-enterprises';

-- Put Indus' existing products in the matching shop category.
UPDATE vendor_products p SET store_category_id = 'sc_indus_' || CASE p.group_slug
    WHEN 'seat-covers' THEN 'seat_cover'
    WHEN 'floor-mats' THEN 'mats'
    WHEN 'speakers' THEN 'speaker'
    WHEN 'subwoofers' THEN 'speaker'
    WHEN 'amplifiers' THEN 'speaker'
    WHEN 'displays' THEN 'stereo'
    WHEN 'cameras' THEN 'dashcam'
    WHEN 'comfort' THEN 'ortho_cushion'
    WHEN 'fog-drl' THEN 'fog_lamp'
    WHEN 'headlamps' THEN 'head_lamp'
    WHEN 'led-bulbs' THEN 'lights'
    WHEN 'ambient-lighting' THEN 'lights'
    WHEN 'auxiliary' THEN 'lights'
    WHEN 'steering-covers' THEN 'steering_cover'
    WHEN 'car-care' THEN 'car_care'
    WHEN 'exterior' THEN 'protection_guard'
    WHEN 'armour' THEN 'protection_guard'
  END
  FROM vendors v
 WHERE v.id = p.vendor_id AND v.slug = 'indus-enterprises'
   AND p.group_slug IN ('seat-covers','floor-mats','speakers','subwoofers','amplifiers','displays','cameras','comfort',
                        'fog-drl','headlamps','led-bulbs','ambient-lighting','auxiliary','steering-covers','car-care','exterior','armour');
UPDATE vendor_products p SET store_category_id = 'sc_indus_mats_' || CASE WHEN lower(p.brand) LIKE 'gfx%' THEN 'gfx_pro' ELSE 'autoform' END
  FROM vendors v
 WHERE v.id = p.vendor_id AND v.slug = 'indus-enterprises' AND p.group_slug = 'floor-mats'
   AND (lower(p.brand) LIKE 'gfx%' OR lower(p.brand) LIKE 'autoform%');
`,
  },
  {
    // Shop categories: a "Bestseller" tag and the categories to suggest alongside (empty = automatic).
    // Also makes sure Indus Enterprises has its categories wherever its slug differs, and adds Car Cover.
    id: "017_store_category_extras",
    sql: `
ALTER TABLE store_categories ADD COLUMN bestseller boolean NOT NULL DEFAULT false;
ALTER TABLE store_categories ADD COLUMN suggest_ids text[] NOT NULL DEFAULT '{}';

-- Indus Enterprises, by slug or by name (no temporary table: some hosted roles can't make one).

INSERT INTO store_categories (id, vendor_id, parent_id, name, position)
SELECT 'sc_' || substr(md5(v.id || c.key), 1, 20), v.id, NULL, c.name, c.pos
  FROM (SELECT id FROM vendors WHERE slug = 'indus-enterprises' OR lower(trim(store_name)) LIKE 'indus enterprises%') v,
       (VALUES ('seat_cover','Seat Cover',1), ('mats','Mats',2), ('speaker','Speaker',3), ('stereo','Stereo',4),
               ('dashcam','Dashcam',5), ('ortho_cushion','Orthopedic Cushion',6), ('fog_lamp','Fog Lamp',7),
               ('head_lamp','Head Lamp',8), ('lights','Lights',9), ('steering_cover','Steering Cover',10),
               ('protection_guard','Protection Guard',11), ('window_film','Window Film',12), ('car_care','Car Care',13))
         AS c(key, name, pos)
 WHERE NOT EXISTS (SELECT 1 FROM store_categories x WHERE x.vendor_id = v.id)
ON CONFLICT DO NOTHING;

INSERT INTO store_categories (id, vendor_id, parent_id, name, position)
SELECT 'sc_' || substr(md5(v.id || 'mats_' || c.key), 1, 20), v.id, m.id, c.name, c.pos
  FROM (SELECT id FROM vendors WHERE slug = 'indus-enterprises' OR lower(trim(store_name)) LIKE 'indus enterprises%') v
  JOIN store_categories m ON m.vendor_id = v.id AND m.parent_id IS NULL AND lower(m.name) = 'mats',
       (VALUES ('autoform','Autoform',1), ('gfx_pro','GFX Pro',2)) AS c(key, name, pos)
ON CONFLICT DO NOTHING;

-- Car Cover, tagged Bestseller, as the owner asked.
INSERT INTO store_categories (id, vendor_id, parent_id, name, position, bestseller)
SELECT 'sc_' || substr(md5(v.id || 'car_cover'), 1, 20), v.id, NULL, 'Car Cover',
       (SELECT coalesce(max(position), 0) + 1 FROM store_categories x WHERE x.vendor_id = v.id AND x.parent_id IS NULL), true
  FROM (SELECT id FROM vendors WHERE slug = 'indus-enterprises' OR lower(trim(store_name)) LIKE 'indus enterprises%') v
ON CONFLICT DO NOTHING;
UPDATE store_categories c SET bestseller = true
  FROM (SELECT id FROM vendors WHERE slug = 'indus-enterprises' OR lower(trim(store_name)) LIKE 'indus enterprises%') v WHERE c.vendor_id = v.id AND c.parent_id IS NULL AND lower(c.name) = 'car cover';

-- File Indus products that have no shop category yet, by their marketplace group.
UPDATE vendor_products p SET store_category_id = c.id
  FROM (SELECT id FROM vendors WHERE slug = 'indus-enterprises' OR lower(trim(store_name)) LIKE 'indus enterprises%') v, store_categories c
 WHERE p.vendor_id = v.id AND p.store_category_id IS NULL AND c.vendor_id = v.id AND c.parent_id IS NULL
   AND lower(c.name) = CASE p.group_slug
    WHEN 'seat-covers' THEN 'seat cover' WHEN 'floor-mats' THEN 'mats'
    WHEN 'speakers' THEN 'speaker' WHEN 'subwoofers' THEN 'speaker' WHEN 'amplifiers' THEN 'speaker'
    WHEN 'displays' THEN 'stereo' WHEN 'cameras' THEN 'dashcam' WHEN 'comfort' THEN 'orthopedic cushion'
    WHEN 'fog-drl' THEN 'fog lamp' WHEN 'headlamps' THEN 'head lamp'
    WHEN 'led-bulbs' THEN 'lights' WHEN 'ambient-lighting' THEN 'lights' WHEN 'auxiliary' THEN 'lights'
    WHEN 'steering-covers' THEN 'steering cover' WHEN 'car-care' THEN 'car care'
    WHEN 'armour' THEN 'protection guard'
    WHEN 'exterior' THEN CASE WHEN p.department = 'covers-guards' AND p.title ILIKE '%car cover%' THEN 'car cover' ELSE 'protection guard' END
  END;
`,
  },
  {
    // An order line keeps the tax and warranty facts it was sold with, so a seller editing or
    // deleting the product later can't change past invoices or receipts. Backfilled from the products.
    id: "018_order_item_tax_snapshot",
    sql: `
ALTER TABLE order_items ADD COLUMN hsn text;
ALTER TABLE order_items ADD COLUMN gst_rate integer;
ALTER TABLE order_items ADD COLUMN warranty_months integer;
UPDATE order_items i SET hsn = p.hsn, gst_rate = p.gst_rate, warranty_months = p.warranty_months
  FROM vendor_products p
 WHERE i.product_kind = 'vendor' AND p.id = i.product_ref;
`,
  },
  {
    // No commission on Offline Store screen sales. New screen sales already save 0%; this zeroes the
    // rate on older screen sales not yet paid out. vendor_orders stores only the rate (commission,
    // GST and net are worked out from it), so nothing else changes. Rows already paid out keep theirs.
    id: "019_store_sales_no_commission",
    sql: `
UPDATE vendor_orders vo SET commission_rate = 0, updated_at = now()
  FROM orders o
 WHERE o.id = vo.order_id AND o.channel = 'store' AND vo.payout_id IS NULL AND vo.commission_rate <> 0;
`,
  },
];
