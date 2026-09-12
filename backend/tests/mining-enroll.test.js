import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import MinerSession from '../src/models/minerSession.model.js';
import { registerUser } from './helpers/signup.js';

// Top-level await (ESM): connect once before any test() registers — see
// credits-service.test.js for why a `before()` hook + `{ skip }` option does
// NOT work here (node:test evaluates `skip` synchronously at registration).
let dbOk = false;
try {
    await connectToDatabase();
    dbOk = true;
} catch {
    dbOk = false;
}

test('enroll issues a token that resolves to the user', async (t) => {
    if (!dbOk) { t.skip('no db'); return; }
    const { token, user } = await registerUser(app);
    const userId = user._id;
    const res = await request(app).post('/api/v1/mining/enroll')
        .set('Authorization', `Bearer ${token}`).send({});
    assert.equal(res.status, 200);
    assert.ok(res.body.data.minerToken.length >= 32);
    const resolved = await MinerSession.resolveToken(res.body.data.minerToken);
    assert.equal(resolved, String(userId));
    await MinerSession.deleteMany({ user: userId });
});

after(async () => {
    if (dbOk) await mongoose.disconnect();
});
