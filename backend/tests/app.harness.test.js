import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';
import LicenseKey from '../src/models/licenseKey.model.js';
import { registerUser } from './helpers/signup.js';

// These HTTP-level tests rely on Arcjet's detectBot({ mode: "LIVE" }) not
// blocking loopback/local-network requests. If that ever changes, requests
// here would need the browser-like headers documented in scripts/smoke-test.sh.
describe('app smoke test', () => {
    before(async () => {
        await connectToDatabase();
    });

    after(async () => {
        await mongoose.connection.close();
    });

    it('signs a new user up and lists it back', async () => {
        const { email, token, codes } = await registerUser(app, { prefix: 'harness' });

        const users = await request(app)
            .get('/api/v1/users')
            .set('Authorization', `Bearer ${token}`);
        assert.equal(users.status, 200);
        assert.ok(users.body.data.some((u) => u.email === email));
        // The password hash must not ride along in a user listing.
        assert.ok(users.body.data.every((u) => u.password === undefined));

        await User.deleteOne({ email });
        await LicenseKey.deleteMany({ code: { $in: codes } });
    });

    // Two tests stood here asserting the old contract: that sign-up refused a
    // missing or invalid key, and that one key could not create two accounts.
    // Sign-up takes no key at all now, so neither statement is meaningful — the
    // "one key, one redemption" invariant they were really protecting moved to
    // redeem, and keys.test.js asserts it there.
    it('registers with no license key at all, on the free tier', async () => {
        const email = `harness-free-${Date.now()}@omni.test`;
        const res = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email, username: `harnessfree${Date.now().toString(36)}`, password: 'hunter22' });

        assert.equal(res.status, 201);
        assert.equal(res.body.data.subscription.tier, 'free');

        await User.deleteOne({ email });
    });
});
