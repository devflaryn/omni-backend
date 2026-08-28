# Captcha solving credits

Solving a captcha costs real money at OpenRouter. This gives every account a
metered balance, funds it from license keys, bills solving at a 2x markup, and
gives one admin a panel to adjust balances by hand.

## Money is integer micro-dollars

`$1 = 1_000_000` micros. One solve step costs about `$0.0015` — zero in cents,
so cents cannot represent it, and floats drift in a ledger that will be
reconciled against real invoices. Every stored amount is an integer.

`MICROS_PER_DOLLAR = 1_000_000`.

## Grants

| Plan | Default grant |
|---|---|
| `30_day`, `1_month` | $10 |
| `90_day`, `3_month` | $40 |
| `lifetime` | $100 |

A key may carry `creditsMicros`, which **overrides** the plan default — that is
how a `30_day` key can gift the executor with only $2 of credit. `null` means
"use the plan default"; `0` means "grant nothing", and the two are different.

Credits are granted when a key is redeemed, added to whatever balance exists.
They never expire on their own; an expired *subscription* blocks the app, but
the balance survives a renewal.

## Billing

`chargeMicros = round(upstreamCostMicros * 2)`.

**Charge if and only if OpenRouter reported a cost.** A policy refusal from the
model still bills, because Google still charged us for it. A gateway 504 that
returns no `usage` does not bill, because we were not charged either.

## Spending is one atomic update

Never read-then-write. A balance check followed by a separate decrement lets two
concurrent batches on one account both spend the last dollar.

```js
User.findOneAndUpdate(
  { _id, 'credits.balanceMicros': { $gt: 0 } },
  { $inc: { 'credits.balanceMicros': -amount } },
  { new: true })
```

`null` back means the balance was not positive, so the caller was refused.

## Overdraft, deliberately

Authorization happens **before** the true cost is known, so the rule is:

- authorize a step while the balance is **strictly greater than zero**
- let that final step overdraw — it may land a few cents negative
- the next authorization sees a non-positive balance and refuses

So exactly one step may run "for free" past zero. The stored balance keeps the
true negative figure for accounting; **every user-facing surface clamps to 0**,
because showing someone -$0.004 invites a support ticket about a rounding error
rather than a top-up.

## Running out falls back to a human

An insufficient balance is not an error. The solver answers
`{"action": "unsure", "reason": "insufficient_credits"}`, and the executor does
what it already does for any unsure answer: leaves the browser open so the
person solves the puzzle themselves. Account creation keeps working; it is only
slower. Nothing breaks at zero.

## Metering path

```
client ──user JWT──► captchaserver /v1/step
                          ├─► backend /internal/credits/authorize
                          │        (service secret + the user's JWT)
                          ├─► OpenRouter
                          └─► backend /internal/credits/charge
```

The **backend** verifies the JWT. The Python service never parses tokens, so
identity has exactly one authority. Service-to-service calls carry a shared
secret in `X-Service-Token`; a request missing it is rejected before any lookup.

## The ledger

`CreditTransaction` — one row per movement, each recording the balance it
produced:

```
user, deltaMicros, kind: grant|spend|admin|refund,
reason, balanceAfterMicros, meta{ solveId, model, upstreamCostMicros, licenseKey },
actor (the admin's id, for kind=admin), createdAt
```

The denormalised balance on `User` is what gets read; this collection is what
gets trusted when someone disputes it. Admin adjustments require a reason, so no
row is ever mysterious a month later.

## Admin

Guarded by the existing `adminOnly`. "A single admin" is satisfied by promoting
exactly one account with `scripts/promote-admin.js` — no new role machinery.

- `GET  /api/v1/admin/users?q=` — search users, with balances
- `POST /api/v1/admin/users/:id/credits` — `{ deltaMicros, reason }`, may be negative
- `GET  /api/v1/admin/users/:id/credits/transactions` — that user's ledger

Plus an admin page in `omni-backend/frontend`: find a user, read their balance
and history, add or remove credits with a required reason.

## Scope

Credits gate **captcha solving only**. The subscription still gates the app: an
expired plan blocks access no matter how much credit is left over.

## Testing

Follows the existing `node --test` suite. The pure parts — grant amounts,
markup arithmetic, the clamp, the authorize predicate — are unit-tested without
Mongo. The atomic spend is tested against the conditional-update contract, and
the internal endpoints are tested for rejecting a missing service secret.
