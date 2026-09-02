/*
 * The single source of truth for what a plan COSTS and what licence it mints.
 *
 * Imported by BOTH the backend (to price an order server-side) and the frontend
 * (to render the checkout modal), which is the whole point: a price that lives
 * in two places drifts, and the drift is only ever discovered by a customer
 * being charged the wrong amount.
 *
 * THIS FILE MUST STAY DEPENDENCY-FREE. Vite bundles it into the browser build,
 * so a single Node-only import here (fs, path, a model, anything) breaks the
 * frontend build. Data only.
 *
 * Marketing copy — plan names, feature bullets, CTA labels — deliberately does
 * NOT live here. That belongs in Home.jsx; only the money-relevant facts are
 * shared.
 *
 * `licensePlan` is the value that ends up on the minted LicenseKey, so it must
 * be one of applyLicenseKey.js's VALID_PLANS. The credit grant is NOT repeated
 * here: creditsForKey() already derives it from the licence plan via
 * PLAN_CREDITS_MICROS, and duplicating it would recreate the exact drift this
 * file exists to prevent.
 */

export const PLANS = {
    month: {
        priceUsdCents: 1999,
        licensePlan: '30_day',
    },
    quarter: {
        priceUsdCents: 4999,
        licensePlan: '90_day',
    },
    lifetime: {
        priceUsdCents: 7999,
        licensePlan: 'lifetime',
    },
};

/*
 * The "free" tier on the landing page is not in PLANS on purpose: it is not
 * purchasable, it mints no key, and sign-up is already free without one. Asking
 * to buy it is a 400, not a $0 order.
 */
export const PURCHASABLE_PLAN_IDS = Object.keys(PLANS);

export function isPurchasablePlan(planId) {
    return Object.prototype.hasOwnProperty.call(PLANS, planId);
}

/** Most keys a single order may carry. Guards both the UI stepper and the API. */
export const MAX_QUANTITY = 20;

/**
 * Price an order. Pure, integer-only arithmetic — money never touches a float.
 *
 * `percentOff` is applied to the SUBTOTAL rather than the unit price, so
 * rounding happens exactly once instead of once per key. Buying 3 keys with a
 * 33% code must not cost a cent more than one third off the whole basket.
 */
export function priceOrder({ planId, quantity, percentOff = 0 }) {
    const plan = PLANS[planId];
    if (!plan) throw new Error(`Unknown plan "${planId}"`);

    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
        throw new Error(`Quantity must be a whole number between 1 and ${MAX_QUANTITY}`);
    }

    const pct = Number(percentOff) || 0;
    if (pct < 0 || pct > 100) throw new Error('percentOff must be between 0 and 100');

    const unitPriceUsdCents = plan.priceUsdCents;
    const subtotalUsdCents = unitPriceUsdCents * qty;
    // Round the DISCOUNT, not the total, so the customer never loses a cent to
    // rounding: floor() here can only ever make the discount smaller by <1c.
    const discountUsdCents = Math.floor((subtotalUsdCents * pct) / 100);
    const totalUsdCents = subtotalUsdCents - discountUsdCents;

    return {
        planId,
        quantity: qty,
        licensePlan: plan.licensePlan,
        unitPriceUsdCents,
        subtotalUsdCents,
        percentOff: pct,
        discountUsdCents,
        totalUsdCents,
    };
}

/** Cents -> the string BTCPay and the UI both want. 1999 -> "19.99". */
export function formatUsd(cents) {
    return (cents / 100).toFixed(2);
}
