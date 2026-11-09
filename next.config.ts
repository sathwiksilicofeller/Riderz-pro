import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

/** The scheme + host of a tile URL template such as https://{s}.tile.example.com/{z}/{x}/{y}.png. */
function tilesOrigin(template: string | undefined): string | null {
  const m = /^(https?:\/\/[^/]+)/i.exec((template ?? "").trim().replace(/\{s\}/g, "*"));
  return m ? m[1] : null;
}

/**
 * Content-Security-Policy, sent as Report-Only: browsers log what it would block (DevTools console)
 * but block nothing, so it can't break the site. Test every page with the frontend team (checkout
 * with Razorpay, rider map, /locations maps, admin document viewer, shop-screen mic), then switch
 * the header name to "Content-Security-Policy" to enforce it (docs/DEPLOY.md, "Security headers").
 * Built from what the app loads:
 * - scripts: Next's inline bootstrap and theme script ('unsafe-inline': no nonces), Razorpay
 *   checkout.js (src/lib/payments/checkout.ts); dev only: 'unsafe-eval' for hot reload.
 * - images: next/image is served from /_next/image ('self'); the remotePatterns hosts
 *   (REMOTE_IMAGES); data:/blob: for placeholders and previews; map tiles (NEXT_PUBLIC_MAP_TILES_URL, default OpenStreetMap).
 * - frames: Razorpay's payment window; Google Maps embeds on /locations.
 * - fonts: next/font self-hosts Google fonts ('self').
 * Routing and geocoding (OSRM, Nominatim) and every other API run on the server, so they're not here.
 */
const REMOTE_IMAGES: { protocol: "https"; hostname: string }[] = [
  { protocol: "https", hostname: "images.unsplash.com" },
  // Authentic RECOIL product photography, served from the manufacturer's
  // own media library and its official storefront CDN.
  { protocol: "https", hostname: "recoilaudio.com" },
  { protocol: "https", hostname: "cdn.shopify.com" },
];
const IMAGE_HOSTS = REMOTE_IMAGES.map((p) => `${p.protocol}://${p.hostname}`);
const TILES = tilesOrigin(process.env.NEXT_PUBLIC_MAP_TILES_URL) ?? "https://tile.openstreetmap.org";
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://checkout.razorpay.com${isProd ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${[...IMAGE_HOSTS, TILES, "https://*.razorpay.com"].join(" ")}`,
  "font-src 'self' data:",
  `connect-src 'self' https://api.razorpay.com https://lumberjack.razorpay.com${isProd ? "" : " ws: wss:"}`,
  "frame-src 'self' https://api.razorpay.com https://checkout.razorpay.com https://maps.google.com https://www.google.com",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Database drivers load native/wasm code at runtime; keep them out of the server bundle.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  devIndicators: false,
  images: {
    // Automotive photography is served from Unsplash's CDN and optimised by Next
    // into AVIF/WebP at the exact sizes the layout needs.
    formats: ["image/avif", "image/webp"],
    qualities: [60, 68, 72, 75],
    remotePatterns: REMOTE_IMAGES,
    deviceSizes: [360, 420, 640, 750, 828, 1080, 1200, 1600, 1920],
    imageSizes: [64, 96, 128, 200, 256, 320, 420],
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  experimental: {
    optimizePackageImports: [],
  },
  // Baseline security headers on every route. The CSP is Report-Only until it has been tested (see
  // CSP above): the site relies on inline scripts, so an untested enforced policy could break it.
  // HSTS in production only (local dev is plain http); without includeSubDomains, so a subdomain
  // still on http (the old site during the switch) keeps working.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(self), payment=(self \"https://checkout.razorpay.com\" \"https://api.razorpay.com\")" },
          ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
          { key: "Content-Security-Policy-Report-Only", value: CSP },
        ],
      },
    ];
  },
  // Pre-rebrand URLs (Motorbotz → Riderzpro), kept alive for bookmarks and search engines.
  redirects() {
    return [
      { source: "/shop/protection", destination: "/shop/covers-guards", permanent: true },
      { source: "/why-motorbotz", destination: "/why-riderzpro", permanent: true },
      { source: "/brands/motorbotz", destination: "/brands/riderzpro", permanent: true },
      { source: "/product/motorbotz-9d-floor-mats", destination: "/products/riderzpro-9d-floor-mats", permanent: true },
      {
        source: "/product/motorbotz-signature-component-set",
        destination: "/products/riderzpro-signature-component-set",
        permanent: true,
      },
      // One product page for every brand, at /products/{slug}. The explicit
      // rules above come first so the Motorbotz URLs resolve in a single hop.
      { source: "/product/:slug", destination: "/products/:slug", permanent: true },
      { source: "/autoform/:design", destination: "/products/autoform-:design", permanent: true },
      // The compare feature was dropped; its URL goes to the shop.
      { source: "/compare", destination: "/shop", permanent: true },
      // Pre-taxonomy shop categories, folded into the eight departments.
      { source: "/shop/audio", destination: "/shop/multimedia", permanent: true },
      { source: "/shop/off-road", destination: "/shop/off-roading", permanent: true },
      { source: "/shop/performance", destination: "/shop/accessories?group=performance", permanent: true },

      // The previous riderzpro.com site (a different app, replaced by this one): its page addresses
      // land on the matching page here instead of a 404.
      { source: "/login", destination: "/account/sign-in", permanent: true },
      { source: "/signup", destination: "/account/sign-in", permanent: true },
      { source: "/auth", destination: "/account/sign-in", permanent: true },
      { source: "/orders", destination: "/account/orders", permanent: true },
      { source: "/order/:id", destination: "/account/orders", permanent: true },
      { source: "/order-confirmation/:id", destination: "/account/orders", permanent: true },
      { source: "/track/:id", destination: "/account/orders", permanent: true },
      { source: "/dashboards", destination: "/account", permanent: true },
      { source: "/dashboard/customer", destination: "/account", permanent: true },
      { source: "/dashboard/vendor", destination: "/vendor/dashboard", permanent: true },
      { source: "/dashboard/rider", destination: "/rider/dashboard", permanent: true },
      { source: "/dashboard/admin", destination: "/admin", permanent: true },
      { source: "/dashboard/workshop", destination: "/garage", permanent: true },
      { source: "/app", destination: "/", permanent: true },
      { source: "/support", destination: "/contact", permanent: true },
      { source: "/privacy", destination: "/legal/privacy", permanent: true },
      { source: "/terms", destination: "/legal/terms", permanent: true },
      { source: "/vendor/login", destination: "/vendor/auth", permanent: true },
      { source: "/vendor/signup", destination: "/vendor/auth?mode=signup", permanent: true },
      { source: "/vendor/sign-up", destination: "/vendor/auth?mode=signup", permanent: true },
      // The old seller dashboard lived at /vendor/{id}; this site's own /vendor/* pages are excluded.
      { source: "/vendor/:id((?!auth$|dashboard$|onboarding$|pending$|offline-store$)[^/]+)", destination: "/vendor/dashboard", permanent: true },
      { source: "/admin/login", destination: "/admin", permanent: true },
      { source: "/super-admin", destination: "/admin", permanent: true },
      { source: "/super-admin/:path*", destination: "/admin", permanent: true },
      { source: "/superadmin", destination: "/admin", permanent: true },
    ];
  },
};

export default nextConfig;
