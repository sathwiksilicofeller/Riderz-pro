import type { Metadata } from "next";
import { getShopifyConfig, isShopifyCheckoutFlagOn } from "@/lib/shopify/config";
import { buildShopifyCsv, SKIP_LABELS, type SkipReason } from "@/lib/shopify/productCsv";
import { adminPage } from "@/lib/server/admin-auth";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Shopify setup",
  description: "Internal Shopify checkout setup status and product export.",
  robots: { index: false, follow: false, nocache: true },
};

const CHECKLIST = [
  "Create the Shopify store and a Storefront API access token (see docs/SHOPIFY_SETUP.md).",
  "Download the products CSV below and import it in Shopify (Products > Import). Keep every product handle unchanged.",
  "Set up payments, shipping and taxes in Shopify, then place a test order.",
  "Set SHOPIFY_STORE_DOMAIN and SHOPIFY_STOREFRONT_ACCESS_TOKEN, redeploy, and confirm this page says Configured.",
  "Set NEXT_PUBLIC_SHOPIFY_CHECKOUT=1 and redeploy to show the Checkout securely button.",
];

export default async function ShopifyAdminPage() {
  await adminPage("catalog", "/admin/shopify");
  const cfg = getShopifyConfig();
  const flag = isShopifyCheckoutFlagOn();
  const build = buildShopifyCsv();
  const skippedTotal = Object.values(build.skipped).reduce((a, b) => a + b, 0);

  return (
    <section className="section pt-24 md:pt-32">
      <div className="shell">
        <p className="eyebrow mb-3">Internal · not indexed</p>
        <h1 className="display-2">SHOPIFY SETUP</h1>

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          <div className="card p-5">
            <p className="eyebrow mb-2">Store connection</p>
            <p className={`font-display text-lg font-bold uppercase ${cfg ? "text-accent" : "text-gold"}`}>
              {cfg ? "Configured" : "Not configured"}
            </p>
            <p className="mt-1 text-xs text-ash">
              {cfg ? `${cfg.domain} · API ${cfg.apiVersion}` : "Checkout runs on the site, paid online with Razorpay."}
            </p>
          </div>
          <div className="card p-5">
            <p className="eyebrow mb-2">Checkout button</p>
            <p className={`font-display text-lg font-bold uppercase ${flag ? "text-accent" : "text-gold"}`}>
              {flag ? "On" : "Off"}
            </p>
            <p className="mt-1 text-xs text-ash">NEXT_PUBLIC_SHOPIFY_CHECKOUT {flag ? "= 1" : "is not 1"}</p>
          </div>
          <div className="card p-5">
            <p className="eyebrow mb-2">Export</p>
            <p className="font-display text-lg font-bold tnum">
              {build.products} products · {build.variants} variants
            </p>
            <p className="mt-1 text-xs text-ash tnum">{build.rows} CSV rows (incl. extra images)</p>
          </div>
        </div>

        <div className="mt-8">
          <a href="/admin/shopify/products.csv" className="btn btn-primary" download>
            Download Shopify products CSV
          </a>
        </div>

        <h2 className="mt-10 font-display text-sm font-bold uppercase tracking-[0.12em]">
          Skipped products ({skippedTotal})
        </h2>
        <ul className="mt-3 space-y-1 text-sm text-ash">
          {(Object.keys(SKIP_LABELS) as SkipReason[]).map((k) => (
            <li key={k} className="tnum">
              {SKIP_LABELS[k]}: {build.skipped[k]}
            </li>
          ))}
        </ul>
        <p className="mt-3 max-w-2xl text-xs text-dim">
          Stock quantities are exported only for products without options, because stock is tracked per product on
          the site. Set variant quantities in Shopify after importing. Prices include GST.
        </p>

        <h2 className="mt-10 font-display text-sm font-bold uppercase tracking-[0.12em]">Checklist</h2>
        <ol className="mt-3 max-w-2xl list-decimal space-y-2 pl-5 text-sm text-ash">
          {CHECKLIST.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ol>
      </div>
    </section>
  );
}
