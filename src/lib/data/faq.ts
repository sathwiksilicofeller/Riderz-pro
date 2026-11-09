import { FREE_SHIPPING_OVER, SHIPPING_FEE } from "@/lib/store/shipping";

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export type FaqItem = {
  q: string;
  a: string;
  /** Policy section the answer is based on, e.g. `/support/returns#fitment-guarantee`. */
  href: string;
  hrefLabel: string;
};

export type FaqGroup = {
  id: string;
  title: string;
  items: FaqItem[];
};

/** One source of truth for the /faq page and its FAQPage JSON-LD. */
export const FAQ_GROUPS: FaqGroup[] = [
  {
    id: "ordering",
    title: "Ordering",
    items: [
      {
        q: "How do I place an order?",
        a: "Add products to your cart, fill in your delivery details and pay online with Razorpay. Your order is confirmed as soon as the payment goes through, and we email and text you the confirmation.",
        href: "/support/payments#how-to-pay",
        hrefLabel: "How to pay",
      },
      {
        q: "Can I cancel an order?",
        a: "Yes, free of charge until it is dispatched. Made-to-order items can be cancelled until production starts, usually within 24 hours of ordering. Open the order in My orders and send us a message.",
        href: "/support/returns#cancellations",
        hrefLabel: "Cancellations",
      },
      {
        q: "What does made to order mean?",
        a: "Items such as Autoform seat covers, painted panels and custom audio enclosures are made for your car. They carry the lead time shown on the product page, and cannot be returned unless defective or not fitting as specified.",
        href: "/support/returns#made-to-order",
        hrefLabel: "Made-to-order items",
      },
    ],
  },
  {
    id: "fitment",
    title: "Fitment",
    items: [
      {
        q: "How do I know a part will fit my car?",
        a: "Save your car on the site and each product page shows whether it is listed for it. If your car isn't listed, or the page has no fitment list, ask us before you order and we check it against your variant and year.",
        href: "/support/returns#fitment-guarantee",
        hrefLabel: "Fitment guarantee",
      },
      {
        q: "What if a part you confirmed doesn't fit?",
        a: "We collect it at our cost and refund you in full, including any installation labour you paid us. This applies when the variant and year you gave us were correct.",
        href: "/support/returns#fitment-guarantee",
        hrefLabel: "Fitment guarantee",
      },
    ],
  },
  {
    id: "delivery",
    title: "Delivery",
    items: [
      {
        q: "How much is shipping?",
        a: `Free on orders of ${rupees(FREE_SHIPPING_OVER)} or more; below that a flat ${rupees(SHIPPING_FEE)}. Oversized items such as body kits and roof racks are quoted per consignment and you approve the figure before we bill it.`,
        href: "/support/shipping#charges",
        hrefLabel: "Shipping charges",
      },
      {
        q: "How long does delivery take?",
        a: "In-stock items ordered before 2 PM on a working day are dispatched the same day; everything else leaves within 48 hours. Delivery is 2–3 working days to metro cities, 3–6 to tier 2 and 3 cities and 6–10 to the north-east, Jammu & Kashmir, Ladakh and island territories. Oversized freight typically takes 5–9 working days.",
        href: "/support/shipping#delivery-times",
        hrefLabel: "Delivery estimates",
      },
      {
        q: "How do I track my order?",
        a: "Sign in with the mobile number you ordered with and open the order in My orders. It shows each seller's progress, the courier and tracking number once a part is dispatched, and the rider's live location when one of our riders delivers it. The confirmation email and SMS link to it.",
        href: "/track-order",
        hrefLabel: "Track your order",
      },
      {
        q: "My parcel arrived damaged. What now?",
        a: "Record a short video while opening it and send it to us within 48 hours. We ship a replacement immediately.",
        href: "/support/shipping#damaged-or-missing",
        hrefLabel: "Damaged or missing items",
      },
    ],
  },
  {
    id: "returns",
    title: "Returns",
    items: [
      {
        q: "What is your return policy?",
        a: "Seven days from delivery for unused items in original packaging, with all fittings and documentation included. Made-to-order items cannot be returned unless defective or not fitting as specified.",
        href: "/support/returns#return-window",
        hrefLabel: "Return window",
      },
      {
        q: "How do I start a return, and when do I get my refund?",
        a: "Open the order in My orders and send us a message with a photo. We arrange reverse pickup in most pin codes within 72 hours, and refund to the original payment method within 5 working days of the item reaching us.",
        href: "/support/returns#start-a-return",
        hrefLabel: "How to start a return",
      },
      {
        q: "What does the warranty cover?",
        a: "Each product page lists its own warranty period. Installation, wiring, fabrication and trim work done at a Riderzpro garage carries a twelve-month workmanship warranty.",
        href: "/support/warranty#product-warranties",
        hrefLabel: "Product warranties",
      },
    ],
  },
  {
    id: "installation",
    title: "Installation",
    items: [
      {
        q: "Can you fit what I buy?",
        a: "Yes, at our garages in Bengaluru, Hyderabad and Pune. Add installation to a product where it is offered, or book a slot on WhatsApp or through the Contact page.",
        href: "/support/installation#booking",
        hrefLabel: "Booking a fitting",
      },
      {
        q: "Can I reschedule a booking?",
        a: "Yes, free of charge up to 24 hours before the slot.",
        href: "/support/installation#reschedule",
        hrefLabel: "Rescheduling",
      },
    ],
  },
  {
    id: "oe",
    title: "OE parts",
    items: [
      {
        q: "Do you sell Original Equipment (OE) parts?",
        a: "OE parts are listed in several departments of the shop. Availability for your car is confirmed on WhatsApp before you order.",
        href: "/contact",
        hrefLabel: "Contact us",
      },
    ],
  },
  {
    id: "payments",
    title: "Payments",
    items: [
      {
        q: "How do I pay?",
        a: "Online at checkout with Razorpay. Your order is confirmed as soon as the payment goes through.",
        href: "/support/payments#how-to-pay",
        hrefLabel: "How to pay",
      },
      {
        q: "Do prices include GST?",
        a: "Prices shown online include GST unless stated otherwise. Shipping is added as described under Shipping charges.",
        href: "/support/payments#prices",
        hrefLabel: "Prices and GST",
      },
    ],
  },
];

export function faqJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ_GROUPS.flatMap((g) => g.items).map((i) => ({
      "@type": "Question",
      name: i.q,
      acceptedAnswer: { "@type": "Answer", text: i.a },
    })),
  };
}
