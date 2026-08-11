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

const PLAN_MONTHS = { '1_month': 1, '3_month': 3 };

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

    const months = PLAN_MONTHS[keyPlan];
    if (!months) {
        throw new LicenseKeyError(`Unknown plan "${keyPlan}"`, 400);
    }

    const base = (currentExpiresAt && currentExpiresAt > now) ? currentExpiresAt : now;
    return { plan: keyPlan, expiresAt: addMonths(base, months) };
}
