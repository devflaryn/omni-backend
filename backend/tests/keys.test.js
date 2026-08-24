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
describe('keys API', () => {
    let adminToken, adminEmail, userToken, userEmail;
    const createdCodes = [];

    before(async () => {
        await connectToDatabase();

        const admin = await registerUser(app, { prefix: 'keys-admin' });
        adminEmail = admin.email;
        adminToken = admin.token;
        createdCodes.push(...admin.codes);
        await User.updateOne({ email: adminEmail }, { role: 'admin' });

        // A plain user, deliberately NOT on lifetime: the redeem tests below
        // stack a time-boxed key on top, which lifetime would refuse (409).
        // `plan` makes the helper redeem a key AFTER sign-up, which is the only
        // route to a plan now that sign-up itself is free.
        const user = await registerUser(app, { prefix: 'keys-user', plan: '30_day' });
        userEmail = user.email;
        userToken = user.token;
        createdCodes.push(...user.codes);
    });

    after(async () => {
        await User.deleteMany({ email: { $in: [adminEmail, userEmail] } });
        await LicenseKey.deleteMany({ code: { $in: createdCodes } });
        await mongoose.connection.close();
    });

    it('rejects key generation from a non-admin', async () => {
        const res = await request(app)
            .post('/api/v1/keys/generate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ plan: '1_month', count: 1 });
        assert.equal(res.status, 403);
    });

    it('lets an admin generate keys and a user redeem one', async () => {
        const generateRes = await request(app)
            .post('/api/v1/keys/generate')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ plan: '1_month', count: 1 });
        assert.equal(generateRes.status, 201);
        const [code] = generateRes.body.data.codes;
        createdCodes.push(code);
        assert.match(code, /^OMNI-/);

        const redeemRes = await request(app)
            .post('/api/v1/keys/redeem')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code });
        assert.equal(redeemRes.status, 200);
        assert.equal(redeemRes.body.data.subscription.plan, '1_month');

        const reRedeemRes = await request(app)
            .post('/api/v1/keys/redeem')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code });
        assert.equal(reRedeemRes.status, 409);
    });

    it('404s on an unknown code', async () => {
        const res = await request(app)
            .post('/api/v1/keys/redeem')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code: 'OMNI-0000-0000-0000' });
        assert.equal(res.status, 404);
    });
});
