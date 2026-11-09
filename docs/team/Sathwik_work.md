# Sathwik: payments, refunds, GST invoices and commission

Updated 18 Oct 2026. All of this is **built and tested in code**; these items are what only you can
provide or decide. Secrets go only into the hosting dashboard or a password manager, never into chat,
email or git.

## Before launch (must do)

1. **Razorpay test keys** for staging: `RAZORPAY_KEY_ID` (`rzp_test_…`) and `RAZORPAY_KEY_SECRET`
   (Dashboard → Test mode → Account & Settings → API keys).
2. **Webhook**, once staging and then production have their address:
   - URL `https://<site>/api/payments/razorpay/webhook`
   - events `payment.captured`, `payment.failed`, `order.paid`, `refund.created`,
     `refund.processed`, `refund.failed`
   - the secret you choose goes in `RAZORPAY_WEBHOOK_SECRET`.
3. **Account:**
   - KYC approved (live payments need it)
   - payment capture set to **automatic**
   - payment methods on (UPI, cards, netbanking, wallets; EMI?)
   - settlement to the company current account.
4. **Live keys** at go-live (same names, production only).
5. **GST invoice details.** Confirm or correct the values used today (`src/lib/invoice/gst.ts`,
   `src/lib/data/site.ts`):
   - Legal name Motorbotz Automotive Pvt. Ltd.; GSTIN 29AAJCM4412Q1ZP (Karnataka); the registered
     office address to print (the Bengaluru address is used now).
   - HSN and GST rate per product category (today every item is HSN 8708 at 18%); send a sheet of
     category → HSN → rate.
   - Installation SAC 998714 at 18%; delivery SAC 996812 at 18% (or should delivery take the goods'
     rate?).
   - Invoice numbers `RZP/2026-27/00001`, restarting each financial year (April).
   - Signatory name and designation; signature or stamp image if needed; footer terms text.
6. **Accountant check** (one conversation covers all four):
   - TCS under GST section 52 and GSTR-8 for marketplace sales;
   - coupons shown as a discount on Riderzpro's invoice;
   - a shop special price as the seller's own discount;
   - no buyer GSTIN field (B2C only) and no credit notes yet.

## Decisions (today's behaviour in brackets)

- Refund approval and limits [any admin with the Finance, Manager or Owner role, up to the amount
  paid; delivery charge not suggested].
- Unpaid online orders hold stock for [30 minutes].
- Money that arrives after its order expired [kept, flagged on the order for a manual refund].
- Cancelling a paid order [doesn't refund by itself; the admin page offers the refund].
- Seller payouts [Riderzpro collects and pays sellers later; Razorpay Route not used].
- Cash on delivery [not offered; WhatsApp ordering and pay-online are].
- **Commission on shop-screen sales** [decided: none. Offline Store screen sales, paid on the screen
  or at the seller's counter, carry no commission; payouts and Reports show none for them].
- Who may create coupons [Owner, Manager, Catalogue roles].

## When done

Tell the developer. They switch staging to your test keys and run a full order, a failed payment and
a refund in test mode before go-live.
