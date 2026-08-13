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
        const { email, token, code } = await registerUser(app, { prefix: 'harness' });

        const users = await request(app)
            .get('/api/v1/users')
            .set('Authorization', `Bearer ${token}`);
        assert.equal(users.status, 200);
        assert.ok(users.body.data.some((u) => u.email === email));
        // The password hash must not ride along in a user listing.
        assert.ok(users.body.data.every((u) => u.password === undefined));

        await User.deleteOne({ email });
        await LicenseKey.deleteOne({ code });
    });

    it('refuses to register without a valid license key', async () => {
        const noKey = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email: `harness-nokey-${Date.now()}@omni.test`, password: 'hunter22' });
        assert.equal(noKey.status, 400);

        const badKey = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email: `harness-badkey-${Date.now()}@omni.test`, password: 'hunter22', key: 'OMNI-XXXX-XXXX-XXXX' });
        assert.equal(badKey.status, 404);
    });

    it('will not let one key create two accounts', async () => {
        const first = await registerUser(app, { prefix: 'harness-reuse' });
        const second = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email: `harness-reuse2-${Date.now()}@omni.test`, password: 'hunter22', key: first.code });
        assert.equal(second.status, 409);

        await User.deleteOne({ email: first.email });
        await LicenseKey.deleteOne({ code: first.code });
    });
});
