/**
 * Captcha-solving credits: the arithmetic, with no database in sight.
 *
 * Every amount here is an integer number of MICRO-DOLLARS. One solve step costs
 * roughly $0.0015, which is zero when rounded to cents, and floating point
 * drifts in a ledger that will eventually be reconciled against real invoices.
 * Integers of 1e-6 dollars represent the smallest real charge exactly and still
 * fit a JS safe integer for any balance anyone will ever hold.
 */

export const MICROS_PER_DOLLAR = 1_000_000;

/** What each plan grants when a key is redeemed. */
export const PLAN_CREDITS_MICROS = {
    '30_day': 10 * MICROS_PER_DOLLAR,
    '1_month': 10 * MICROS_PER_DOLLAR,
    '90_day': 40 * MICROS_PER_DOLLAR,
    '3_month': 40 * MICROS_PER_DOLLAR,
    lifetime: 100 * MICROS_PER_DOLLAR,
};

/** Solving is billed at this multiple of what the model actually cost us. */
export const CREDIT_MARKUP = 2;

export function dollarsToMicros(dollars) {
    const n = Number(dollars);
    if (!Number.isFinite(n)) return 0;
    return Math.round(n * MICROS_PER_DOLLAR);
}

export function microsToDollars(micros) {
    return (Number(micros) || 0) / MICROS_PER_DOLLAR;
}

/** "$1.23" for a UI. Always clamped — see displayBalanceMicros. */
export function formatMicros(micros) {
    return `$${(Math.max(0, Number(micros) || 0) / MICROS_PER_DOLLAR).toFixed(2)}`;
}

/**
 * How much credit a key hands over.
 *
 * `creditsMicros` on the key OVERRIDES the plan default, which is what makes a
 * gift key possible: a full 30-day plan carrying only $2 of solving credit.
 * `null`/`undefined` means "use the plan default"; an explicit `0` means "grant
 * nothing at all", and the two must not collapse into each other.
 */
export function creditsForKey(key) {
    if (!key) return 0;
    const override = key.creditsMicros;
    if (override !== null && override !== undefined) {
        const n = Number(override);
        return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
    }
    return PLAN_CREDITS_MICROS[key.plan] ?? 0;
}

/**
 * What a solve costs the user, given what it cost us.
 *
 * Charge if and only if the model actually billed us: a policy refusal from the
 * model still costs money upstream and so is still charged, while a gateway
 * timeout that returns no usage is free because we were not charged either.
 */
export function chargeForUpstream(upstreamCostMicros) {
    const n = Number(upstreamCostMicros);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.round(n * CREDIT_MARKUP);
}

/**
 * May this account start one more solve step?
 *
 * Strictly greater than zero, deliberately. Authorization happens before the
 * true cost is known, so the last affordable step is allowed to overdraw by a
 * fraction of a cent; the NEXT call sees a non-positive balance and is refused.
 * Exactly one step runs past zero, and never two.
 */
export function canAffordStep(balanceMicros) {
    return (Number(balanceMicros) || 0) > 0;
}

/**
 * What the user is shown. Never negative.
 *
 * The stored balance keeps the true figure — including the small overdraft from
 * that last step — because accounting needs it. Showing someone "-$0.004" just
 * invites a support ticket about a rounding bug instead of a top-up.
 */
export function displayBalanceMicros(balanceMicros) {
    return Math.max(0, Number(balanceMicros) || 0);
}

export const CREDITS_PER_DOLLAR = 100;
export const MICROS_PER_CREDIT = MICROS_PER_DOLLAR / CREDITS_PER_DOLLAR; // 10_000
export const MINING_PAYOUT_RATE = 0.8;
export const DAY_PRICE_MICROS = 80 * MICROS_PER_CREDIT; // 800_000

export function creditsToMicros(credits) {
    const n = Number(credits);
    return Number.isFinite(n) ? Math.round(n * MICROS_PER_CREDIT) : 0;
}

export function microsToCredits(micros) {
    return (Number(micros) || 0) / MICROS_PER_CREDIT;
}

/** "80 credits" / "1 credit". Clamped to >= 0 for display. */
export function formatCredits(micros) {
    const n = Math.max(0, Math.round(microsToCredits(micros)));
    return `${n} credit${n === 1 ? '' : 's'}`;
}

function subActiveMicros(credits, now) {
    const exp = credits?.subscriptionCreditsExpireAt
        ? new Date(credits.subscriptionCreditsExpireAt) : null;
    if (!exp || exp <= now) return 0;
    return Number(credits?.subscriptionMicros) || 0;
}

/** Live balance: permanent + unexpired subscription. */
export function effectiveBalanceMicros(credits, now = new Date()) {
    return (Number(credits?.permanentMicros) || 0) + subActiveMicros(credits, now);
}

/**
 * Pure spend planner. Subscription bucket first (only if unexpired), remainder
 * from permanent; permanent may go negative (the last authorized step). An
 * expired subscription bucket is treated as 0 AND cleared in `next`.
 */
export function splitSpend(credits, amountMicros, now = new Date()) {
    const amount = Math.max(0, Math.round(Number(amountMicros) || 0));
    const permanent = Number(credits?.permanentMicros) || 0;
    const subActive = subActiveMicros(credits, now);
    const expired = (Number(credits?.subscriptionMicros) || 0) > 0 && subActive === 0;

    const fromSubMicros = Math.min(subActive, amount);
    const fromPermanentMicros = amount - fromSubMicros;

    const nextSub = subActive - fromSubMicros; // 0 when it was expired
    const next = {
        permanentMicros: permanent - fromPermanentMicros,
        subscriptionMicros: expired ? 0 : nextSub,
        subscriptionCreditsExpireAt:
            (expired || nextSub === 0) ? null : credits.subscriptionCreditsExpireAt,
    };
    return {
        fromSubMicros, fromPermanentMicros, next,
        effectiveAfterMicros: Math.max(0, next.permanentMicros + (expired ? 0 : nextSub)),
    };
}
