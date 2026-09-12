import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordAcceptedShare, flushPayouts, _getAccrual } from '../src/services/mining/accounting.js';

test('flush pays 80% of gross accepted-share value and drains what it paid for', async () => {
    _getAccrual().clear();
    recordAcceptedShare('u1', 'xmr', 1_000_000); // gross $0.10 = 100_000 micros
    const grants = [];
    const cfg = { valuation: { xmr: { usdPerDiff: 0.0000001 }, rvn: { usdPerDiff: 0 } } };
    const out = await flushPayouts({ cfg, grant: async (userId, micros) => { grants.push([userId, micros]); return micros; } });
    assert.equal(grants.length, 1);
    assert.equal(grants[0][0], 'u1');
    assert.equal(grants[0][1], 80_000); // 80% of 100_000
    assert.equal(out[0].grantedMicros, 80_000);
    // The entry is NOT deleted (a share recorded mid-grant must not be lost —
    // see the race test below); it is drained of exactly what was paid for.
    const a = _getAccrual().get('u1');
    assert.ok(a, 'entry stays in the accrual');
    assert.equal(a.diffByCoin.xmr, 0);
    assert.equal(a.leftoverMicros, 0);
});

test('flush does not lose difficulty recorded while a grant is in flight', async () => {
    _getAccrual().clear();
    const cfg = { valuation: { xmr: { usdPerDiff: 0.0000001 }, rvn: { usdPerDiff: 0 } } };
    recordAcceptedShare('u2', 'xmr', 1_000_000); // gross $0.10 -> pays 80_000

    // Simulate a share arriving from the proxy WHILE the grant is awaited —
    // the old implementation deleted the whole entry after the await and
    // would have wiped this out.
    const out1 = await flushPayouts({
        cfg,
        grant: async (userId, micros) => {
            recordAcceptedShare('u2', 'xmr', 500_000); // arrives mid-flush
            return micros;
        },
    });
    assert.equal(out1.length, 1);
    assert.equal(out1[0].grantedMicros, 80_000);

    const a = _getAccrual().get('u2');
    assert.ok(a, 'entry survives with the mid-flush share, not lost');
    assert.equal(a.diffByCoin.xmr, 500_000);

    // ...and it gets paid out on the next flush.
    const out2 = await flushPayouts({ cfg, grant: async (userId, micros) => micros });
    assert.equal(out2.length, 1);
    assert.equal(out2[0].grantedMicros, 40_000); // 80% of $0.05
});
