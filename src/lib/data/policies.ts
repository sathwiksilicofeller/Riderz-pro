import { SITE } from "@/lib/data/site";
import { FREE_SHIPPING_OVER, SHIPPING_FEE } from "@/lib/store/shipping";

export type PolicySection = {
  /** Anchor id — FAQ answers deep-link to `/{route}#{id}`. Keep stable. */
  id: string;
  heading: string;
  body: string[];
};

export type Policy = {
  slug: string;
  title: string;
  eyebrow: string;
  intro: string;
  /** Short search/share description; falls back to `intro` when absent. */
  metaDescription?: string;
  sections: PolicySection[];
};

const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

/** `SITE.legalName` already ends with a full stop ("… Pvt. Ltd."). */
const COMPANY = SITE.legalName;

export const SUPPORT_POLICIES: Policy[] = [
  {
    slug: "shipping",
    title: "SHIPPING & DELIVERY",
    eyebrow: "Customer support",
    intro:
      "We ship accessories across India. Large items — body kits, roof racks, exhausts — travel by surface freight and are quoted separately.",
    sections: [
      {
        id: "dispatch",
        heading: "Dispatch times",
        body: [
          "In-stock items ordered before 2 PM on a working day are dispatched the same day. Everything else leaves within 48 hours.",
          "Made-to-order items — seat covers, painted spoilers, custom audio enclosures — carry the lead time shown on the product page. We confirm the date with you after the order is placed. They follow the made-to-order terms on the Returns page.",
        ],
      },
      {
        id: "delivery-times",
        heading: "Delivery estimates",
        body: [
          "Metro cities: 2–3 working days. Tier 2 and 3 cities: 3–6 working days. North-east, Jammu & Kashmir, Ladakh and island territories: 6–10 working days.",
          "Oversized freight (body kits, bull bars, roof racks, tyre sets) moves by surface transport and typically takes 5–9 working days.",
        ],
      },
      {
        id: "charges",
        heading: "Shipping charges",
        body: [
          `Free standard shipping on orders of ${rupees(FREE_SHIPPING_OVER)} or more. Below that, a flat ${rupees(SHIPPING_FEE)} applies.`,
          "Oversized items are quoted per consignment based on weight and destination. You approve the figure before we bill it.",
        ],
      },
      {
        id: "tracking",
        heading: "Order tracking",
        body: [
          "When your payment goes through, we email and text you the order confirmation with a link to My orders. Sign in with the mobile number you ordered with to see it there.",
          "My orders shows each seller's progress, the courier and tracking number once a part is dispatched, and the rider's live location when one of our riders delivers it. We text you when the rider is close.",
          "If a consignment stalls for more than 48 hours, we chase the carrier ourselves rather than asking you to.",
          "Not sure where your order is? Open it in My orders and send us a message, or use the Track your order page.",
        ],
      },
      {
        id: "damaged-or-missing",
        heading: "Damaged or missing items",
        body: [
          "Record a short video while opening any package that arrives visibly damaged. Send it to us within 48 hours and we ship a replacement immediately — no investigation, no arguing with the courier on your time.",
          "If something is missing from your parcel, open the order in My orders and send us a message with a photo of what arrived. We reply with the next step.",
        ],
      },
    ],
  },
  {
    slug: "returns",
    title: "RETURNS, REFUNDS & CANCELLATIONS",
    eyebrow: "Customer support",
    intro:
      "If something doesn't fit, doesn't work or isn't what you expected, we take it back. The whole point of buying from a maker with its own garages rather than a marketplace is that someone stands behind the part.",
    sections: [
      {
        id: "return-window",
        heading: "Return window",
        body: [
          "Seven days from delivery for unused items in original packaging, with all fittings and documentation included.",
        ],
      },
      {
        id: "fitment-guarantee",
        heading: "Fitment guarantee",
        body: [
          "If a part we confirmed as compatible does not fit your vehicle, we collect it at our cost and refund you in full — including any installation labour you paid us.",
          "This is why we ask for your variant and year. Give us the wrong details and we can only offer a standard return.",
        ],
      },
      {
        id: "made-to-order",
        heading: "Made-to-order items",
        body: [
          "Made-to-order items — custom-cut seat covers (including Autoform sets), painted panels, custom audio enclosures, bespoke interiors — cannot be returned unless they are defective or do not fit as specified.",
          "Made-to-order items can be cancelled until production starts — usually within 24 hours of ordering.",
        ],
      },
      {
        id: "start-a-return",
        heading: "How to start a return",
        body: [
          "Open the order in My orders and send us a message with a photo. We arrange reverse pickup in most pin codes within 72 hours.",
        ],
      },
      {
        id: "refunds",
        heading: "Refunds",
        body: [
          "Refunds are processed within 5 working days of the item reaching us, back to the original payment method.",
        ],
      },
      {
        id: "cancellations",
        heading: "Cancellations",
        body: [
          "Orders can be cancelled free of charge until they are dispatched. Open the order in My orders and send us a message, and we refund an online payment to the original payment method.",
          "Made-to-order items can be cancelled until production starts — usually within 24 hours of ordering.",
        ],
      },
    ],
  },
  {
    slug: "warranty",
    title: "WARRANTY",
    eyebrow: "Customer support",
    intro:
      "Two things are warranted separately: the part, by whoever made it, and our workmanship, by us. We honour both without sending you to a manufacturer's helpline.",
    sections: [
      {
        id: "workmanship",
        heading: "Workmanship warranty",
        body: [
          "Twelve months on all installation, wiring, fabrication and trim work carried out at a Riderzpro garage.",
          "If something we fitted rattles, leaks, fails or comes loose within that period, we fix it free — including removing and refitting other parts to get to it.",
        ],
      },
      {
        id: "product-warranties",
        heading: "Product warranties",
        body: [
          "Each product page lists its own warranty period. Paint protection film is warranted for ten years against yellowing and cracking; ceramic coatings for five years and graphene for seven, subject to annual inspection.",
          "Structural steel — rock sliders, bull bars, roof racks — carries a five-year structural warranty.",
        ],
      },
      {
        id: "exclusions",
        heading: "What isn't covered",
        body: [
          "Damage from an accident, off-road impact beyond the product's rating, improper use, or work carried out on the part by another workshop.",
          "Consumables: filters, pads, bulbs, wiper elements and tyres, which are covered by wear limits rather than time.",
        ],
      },
      {
        id: "claims",
        heading: "Making a warranty claim",
        body: [
          "Message us on WhatsApp with your invoice number. Most claims are resolved with a workshop visit; where a manufacturer replacement is required, we raise it and hand you the replacement — you never deal with the brand directly.",
          "If you are not near one of our garages, tell us on WhatsApp and we will confirm how your claim will be handled.",
        ],
      },
    ],
  },
  {
    slug: "installation",
    title: "INSTALLATION & BOOKINGS",
    eyebrow: "Customer support",
    intro:
      "You can have what you buy fitted at a Riderzpro garage in Bengaluru, Hyderabad or Pune. Workmanship is warranted by the garage that did the work.",
    sections: [
      {
        id: "booking",
        heading: "Booking a fitting",
        body: [
          "Add installation to a product where it is offered, or book a slot with the form on the Contact page or on WhatsApp. We confirm your slot with you there.",
          "Autoform seat covers are made to order for your car: we take the order, confirm the pattern for your exact variant, and fit it at the workshop.",
        ],
      },
      {
        id: "reschedule",
        heading: "Rescheduling",
        body: ["Workshop bookings can be rescheduled free of charge up to 24 hours before the slot."],
      },
      {
        id: "builds",
        heading: "Larger builds",
        body: [
          "Quotes, deposits and storage for larger builds are covered in the Workshop bookings section of our Terms of Service.",
        ],
      },
      {
        id: "workmanship",
        heading: "Workmanship warranty",
        body: [
          "Twelve months on all installation, wiring, fabrication and trim work carried out at a Riderzpro garage. The full terms are on the Warranty page.",
        ],
      },
    ],
  },
  {
    slug: "payments",
    title: "PAYMENTS",
    eyebrow: "Customer support",
    intro: "How you pay for an order, prices and GST, and refunds.",
    sections: [
      {
        id: "how-to-pay",
        heading: "How to pay",
        body: [
          "Pay online at checkout: complete the payment securely with Razorpay. Your order is confirmed as soon as the payment goes through, and your tax invoice is in My orders.",
          "If an online payment isn't completed within 30 minutes, the order is cancelled and nothing is charged. If money left your account anyway, it is refunded.",
        ],
      },
      {
        id: "prices",
        heading: "Prices and GST",
        body: [
          "Prices shown online include GST unless stated otherwise. Shipping is added as described on the Shipping page.",
        ],
      },
      {
        id: "refund-method",
        heading: "Refunds",
        body: [
          "Refunds go back to the original payment method within 5 working days of the item reaching us. For online payments, your bank may take a few more working days to show the refund.",
        ],
      },
    ],
  },
];

export const LEGAL_POLICIES: Policy[] = [
  {
    slug: "privacy",
    title: "PRIVACY POLICY",
    eyebrow: "Legal",
    metaDescription: "What personal information Riderzpro collects, why we collect it, and how to access, correct or delete it.",
    intro: `This policy is issued by ${COMPANY} It owns the Riderzpro trademark and runs this store. It explains what we collect, why, and what you can ask us to do about it.`,
    sections: [
      {
        id: "on-this-site",
        heading: "What this website stores on your device",
        body: [
          "Your cart, your saved car, your theme choice, your recently viewed products and, when signed out, your wishlist are kept in your browser's local storage on your own device.",
          "When you sign in, a sign-in cookie keeps you signed in (60 days for shoppers). Sellers, delivery riders and our team have their own sign-in cookies. These cookies are needed for the site to work; we set no advertising or tracking cookies.",
        ],
      },
      {
        id: "what-we-collect",
        heading: "What we collect from you",
        body: [
          "Your account: your name, mobile number and/or email address (each confirmed with a one-time code), your saved delivery addresses, wishlist and car.",
          "Your orders: the items, the delivery details you give at checkout (name, phone, email, address and, if you choose \"Detect my location\", your location at that moment) and the order history, so we can deliver, honour warranties and answer questions. Messages you send us from the help form are kept with them.",
          "Online payments are taken by Razorpay on its own secure page. We never see or store your card, UPI or bank details; we keep the payment reference, amount and status.",
          "If you order on a seller's shop screen in their store, we keep your name and mobile number with that order.",
          "Enquiries that reach us on WhatsApp, by phone or by email, with the vehicle details we need to confirm fitment (make, model, variant and year).",
        ],
      },
      {
        id: "riders-sellers",
        heading: "Sellers and delivery riders",
        body: [
          "Sellers give us business and tax details, bank details and documents to verify their store. Bank account numbers and PAN are stored encrypted and shown only to our finance team when needed.",
          "Delivery riders give us their name, mobile, city and vehicle details. While a rider is delivering an order, and only if they agree, their phone shares its location so the customer can follow the delivery. The route trail is deleted when the delivery ends; the last point of a delivered order is kept for 30 days in case of a dispute, then deleted.",
        ],
      },
      {
        id: "ai-assistant",
        heading: "The AI shopping assistant",
        body: [
          "If you use the AI assistant (on this website or on a seller's shop screen), what you type or say is sent to Anthropic, which provides the AI model, to produce the answer. Don't type personal details into it; it never asks for them. We don't use your questions for advertising.",
        ],
      },
      {
        id: "why",
        heading: "Why we collect it",
        body: [
          "To run your account, fulfil orders, confirm fitment, take payments and refunds, schedule workshop slots, honour warranties and answer your messages.",
          "To keep the site secure: sign-in codes, limits on repeated attempts and a record of account and order changes.",
          "To contact you about an order or enquiry you started. We do not add you to marketing lists without your consent.",
        ],
      },
      {
        id: "sharing",
        heading: "Who we share it with",
        body: [
          "The seller of any marketplace item you order (your name, phone and delivery address, to fulfil it), our delivery riders and logistics partners, for delivery.",
          "Service providers who process it for us: Razorpay (payments), our email and SMS providers (sign-in codes, order confirmations and delivery alerts), Anthropic (the AI assistant) and OpenStreetMap services (maps, routes and turning a location into an address).",
          "We never sell personal data, and we do not share your vehicle details with third-party marketers.",
        ],
      },
      {
        id: "retention",
        heading: "How long we keep it",
        body: [
          "Sign-in codes: one day. Sign-in sessions: until they expire or you sign out. Rider location: as described above.",
          "Orders, invoices and payment records: as long as tax and accounting law requires.",
          "Your account until you delete it. You can delete it yourself under My account → Settings; order records we must keep by law are kept without your account.",
        ],
      },
      {
        id: "your-rights",
        heading: "Your rights and grievances",
        body: [
          "You can ask us for a copy of what we hold, ask us to correct it, or ask us to delete it, subject to our legal obligation to retain transaction records.",
          `Write to ${SITE.email} and we respond within 30 days.`,
        ],
      },
      {
        id: "cars",
        heading: "Buying or selling a car with us",
        body: [
          "If you buy or sell a car with us we also collect the vehicle's registration number, make, model, variant, year and kilometres, to value the car and complete the transfer.",
          "We arrange finance only where you ask for it, and share your details with lending partners only when you ask us to check finance eligibility.",
        ],
      },
    ],
  },
  {
    slug: "terms",
    title: "TERMS OF SERVICE",
    eyebrow: "Legal",
    metaDescription: "The terms for buying from Riderzpro: online orders, workshop bookings and vehicle transactions.",
    intro: `These terms govern purchases from this website, workshop bookings and vehicle transactions. The seller is ${COMPANY} It owns the Riderzpro trademark.`,
    sections: [
      {
        id: "orders-and-prices",
        heading: "Orders, prices and estimates",
        body: [
          "Prices shown online include GST unless stated otherwise. An order is confirmed once its online payment goes through. Build configurator totals are estimates: they become binding only in a written quote issued after a fitment check.",
          "We honour a written quote for 15 days. Where a part price moves because of an import duty or exchange rate change, we tell you before proceeding and you may cancel free of charge.",
        ],
      },
      {
        id: "delivery-returns",
        heading: "Delivery, returns, cancellations and warranty",
        body: [
          "Delivery, returns and refunds, cancellations and warranty are set out on the Shipping, Returns and Warranty pages, which form part of these terms.",
        ],
      },
      {
        id: "workshop-bookings",
        heading: "Workshop bookings",
        body: [
          "Bookings can be rescheduled free of charge up to 24 hours before the slot. Builds require a 40% deposit to reserve parts; the balance is due at handover.",
          "We photograph every vehicle on arrival. Vehicles left more than 14 days after completion attract storage charges, notified in advance.",
        ],
      },
      {
        id: "modifications-and-the-law",
        heading: "Modifications and the law",
        body: [
          "All work is carried out in line with the Central Motor Vehicles Rules. We do not remove emissions equipment, and we will not carry out modifications that cannot be made road-legal.",
          "Where a modification requires RTO endorsement, insurer notification or re-certification, we tell you in writing before starting. Compliance with those requirements remains the owner's responsibility.",
        ],
      },
      {
        id: "liability",
        heading: "Liability",
        body: [
          "Our liability for any claim is limited to the amount you paid for the product or service in question. Nothing in these terms limits liability that cannot be limited under Indian law.",
        ],
      },
      {
        id: "governing-law",
        heading: "Governing law",
        body: [
          "These terms are governed by the laws of India. Disputes are subject to the exclusive jurisdiction of the courts of Bengaluru, Karnataka.",
        ],
      },
      {
        id: "vehicle-sales",
        heading: "Buying or selling a car with us",
        body: [
          "Cars are sold with the inspection report shared in advance. Riderzpro Certified cars carry a 5-day / 300 km return window from delivery.",
          "Payment for a car we buy from you is released before the RC transfer application is filed. We settle any outstanding loan directly with the lender.",
        ],
      },
    ],
  },
];

export function findPolicy(list: Policy[], slug: string): Policy | undefined {
  return list.find((p) => p.slug === slug);
}
