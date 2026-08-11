import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSubscriptionAfterRedeem, LicenseKeyError } from '../src/utils/applyLicenseKey.js';

describe('computeSubscriptionAfterRedeem', () => {
    const now = new Date('2026-08-11T00:00:00Z');

    it('starts a fresh 1_month subscription from now', () => {
        const result = computeSubscriptionAfterRedeem({ plan: null, expiresAt: null }, '1_month', now);
        assert.equal(result.plan, '1_month');
        assert.equal(result.expiresAt.toISOString(), '2026-09-11T00:00:00.000Z');
    });

    it('stacks a 3_month key on top of remaining time', () => {
        const current = { plan: '1_month', expiresAt: new Date('2026-08-21T00:00:00Z') }; // 10 days left
        const result = computeSubscriptionAfterRedeem(current, '3_month', now);
        assert.equal(result.plan, '3_month');
        assert.equal(result.expiresAt.toISOString(), '2026-11-21T00:00:00.000Z');
    });

    it('resets from now when the current subscription already expired', () => {
        const current = { plan: '1_month', expiresAt: new Date('2026-01-01T00:00:00Z') };
        const result = computeSubscriptionAfterRedeem(current, '1_month', now);
        assert.equal(result.expiresAt.toISOString(), '2026-09-11T00:00:00.000Z');
    });

    it('sets a lifetime plan with a null expiresAt', () => {
        const current = { plan: '1_month', expiresAt: new Date('2026-08-21T00:00:00Z') };
        const result = computeSubscriptionAfterRedeem(current, 'lifetime', now);
        assert.deepEqual(result, { plan: 'lifetime', expiresAt: null });
    });

    it('rejects a time-boxed key when already on lifetime', () => {
        assert.throws(
            () => computeSubscriptionAfterRedeem({ plan: 'lifetime', expiresAt: null }, '1_month', now),
            (err) => err instanceof LicenseKeyError && err.statusCode === 409
        );
    });

    it('allows redeeming another lifetime key while already lifetime (no-op)', () => {
        const result = computeSubscriptionAfterRedeem({ plan: 'lifetime', expiresAt: null }, 'lifetime', now);
        assert.deepEqual(result, { plan: 'lifetime', expiresAt: null });
    });

    it('clamps a month-end date to the target month\'s last day instead of overflowing', () => {
        // Jan 31 + 1 month must land on Feb 28 (2026 is not a leap year),
        // not overflow past February into March 3rd.
        const janEnd = new Date('2026-01-31T00:00:00Z');
        const result = computeSubscriptionAfterRedeem({ plan: null, expiresAt: null }, '1_month', janEnd);
        assert.equal(result.expiresAt.toISOString(), '2026-02-28T00:00:00.000Z');
    });
});
