import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';
import LicenseKey from '../src/models/licenseKey.model.js';
import RobloxAccount from '../src/models/robloxAccount.model.js';
import { registerUser } from './helpers/signup.js';

// These HTTP-level tests rely on Arcjet's detectBot({ mode: "LIVE" }) not
// blocking loopback/local-network requests. If that ever changes, requests
// here would need the browser-like headers documented in scripts/smoke-test.sh.
describe('accounts API (cloud cookie store)', () => {
    let alice, bob;
    const emails = [];
    const codes = [];
    const COOKIE = '_|WARNING:-DO-NOT-SHARE-THIS.|_test-cookie-value';
    const NAME = `acctest${Date.now()}`;

    before(async () => {
        await connectToDatabase();
        alice = await registerUser(app, { prefix: 'acct-alice' });
        bob = await registerUser(app, { prefix: 'acct-bob' });
        for (const u of [alice, bob]) { emails.push(u.email); codes.push(u.code); }
    });

    after(async () => {
        await RobloxAccount.deleteMany({ username: NAME });
        await User.deleteMany({ email: { $in: emails } });
        await LicenseKey.deleteMany({ code: { $in: codes } });
        await mongoose.connection.close();
    });

    it('rejects unauthenticated access', async () => {
        assert.equal((await request(app).get('/api/v1/accounts')).status, 401);
    });

    it('stores a cookie and hands it back to its owner only', async () => {
        const put = await request(app)
            .put(`/api/v1/accounts/${NAME}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ cookie: COOKIE, userId: 12345, placeId: '606849621' });
        assert.equal(put.status, 200);
        assert.equal(put.body.data.account.hasCookie, true);
        // A list/upsert response must never carry the secret itself.
        assert.equal(put.body.data.account.cookie, undefined);

        const mine = await request(app)
            .get(`/api/v1/accounts/${NAME}/cookie`)
            .set('Authorization', `Bearer ${alice.token}`);
        assert.equal(mine.status, 200);
        assert.equal(mine.body.data.cookie, COOKIE);

        const theirs = await request(app)
            .get(`/api/v1/accounts/${NAME}/cookie`)
            .set('Authorization', `Bearer ${bob.token}`);
        assert.equal(theirs.status, 404);   // owner-scoped query: not visible at all
    });

    it('encrypts the cookie at rest', async () => {
        const row = await RobloxAccount.findOne({ username: NAME });
        assert.ok(row.cookie, 'a cookie should be stored');
        assert.notEqual(row.cookie, COOKIE);
        assert.ok(row.cookie.startsWith('v1.'), 'stored value should be sealed');
    });

    it('keeps the stored cookie when a metadata-only update arrives', async () => {
        const res = await request(app)
            .put(`/api/v1/accounts/${NAME}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ customName: 'main farm' });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.account.hasCookie, true);
        assert.equal(res.body.data.account.customName, 'main farm');
    });

    it('reports running state, and names the device when it is elsewhere', async () => {
        const beat = await request(app)
            .post(`/api/v1/accounts/${NAME}/state`)
            .set('Authorization', `Bearer ${alice.token}`)
            .set('X-Omni-Device-Id', 'device-mac-1')
            .set('X-Omni-Device-Name', 'Mac mini')
            .set('X-Omni-Device-Os', 'darwin')
            .send({ state: 'running', mode: 'playable' });
        assert.equal(beat.status, 200);
        assert.equal(beat.body.data.presence.label, 'Running');   // same device asking

        const fromOtherMachine = await request(app)
            .get('/api/v1/accounts')
            .set('Authorization', `Bearer ${alice.token}`)
            .set('X-Omni-Device-Id', 'device-win-1');
        const seen = fromOtherMachine.body.data.accounts.find((a) => a.username === NAME);
        assert.equal(seen.presence.state, 'running');
        assert.equal(seen.presence.label, 'Running on Mac mini');
    });

    it('will not let a different device clear someone else\'s running lease', async () => {
        const res = await request(app)
            .post(`/api/v1/accounts/${NAME}/state`)
            .set('Authorization', `Bearer ${alice.token}`)
            .set('X-Omni-Device-Id', 'device-win-1')
            .send({ state: 'stopped' });
        assert.equal(res.status, 409);
    });

    it('stops when the holding device says so', async () => {
        const res = await request(app)
            .post(`/api/v1/accounts/${NAME}/state`)
            .set('Authorization', `Bearer ${alice.token}`)
            .set('X-Omni-Device-Id', 'device-mac-1')
            .send({ state: 'stopped' });
        assert.equal(res.status, 200);
        assert.equal(res.body.data.presence.state, 'stopped');
    });

    it('bulk-syncs a local account list', async () => {
        const res = await request(app)
            .post('/api/v1/accounts/sync')
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ accounts: [{ username: NAME, cookie: COOKIE, userId: 12345 }] });
        assert.equal(res.status, 200);
        assert.ok(res.body.data.accounts.some((a) => a.username === NAME));
    });
});
