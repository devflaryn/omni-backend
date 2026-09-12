import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordAcceptedShare, flushPayouts, _getAccrual } from '../src/services/mining/accounting.js';

test('flush pays 80% of gross accepted-share value and drains accrual', async () => {
    _getAccrual().clear();
    recordAcceptedShare('u1', 'xmr', 1_000_000); // gross $0.10 = 100_000 micros
    const grants = [];
    const cfg = { valuation: { xmr: { usdPerDiff: 0.0000001 }, rvn: { usdPerDiff: 0 } } };
    const out = await flushPayouts({ cfg, grant: async (userId, micros) => { grants.push([userId, micros]); return micros; } });
    assert.equal(grants.length, 1);
    assert.equal(grants[0][0], 'u1');
    assert.equal(grants[0][1], 80_000); // 80% of 100_000
    assert.equal(out[0].grantedMicros, 80_000);
    assert.equal(_getAccrual().size, 0); // drained
});
