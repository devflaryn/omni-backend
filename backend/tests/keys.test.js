import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';
import LicenseKey from '../src/models/licenseKey.model.js';

describe('keys API', () => {
    let adminToken, adminEmail, userToken, userEmail;
    const createdCodes = [];

    before(async () => {
        await connectToDatabase();

        adminEmail = `keys-admin-${Date.now()}@omni.test`;
        const adminSignUp = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email: adminEmail, password: 'hunter22' });
        adminToken = adminSignUp.body.data.token;
        await User.updateOne({ email: adminEmail }, { role: 'admin' });

        userEmail = `keys-user-${Date.now()}@omni.test`;
        const userSignUp = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email: userEmail, password: 'hunter22' });
        userToken = userSignUp.body.data.token;
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
