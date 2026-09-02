# Guest checkout — buy license keys without an account

Status: design approved, implementation started
Date: 2026-09-02

## Problem

Every pricing card links to `/sign-up`. There is no way to buy anything: no
payment integration, no promo codes and no email delivery exist anywhere in the
codebase. Keys can only be minted by an admin (`POST /api/v1/keys/generate`,
`authorize + adminOnly`).

Sign-up is already free and takes no key — a key *buys time on an account that
already exists*. So the purchase flow needs no accounts: sell a key, email it,
let the buyer redeem it whenever they sign up.

## Decisions

| Question | Decision |
|---|---|
| Pricing model | Keep existing USD plans; the reference screenshot is layout only |
| Email | Resend, send-only API key |
| Promo codes | Percentage off, admin-created, optional expiry + max redemptions |
| Key issuance | On payment *seen* (`InvoiceProcessing`); auto-revoke if never confirmed |
| Payments | BTCPay only (non-custodial), Bitcoin at launch |
| Price source | Shared pure-data module imported by both sides |
| Revocation | Cancels the subscription and claws back credits |

## Non-goals

- USDT / ETH / TON / SOL. BTCPay supports UTXO chains only and dropped Ethereum
  in 2023. Adding LTC/DOGE/DASH later is server config with **no code change** —
  one BTCPay invoice offers every enabled chain at once.
- A multi-provider payment abstraction. Explicitly rejected; BTCPay called directly.
- Admin-editable pricing. Promo codes cover discounting.
- Any change to sign-up, which is already free.

## Flow

1. Card CTA opens `CheckoutModal` with that plan preselected.
2. `POST /api/v1/checkout/quote` — live total as quantity/promo change.
3. `POST /api/v1/checkout` (no auth) creates an `Order` (`pending`) and a BTCPay
   invoice; returns `{ orderId, payUrl }`.
4. Buyer pays on BTCPay's hosted checkout.
5. BTCPay webhook drives everything after that.
6. `/checkout/:orderId` polls `GET /api/v1/checkout/:orderId/status`.

## Webhook state machine

| BTCPay event | Action |
|---|---|
| `InvoiceProcessing` | Mint N keys, email them, order -> `paid` |
| `InvoiceSettled` | order -> `settled` |
| `InvoiceExpired` / `InvoiceInvalid` | If keys minted, revoke them; order -> `failed` |

BTCPay retries webhooks, so every transition is guarded by the order's current
status plus a unique index on `invoiceId`. Handlers are idempotent.

## Data model

**`Order`** (new): `email`, `planId`, `quantity`, `unitPriceUsdCents`,
`subtotalUsdCents`, `promoCode`, `discountPct`, `totalUsdCents`, `provider`,
`invoiceId` (unique), `status` (`pending|paid|settled|expired|failed`),
`keys[]`, `emailSentAt`, timestamps.

**`PromoCode`** (new): `code` (unique, uppercased), `percentOff` (1-100),
`expiresAt`, `maxRedemptions`, `redemptions`, `active`. Counter increments only
on successful payment, never on quote.

**`LicenseKey`** (modified): add `order`, `issuedToEmail`, `subscriptionBefore`,
`creditsGrantedMicros` — all nullable. `createdBy` is already nullable, so
guest-minted keys need no schema surgery.

**`CreditTransaction`** (modified): add `revocation` to the `kind` enum
(currently `grant | spend | admin | refund`).

## Pricing authority

`shared/plans.js` — a pure-data ESM module imported by backend and frontend:

    export const PLANS = {
      month:    { priceUsdCents: 1999, licensePlan: '30_day' },
      quarter:  { priceUsdCents: 4999, licensePlan: '90_day' },
      lifetime: { priceUsdCents: 7999, licensePlan: 'lifetime' },
    };

MUST stay dependency-free — the frontend bundles it, so a Node-only import
breaks the Vite build. Vite needs `server.fs.allow` widened to reach outside
`frontend/`.

Credit grants are NOT duplicated here: `creditsForKey()` already derives them
from the licence plan via `PLAN_CREDITS_MICROS`.

The client sends only `{ planId, quantity, email, promoCode }`. The server
computes every charged figure; prices are never read from the request body.

## Revocation cancels the subscription

New shared `revokeKey(key, reason)` used by both the payment-failure path and a
new admin action. One Mongo transaction, mirroring `redeemKey`:

- **Credits**: subtract `creditsGrantedMicros`, write a compensating
  `CreditTransaction`. `user.credits.balanceMicros` is already documented as
  allowed to go negative with every surface clamping to 0, so clawing back spent
  credit is an already-supported state.
- **Subscription**: subtract that key's own duration from `expiresAt` (30 / 90
  days) rather than restoring a snapshot outright, so it composes correctly when
  other keys were stacked since. For `lifetime`, restore `subscriptionBefore`. A
  resulting past `expiresAt` needs no special handling — `isSubscriptionActive()`
  already treats it as expired.
- Set `status: 'revoked'`.

`'revoked'` exists in the enum today but nothing ever sets it; there is no revoke
path at all. This is new code, and yields an admin revoke action as a by-product.

## Files

New: `shared/plans.js`, `models/order.model.js`, `models/promoCode.model.js`,
`services/btcpay.js`, `services/email.js`, `services/revokeKey.js`,
`controllers/checkout.controller.js`, `routes/checkout.routes.js`, admin promo
CRUD, `components/CheckoutModal.jsx`, `components/checkout-modal.css`,
`pages/CheckoutStatus.jsx`.

Modified: `Home.jsx`, `App.jsx`, `server.js`, `licenseKey.model.js`,
`creditTransaction.model.js`, `vite.config.js`.

## Security

- Webhook HMAC verified against `BTCPAY_WEBHOOK_SECRET` before any parsing.
- Arcjet already covers `/api`; checkout creation is rate-limited.
- Keys are **emailed only**, never returned by the status endpoint, so a leaked
  `orderId` URL leaks nothing. Status shows a masked address plus a
  rate-limited resend.

## Configuration

    RESEND_API_KEY=...              # send-only key
    RESEND_FROM=keys@omniexec.net   # needs omniexec.net Verified in Resend
    BTCPAY_URL=http://127.0.0.1:23000
    BTCPAY_STORE_ID=GSz78H1uA4jT4oKL3Y2ovggJaXZY1vKur3ii9SURL9Hr
    BTCPAY_API_KEY=...
    BTCPAY_WEBHOOK_SECRET=...       # generated when the webhook is created

**Webhook reachability**: BTCPay runs in Docker, so `127.0.0.1` inside the
container is the container itself, not the host. The callback must target the
Docker bridge gateway (e.g. `http://172.17.0.1:8080/...`); the app listens on
`0.0.0.0:8080`. Read the real gateway of the `generated_default` network at
implementation time rather than assuming.

## Testing

Unit: promo/pricing arithmetic, HMAC verification, state-machine transitions
including duplicate webhooks and revoke-after-redeem, and a test asserting
`shared/plans.js` matches the display strings in `Home.jsx`.

Integration: checkout -> mocked BTCPay -> webhook -> keys minted -> Resend called.

Run tests **on the server**: `npm test`'s glob matches nothing under Git Bash on
the Windows dev box, and the suite flakes on Arcjet 429s, so zero failures is not
the baseline. Compare failure *names*, not counts.

## Verified during design

- API key works; all three permissions confirmed. `/stores/{id}` returns 403
  because `canviewstoresettings` was deliberately withheld — correct least privilege.
- Kraken rate source live: `kraken(BTC_USD) = 76415`.
- Wallet is attached: a test invoice failed with `BTC-CHAIN: Payment method
  unavailable (Full node not available)` — the method exists, the node is in IBD.

## Open risks

- **Deliverability**: `omniexec.net` must show Verified in Resend or every key
  email fails. The send-only key cannot query domain status via API.
- **Sync gate**: no invoice can be created, and no end-to-end test can run, until
  bitcoind finishes IBD (11.9% at time of writing).
- A buyer who redeems a key and then has payment fail will have their
  subscription reduced and credits clawed back. Intended, but user-visible.
