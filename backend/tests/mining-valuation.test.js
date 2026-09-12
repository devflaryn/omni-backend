import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareValueMicros } from '../src/services/mining/valuation.js';

const cfg = { valuation: { xmr: { usdPerDiff: 0.0000001 }, rvn: { usdPerDiff: 0.00000005 } } };

test('gross share value scales with difficulty and coin rate', () => {
    // 1e6 diff * 1e-7 usd/diff = $0.10 => 100_000 micros
    assert.equal(shareValueMicros('xmr', 1_000_000, cfg), 100_000);
    assert.equal(shareValueMicros('rvn', 1_000_000, cfg), 50_000);
    assert.equal(shareValueMicros('xmr', 0, cfg), 0);
    assert.equal(shareValueMicros('doge', 1, cfg), 0); // unknown coin
});
