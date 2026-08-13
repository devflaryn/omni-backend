export class LicenseKeyError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.name = 'LicenseKeyError';
        this.statusCode = statusCode;
    }
}

function addMonths(date, months) {
    // Clamp to the target month's last day instead of letting setMonth()
    // overflow (e.g. Jan 31 + 1 month must land on Feb 28, not Mar 3).
    const originalDay = date.getDate();
    const result = new Date(date.getTime());
    result.setDate(1);
    result.setMonth(result.getMonth() + months);
    const daysInTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
    result.setDate(Math.min(originalDay, daysInTargetMonth));
    return result;
}

function addDays(date, days) {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

// The plans keys are actually sold as. `30_day`/`90_day` are the current ones —
// a fixed number of days is what a buyer is told they get, and it avoids the
// "is February a month?" question entirely. `1_month`/`3_month` predate them and
// are still honoured (calendar-month arithmetic) so keys already in circulation
// keep redeeming exactly as they did.
const PLAN_DAYS = { '30_day': 30, '90_day': 90 };
const PLAN_MONTHS = { '1_month': 1, '3_month': 3 };

export const VALID_PLANS = ['30_day', '90_day', 'lifetime', '1_month', '3_month'];

// What a plan is called in the UI. Two plan names can share a label because
// they describe the same product; only the arithmetic differs.
export const PLAN_LABELS = {
    '30_day': '30 days',
    '90_day': '90 days',
    '1_month': '30 days',
    '3_month': '90 days',
    lifetime: 'Lifetime',
};

/**
 * Pure function: given a user's current subscription and the plan on a key
 * being redeemed, returns the new subscription object. Throws
 * LicenseKeyError (409) if the redemption would downgrade an active
 * lifetime plan.
 */
export function computeSubscriptionAfterRedeem(currentSubscription, keyPlan, now = new Date()) {
    const currentPlan = currentSubscription?.plan ?? null;
    const currentExpiresAt = currentSubscription?.expiresAt
        ? new Date(currentSubscription.expiresAt)
        : null;

    if (currentPlan === 'lifetime' && keyPlan !== 'lifetime') {
        throw new LicenseKeyError(
            'This account already has a lifetime plan; a time-boxed key would downgrade it.',
            409
        );
    }

    if (keyPlan === 'lifetime') {
        return { plan: 'lifetime', expiresAt: null };
    }

    // Stack onto whatever time is left, so redeeming early never burns days.
    const base = (currentExpiresAt && currentExpiresAt > now) ? currentExpiresAt : now;

    const days = PLAN_DAYS[keyPlan];
    if (days) return { plan: keyPlan, expiresAt: addDays(base, days) };

    const months = PLAN_MONTHS[keyPlan];
    if (months) return { plan: keyPlan, expiresAt: addMonths(base, months) };

    throw new LicenseKeyError(`Unknown plan "${keyPlan}"`, 400);
}

/**
 * Is this subscription good right now? The single source of truth for the
 * paywall — `expiresAt` in the past means expired, `lifetime` never does, and
 * no plan at all means the account was never activated.
 */
export function isSubscriptionActive(subscription, now = new Date()) {
    const plan = subscription?.plan ?? null;
    if (!plan) return false;
    if (plan === 'lifetime') return true;
    const expiresAt = subscription?.expiresAt ? new Date(subscription.expiresAt) : null;
    return !!expiresAt && expiresAt > now;
}

/** Whole days left, or null for lifetime/never-activated. */
export function daysRemaining(subscription, now = new Date()) {
    if (!subscription?.plan || subscription.plan === 'lifetime') return null;
    if (!subscription.expiresAt) return null;
    const ms = new Date(subscription.expiresAt).getTime() - now.getTime();
    return ms <= 0 ? 0 : Math.ceil(ms / (24 * 60 * 60 * 1000));
}
