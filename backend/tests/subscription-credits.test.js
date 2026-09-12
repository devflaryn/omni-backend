import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';
import { registerUser } from './helpers/signup.js';

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

test('80 credits buys one day; short balance is 402', async (t) => {
    if (!dbOk) { t.skip('no db'); return; }

    const { token, user } = await registerUser(app);
    const userId = user.id || user._id;
    // Fund 80 credits into the permanent bucket directly.
    await User.updateOne({ _id: userId }, { $set: { 'credits.permanentMicros': 800_000 } });

    const ok = await request(app).post('/api/v1/subscription/redeem-credits')
        .set('Authorization', `Bearer ${token}`).send({});
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.subscription.active, true);
    assert.equal(ok.body.data.credits.credits, 0);

    const short = await request(app).post('/api/v1/subscription/redeem-credits')
        .set('Authorization', `Bearer ${token}`).send({});
    assert.equal(short.status, 402);

    await User.deleteOne({ _id: userId });
});

after(async () => {
    if (dbOk) await mongoose.disconnect();
});
