import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';
import CreditTransaction from '../src/models/creditTransaction.model.js';
import { grantCredits, spendCredits } from '../src/services/credits.service.js';

// Top-level await (ESM): connect once before any test() registers, so the
// availability check actually finishes before the tests below decide whether
// to run. A `before()` hook does NOT help here — node:test evaluates a test's
// `skip` option synchronously at registration time, before any async
// `before()` has had a chance to run, so `{ skip: !dbOk }` would always see
// the pre-hook value of `dbOk` and skip unconditionally even with a live DB.
let dbOk = false;
try {
    await connectToDatabase();
    dbOk = true;
} catch {
    dbOk = false;
}

async function mkUser() {
    return User.create({
        email: `t${Date.now()}${Math.random()}@x.io`,
        username: `u${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        password: 'x'.repeat(20),
    });
}

test('grant to permanent, spend crosses buckets subscription-first', async (t) => {
    if (!dbOk) { t.skip('no db'); return; }
    const u = await mkUser();
    await grantCredits(u._id, 500_000, { bucket: 'permanent', kind: 'mining', reason: 'm' });
    const exp = new Date(Date.now() + 86_400_000);
    await grantCredits(u._id, 300_000, { bucket: 'subscription', kind: 'grant', reason: 'g', expiresAt: exp });

    const { chargedMicros, balanceMicros } = await spendCredits(u._id, 400_000, { kind: 'spend', reason: 's' });
    assert.equal(chargedMicros, 400_000);
    assert.equal(balanceMicros, 400_000);

    const after = await User.findById(u._id).select('credits');
    assert.equal(after.credits.subscriptionMicros, 0);
    assert.equal(after.credits.permanentMicros, 400_000);

    const rows = await CreditTransaction.find({ user: u._id }).lean();
    // 2 grants + 2 spend rows (one per bucket touched)
    assert.equal(rows.filter(r => r.kind === 'spend').length, 2);
    await User.deleteOne({ _id: u._id });
    await CreditTransaction.deleteMany({ user: u._id });
});

after(async () => {
    if (dbOk) await mongoose.disconnect();
});
