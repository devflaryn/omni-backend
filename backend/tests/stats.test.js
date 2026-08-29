import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';

import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';
import LicenseKey from '../src/models/licenseKey.model.js';
import RobloxAccount from '../src/models/robloxAccount.model.js';
import StatSnapshot from '../src/models/statSnapshot.model.js';
import { registerUser } from './helpers/signup.js';

/*
 * Stat Track, end to end: the in-game script's side (claim a token, report over
 * POST and over GET) and the dashboard's side (JWT, premium, owner-scoped).
 *
 * Like accounts.test.js, these ride the real app and therefore the real arcjet
 * middleware; the /omni/exec half is deliberately NOT under /api, which is part
 * of what is being checked — an in-game HttpGet has no browser headers and must
 * never meet bot detection.
 */
describe('stat track', () => {
    let premium, free;
    const emails = [];
    const codes = [];
    const PAID = `stpaid${Date.now().toString(36)}`;
    const FREE = `stfree${Date.now().toString(36)}`;

    const claim = async (channel) => {
        const res = await request(app).get(`/omni/exec/claim?channel=${channel}`);
        assert.equal(res.status, 200, `claim failed: ${JSON.stringify(res.body)}`);
        return res.body.token;
    };

    before(async () => {
        await connectToDatabase();
        premium = await registerUser(app, { prefix: 'stat-paid', plan: 'lifetime' });
        free = await registerUser(app, { prefix: 'stat-free' });
        for (const u of [premium, free]) { emails.push(u.email); codes.push(...u.codes); }

        for (const [user, name] of [[premium, PAID], [free, FREE]]) {
            const put = await request(app)
                .put(`/api/v1/accounts/${name}`)
                .set('Authorization', `Bearer ${user.token}`)
                .send({ userId: 4242, placeId: '8737899170' });
            assert.equal(put.status, 200);
        }
    });

    after(async () => {
        await StatSnapshot.deleteMany({ username: { $in: [PAID, FREE] } });
        await RobloxAccount.deleteMany({ username: { $in: [PAID, FREE] } });
        await User.deleteMany({ email: { $in: emails } });
        await LicenseKey.deleteMany({ code: { $in: codes } });
        await mongoose.connection.close();
    });

    // ---- the read side -----------------------------------------------------

    it('refuses an unauthenticated read', async () => {
        assert.equal((await request(app).get('/api/v1/stats')).status, 401);
    });

    it('answers a free account with 402, not 403', async () => {
        // The client tells these apart: 403 means "not yours" and 402 means
        // "redeem a key". Showing the wrong prompt is the difference between a
        // user who renews and a user who files a bug.
        const res = await request(app)
            .get('/api/v1/stats')
            .set('Authorization', `Bearer ${free.token}`);
        assert.equal(res.status, 402);
        assert.equal(res.body.error, 'subscription_inactive');
    });

    it('lists an account that has never reported, rather than hiding it', async () => {
        const res = await request(app)
            .get('/api/v1/stats')
            .set('Authorization', `Bearer ${premium.token}`);
        assert.equal(res.status, 200);
        const row = res.body.data.accounts.find((a) => a.username === PAID);
        assert.ok(row, 'a never-tracked account must still be listed');
        assert.equal(row.tracking, false);
        assert.deepEqual(row.metrics, []);
    });

    // ---- the in-game side --------------------------------------------------

    it('serves the collector as Luau with the public base substituted', async () => {
        const res = await request(app).get('/omni/exec/stattrack.lua');
        assert.equal(res.status, 200);
        assert.match(res.headers['content-type'], /text\/plain/);
        assert.ok(res.text.includes('OMNI STAT TRACK'));
        // The placeholder must be GONE — a script that still says
        // __OMNI_BASE__ reports to a host that does not exist.
        assert.equal(res.text.includes('__OMNI_BASE__'), false);
        assert.ok(res.text.includes('/omni/exec/stats'));
    });

    it('refuses a report with no session token', async () => {
        const res = await request(app).post('/omni/exec/stats').send({ metrics: { gems: 1 } });
        assert.equal(res.status, 403);
        assert.equal(res.body.error, 'no_session');
    });

    it('stores a report and reports the gain on the next one', async () => {
        const token = await claim(PAID);

        const first = await request(app).post('/omni/exec/stats').send({
            t: token,
            placeId: '8737899170',
            placeName: 'Pet Simulator 99',
            uptimeSec: 120,
            executor: 'Arceus X NEO',
            metrics: [
                { key: 'Gems', value: '1.2M', source: 'leaderstats' },
                { key: 'Coins', value: 3400, source: 'leaderstats' },
                { key: 'Rank', value: 'Gold', source: 'attribute' },
            ],
        });
        assert.equal(first.status, 200);
        assert.equal(first.body.ok, true);
        assert.equal(first.body.metrics, 3);
        assert.deepEqual(first.body.deltas, {});   // nothing to compare against yet

        const second = await request(app).post('/omni/exec/stats').send({
            t: token,
            uptimeSec: 140,
            metrics: [{ key: 'Gems', value: '1.3M' }],
        });
        assert.equal(second.status, 200);
        assert.equal(second.body.deltas.gems, 100_000);

        const read = await request(app)
            .get(`/api/v1/stats/${PAID}`)
            .set('Authorization', `Bearer ${premium.token}`);
        assert.equal(read.status, 200);
        assert.equal(read.body.data.account.tracking, true);
        assert.equal(read.body.data.account.placeName, 'Pet Simulator 99');
        const gems = read.body.data.account.metrics.find((m) => m.key === 'gems');
        assert.equal(gems.value, 1_300_000);
        assert.equal(gems.display, '1.3M');
        // Two reports, two history points — the tail a chart draws from.
        assert.equal(read.body.data.history.length, 2);
    });

    it('accepts a report over GET, because in-game only HttpGet is guaranteed', async () => {
        const token = await claim(PAID);
        const payload = JSON.stringify({ uptimeSec: 200, metrics: { Gems: 1_500_000 } });
        const res = await request(app)
            .get('/omni/exec/stats')
            .query({ t: token, payload });
        assert.equal(res.status, 200);
        assert.equal(res.body.ok, true);
        assert.equal(res.body.deltas.gems, 200_000);
    });

    it('refuses to store anything for an account whose owner has no plan', async () => {
        // The gate is on INGEST as well as on read: gating only the dashboard
        // would leave a write path a free account can drive at will.
        const token = await claim(FREE);
        const res = await request(app).post('/omni/exec/stats').send({
            t: token,
            metrics: { Gems: 5 },
        });
        assert.equal(res.status, 402);
        assert.equal(res.body.stop, true);   // the script gives up rather than looping
        assert.equal(await StatSnapshot.countDocuments({ username: FREE }), 0);
    });

    it('never shows one user the stats of another', async () => {
        const res = await request(app)
            .get(`/api/v1/stats/${PAID}`)
            .set('Authorization', `Bearer ${free.token}`);
        // Free is refused by the paywall before ownership is even consulted;
        // either way the row must not come back.
        assert.ok(res.status === 402 || res.status === 404);
        assert.equal(res.body?.data, undefined);
    });

    it('clears a snapshot on request', async () => {
        const res = await request(app)
            .delete(`/api/v1/stats/${PAID}`)
            .set('Authorization', `Bearer ${premium.token}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.data.deleted, 1);
        assert.equal(await StatSnapshot.countDocuments({ username: PAID }), 0);
    });
});
