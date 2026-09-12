import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';

import {
    MICROS_PER_DOLLAR,
    PLAN_CREDITS_MICROS,
    CREDIT_MARKUP,
    creditsForKey,
    chargeForUpstream,
    canAffordStep,
    displayBalanceMicros,
    dollarsToMicros,
    microsToDollars,
    formatMicros,
    CREDITS_PER_DOLLAR, DAY_PRICE_MICROS, MINING_PAYOUT_RATE,
    creditsToMicros, microsToCredits, formatCredits,
    effectiveBalanceMicros, splitSpend,
} from '../src/utils/credits.js';

const future = new Date(Date.now() + 86_400_000);
const past = new Date(Date.now() - 86_400_000);

describe('grants', () => {
    it('gives each plan the advertised amount', () => {
        assert.equal(creditsForKey({ plan: '30_day' }), 10 * MICROS_PER_DOLLAR);
        assert.equal(creditsForKey({ plan: '1_month' }), 10 * MICROS_PER_DOLLAR);
        assert.equal(creditsForKey({ plan: '90_day' }), 40 * MICROS_PER_DOLLAR);
        assert.equal(creditsForKey({ plan: '3_month' }), 40 * MICROS_PER_DOLLAR);
        assert.equal(creditsForKey({ plan: 'lifetime' }), 100 * MICROS_PER_DOLLAR);
    });

    it('lets a key override its plan default', () => {
        // The gift case: a full 30-day plan carrying only $2 of solving credit.
        const key = { plan: '30_day', creditsMicros: 2 * MICROS_PER_DOLLAR };
        assert.equal(creditsForKey(key), 2 * MICROS_PER_DOLLAR);
    });

    it('treats an explicit zero as "no credit", not as "use the default"', () => {
        // null and 0 must not collapse together: one means "unset", the other
        // means the buyer deliberately gets nothing.
        assert.equal(creditsForKey({ plan: 'lifetime', creditsMicros: 0 }), 0);
        assert.equal(creditsForKey({ plan: 'lifetime', creditsMicros: null }),
            100 * MICROS_PER_DOLLAR);
        assert.equal(creditsForKey({ plan: 'lifetime', creditsMicros: undefined }),
            100 * MICROS_PER_DOLLAR);
    });

    it('grants nothing for an unknown plan or a missing key', () => {
        assert.equal(creditsForKey({ plan: 'wat' }), 0);
        assert.equal(creditsForKey(null), 0);
    });

    it('ignores a nonsense override rather than trusting it', () => {
        assert.equal(creditsForKey({ plan: '30_day', creditsMicros: -5 }), 0);
        assert.equal(creditsForKey({ plan: '30_day', creditsMicros: 'lots' }), 0);
    });
});

describe('billing', () => {
    it('charges the markup on what the model cost us', () => {
        assert.equal(CREDIT_MARKUP, 2);
        assert.equal(chargeForUpstream(1500), 3000);
    });

    it('charges nothing when the model cost us nothing', () => {
        // A gateway timeout returns no usage; we were not billed, so neither is
        // the user. A policy refusal DOES report a cost and so is charged.
        assert.equal(chargeForUpstream(0), 0);
        assert.equal(chargeForUpstream(null), 0);
        assert.equal(chargeForUpstream(undefined), 0);
        assert.equal(chargeForUpstream(-10), 0);
        assert.equal(chargeForUpstream('nonsense'), 0);
    });

    it('always yields a whole number of micros', () => {
        assert.equal(chargeForUpstream(1.5), 3);
        assert.equal(chargeForUpstream(0.4), 1);
        assert.ok(Number.isInteger(chargeForUpstream(1533.7)));
    });

    it('bills a real solve at about a cent', () => {
        // Sanity anchor: one measured step cost $0.0015 upstream.
        const step = dollarsToMicros(0.0015);
        assert.equal(chargeForUpstream(step), 3000);        // $0.003 to the user
        assert.equal(microsToDollars(chargeForUpstream(step)), 0.003);
    });
});

describe('the overdraft rule', () => {
    it('allows a step while any credit remains', () => {
        assert.equal(canAffordStep(1), true);
        assert.equal(canAffordStep(10 * MICROS_PER_DOLLAR), true);
    });

    it('refuses once the balance is spent or negative', () => {
        // The last affordable step is allowed to overdraw, because the true
        // cost is unknown until after the model answers. The NEXT one is not:
        // exactly one step runs past zero, never two.
        assert.equal(canAffordStep(0), false);
        assert.equal(canAffordStep(-4000), false);
    });

    it('treats a missing balance as broke', () => {
        assert.equal(canAffordStep(null), false);
        assert.equal(canAffordStep(undefined), false);
    });
});

describe('what the user is shown', () => {
    it('never shows a negative balance', () => {
        // The ledger keeps the true figure; the UI clamps, because "-$0.004"
        // reads as a bug rather than as "time to top up".
        assert.equal(displayBalanceMicros(-4000), 0);
        assert.equal(formatMicros(-4000), '$0.00');
    });

    it('shows a real balance unchanged', () => {
        assert.equal(displayBalanceMicros(2_500_000), 2_500_000);
        assert.equal(formatMicros(2_500_000), '$2.50');
        assert.equal(formatMicros(10 * MICROS_PER_DOLLAR), '$10.00');
    });
});

describe('conversions', () => {
    it('round-trips dollars through micros', () => {
        assert.equal(dollarsToMicros(10), 10_000_000);
        assert.equal(microsToDollars(10_000_000), 10);
    });

    it('represents a sub-cent charge exactly, which cents cannot', () => {
        assert.equal(dollarsToMicros(0.0015), 1500);
        assert.equal(Math.round(0.0015 * 100), 0);   // the reason micros exist
    });

    it('survives garbage input', () => {
        assert.equal(dollarsToMicros(undefined), 0);
        assert.equal(dollarsToMicros('abc'), 0);
        assert.equal(microsToDollars(null), 0);
    });
});

test('unit constants', () => {
    assert.equal(CREDITS_PER_DOLLAR, 100);
    assert.equal(DAY_PRICE_MICROS, 800_000);
    assert.equal(MINING_PAYOUT_RATE, 0.8);
    assert.equal(creditsToMicros(80), 800_000);
    assert.equal(microsToCredits(800_000), 80);
    assert.equal(formatCredits(800_000), '80 credits');
    assert.equal(formatCredits(10_000), '1 credit');
});

test('effective balance ignores an expired subscription bucket', () => {
    const c = { permanentMicros: 500_000, subscriptionMicros: 300_000, subscriptionCreditsExpireAt: past };
    assert.equal(effectiveBalanceMicros(c), 500_000);
});

test('effective balance counts an unexpired subscription bucket', () => {
    const c = { permanentMicros: 500_000, subscriptionMicros: 300_000, subscriptionCreditsExpireAt: future };
    assert.equal(effectiveBalanceMicros(c), 800_000);
});

test('splitSpend takes from subscription first, then permanent', () => {
    const c = { permanentMicros: 500_000, subscriptionMicros: 300_000, subscriptionCreditsExpireAt: future };
    const r = splitSpend(c, 400_000);
    assert.equal(r.fromSubMicros, 300_000);
    assert.equal(r.fromPermanentMicros, 100_000);
    assert.equal(r.next.subscriptionMicros, 0);
    assert.equal(r.next.permanentMicros, 400_000);
    assert.equal(r.effectiveAfterMicros, 400_000);
});

test('splitSpend ignores + clears an expired subscription bucket', () => {
    const c = { permanentMicros: 500_000, subscriptionMicros: 300_000, subscriptionCreditsExpireAt: past };
    const r = splitSpend(c, 100_000);
    assert.equal(r.fromSubMicros, 0);
    assert.equal(r.fromPermanentMicros, 100_000);
    assert.equal(r.next.subscriptionMicros, 0);
    assert.equal(r.next.subscriptionCreditsExpireAt, null);
    assert.equal(r.next.permanentMicros, 400_000);
});

test('splitSpend overdraws permanent on the last step', () => {
    const c = { permanentMicros: 5_000, subscriptionMicros: 0, subscriptionCreditsExpireAt: null };
    const r = splitSpend(c, 30_000);
    assert.equal(r.next.permanentMicros, -25_000);
    assert.equal(r.effectiveAfterMicros, 0); // clamped view
});
