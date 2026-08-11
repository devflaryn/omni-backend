import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';

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
        const email = `harness-${Date.now()}@omni.test`;
        const signUp = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email, password: 'hunter22' });
        assert.equal(signUp.status, 201);

        const users = await request(app)
            .get('/api/v1/users')
            .set('Authorization', `Bearer ${signUp.body.data.token}`);
        assert.equal(users.status, 200);
        assert.ok(users.body.data.some((u) => u.email === email));

        await User.deleteOne({ email });
    });
});
