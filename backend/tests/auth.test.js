import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';
import LicenseKey from '../src/models/licenseKey.model.js';
import { freshIdentity, mintKey, registerUser } from './helpers/signup.js';

// These HTTP-level tests rely on Arcjet's detectBot({ mode: "LIVE" }) not
// blocking loopback/local-network requests. If that ever changes, requests
// here would need the browser-like headers documented in scripts/smoke-test.sh.
describe('auth API — free accounts', () => {
    const emails = [];
    const codes = [];

    const track = (u) => {
        emails.push(u.email);
        codes.push(...(u.codes || []));
        return u;
    };

    before(async () => {
        await connectToDatabase();
    });

    after(async () => {
        await User.deleteMany({ email: { $in: emails } });
        await LicenseKey.deleteMany({ code: { $in: codes } });
        await mongoose.connection.close();
    });

    it('creates an account with no license key, on the free tier', async () => {
        const { email, username } = freshIdentity('free-new');
        emails.push(email);

        const res = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email, username, password: 'hunter22' });

        assert.equal(res.status, 201);
        assert.ok(res.body.data.token, 'sign-up must return a session token');
        assert.equal(res.body.data.user.username, username);
        assert.equal(res.body.data.subscription.tier, 'free');
        assert.equal(res.body.data.subscription.active, false);
        assert.equal(res.body.data.subscription.plan, null);
    });

    it('never returns the password hash', async () => {
        const user = track(await registerUser(app, { prefix: 'free-hash' }));
        assert.equal(user.user.password, undefined);
    });

    it('rejects an email that is already registered', async () => {
        const first = track(await registerUser(app, { prefix: 'free-dupe' }));
        const res = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email: first.email, username: freshIdentity('other').username, password: 'hunter22' });

        assert.equal(res.status, 409);
    });

    it('rejects a username already taken, whatever its case', async () => {
        const first = track(await registerUser(app, { prefix: 'free-uniq' }));
        const { email } = freshIdentity('free-uniq2');
        emails.push(email);

        const res = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email, username: first.username.toUpperCase(), password: 'hunter22' });

        assert.equal(res.status, 409);
        assert.match(res.body.message, /username/i);
    });

    it('rejects a username with characters a display name cannot carry', async () => {
        for (const username of ['ab', 'has space', 'has-hyphen', 'a'.repeat(25)]) {
            const { email } = freshIdentity('free-bad');
            const res = await request(app)
                .post('/api/v1/auth/sign-up')
                .send({ email, username, password: 'hunter22' });
            assert.equal(res.status, 400, `expected 400 for username "${username}"`);
        }
    });

    it('still requires an email and a long enough password', async () => {
        const { email, username } = freshIdentity('free-short');
        const noEmail = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ username, password: 'hunter22' });
        assert.equal(noEmail.status, 400);

        const shortPassword = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email, username, password: 'abc' });
        assert.equal(shortPassword.status, 400);
    });

    it('signs in with email and password, reporting the username and tier', async () => {
        const user = track(await registerUser(app, { prefix: 'free-in' }));

        const res = await request(app)
            .post('/api/v1/auth/sign-in')
            .send({ email: user.email, password: 'hunter22' });

        assert.equal(res.status, 200);
        assert.equal(res.body.data.user.username, user.username);
        assert.equal(res.body.data.subscription.tier, 'free');
    });

    it('turns premium once a key is redeemed, and keeps the username', async () => {
        const user = track(await registerUser(app, { prefix: 'free-up' }));
        const code = await mintKey('30_day');
        codes.push(code);

        const redeemed = await request(app)
            .post('/api/v1/keys/redeem')
            .set('Authorization', `Bearer ${user.token}`)
            .send({ code });

        assert.equal(redeemed.status, 200);
        assert.equal(redeemed.body.data.subscription.tier, 'premium');
        assert.equal(redeemed.body.data.subscription.plan, '30_day');
        assert.equal(redeemed.body.data.subscription.daysRemaining, 30);

        const me = await request(app)
            .get('/api/v1/auth/me')
            .set('Authorization', `Bearer ${user.token}`);
        assert.equal(me.body.data.subscription.tier, 'premium');
        assert.equal(me.body.data.user.username, user.username);
    });

    // The reason the paywall came off /api/v1/accounts. A free account owns its
    // Roblox accounts and cookies exactly as a premium one does; the tier gates
    // features, not the account store. A 402 here means free sign-up produced a
    // user who cannot use the app at all.
    it('lets a free account reach its own cloud account store', async () => {
        const user = track(await registerUser(app, { prefix: 'free-store' }));

        const res = await request(app)
            .get('/api/v1/accounts')
            .set('Authorization', `Bearer ${user.token}`);

        assert.equal(res.status, 200);
        assert.deepEqual(res.body.data.accounts, []);
    });
});
