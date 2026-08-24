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

/*
 * The privacy wall. Before this existed, anyone who knew a Roblox username could
 * push Luau into that account's live session. These tests are the acceptance
 * criteria for "only you can execute against your own accounts".
 */
describe('exec bridge ownership wall', () => {
    let alice, bob;
    const emails = [];
    const codes = [];
    const CHANNEL = `exectest${Date.now()}`;

    before(async () => {
        await connectToDatabase();
        alice = await registerUser(app, { prefix: 'exec-alice' });
        bob = await registerUser(app, { prefix: 'exec-bob' });
        for (const u of [alice, bob]) { emails.push(u.email); codes.push(...u.codes); }

        // Alice owns the account and has it running (a fresh presence lease).
        await request(app)
            .put(`/api/v1/accounts/${CHANNEL}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ cookie: 'cookie-for-exec-test', userId: 999 });
        await request(app)
            .post(`/api/v1/accounts/${CHANNEL}/state`)
            .set('Authorization', `Bearer ${alice.token}`)
            .set('X-Omni-Device-Id', 'dev-a')
            .set('X-Omni-Device-Name', 'Alice PC')
            .send({ state: 'running' });
    });

    after(async () => {
        await RobloxAccount.deleteMany({ username: CHANNEL });
        await User.deleteMany({ email: { $in: emails } });
        await LicenseKey.deleteMany({ code: { $in: codes } });
        await mongoose.connection.close();
    });

    it('refuses an unauthenticated submit', async () => {
        const res = await request(app)
            .post('/omni/exec/submit')
            .send({ channel: CHANNEL, script: 'print("hi")' });
        assert.equal(res.status, 401);
    });

    it('refuses a submit from a user who does not own the channel', async () => {
        const res = await request(app)
            .post('/omni/exec/submit')
            .set('Authorization', `Bearer ${bob.token}`)
            .send({ channel: CHANNEL, script: 'print("pwned")' });
        assert.equal(res.status, 403);
        assert.equal(res.body.error, 'not_your_account');
    });

    it('accepts a submit from the owner', async () => {
        const res = await request(app)
            .post('/omni/exec/submit')
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ channel: CHANNEL, script: 'print("mine")' });
        assert.equal(res.status, 200);
        assert.ok(res.body.id);
    });

    it('hides status of an account you do not own', async () => {
        const mine = await request(app)
            .get(`/omni/exec/status?channel=${CHANNEL}`)
            .set('Authorization', `Bearer ${alice.token}`);
        assert.equal(mine.status, 200);

        const theirs = await request(app)
            .get(`/omni/exec/status?channel=${CHANNEL}`)
            .set('Authorization', `Bearer ${bob.token}`);
        assert.equal(theirs.status, 403);
    });

    it('will not hand out a queued job without a session token', async () => {
        const res = await request(app).get(`/omni/exec/poll?channel=${CHANNEL}`);
        assert.equal(res.status, 403);
    });

    it('lets an in-game poller claim a token while the owner has it launched, and run the job', async () => {
        const claim = await request(app).post('/omni/exec/claim').send({ channel: CHANNEL });
        assert.equal(claim.status, 200);
        const token = claim.body.token;
        assert.ok(token);

        const poll = await request(app).get(`/omni/exec/poll?t=${token}`);
        assert.equal(poll.status, 200);
        assert.equal(poll.body.script, 'print("mine")');

        const reported = await request(app)
            .post('/omni/exec/result')
            .send({ t: token, id: poll.body.id, ok: true, output: 'mine' });
        assert.equal(reported.status, 200);

        const readByOwner = await request(app)
            .get(`/omni/exec/result?id=${poll.body.id}`)
            .set('Authorization', `Bearer ${alice.token}`);
        assert.equal(readByOwner.status, 200);
        assert.equal(readByOwner.body.output, 'mine');

        const readByStranger = await request(app)
            .get(`/omni/exec/result?id=${poll.body.id}`)
            .set('Authorization', `Bearer ${bob.token}`);
        assert.equal(readByStranger.status, 403);
    });

    it('refuses a claim for an account that does not exist', async () => {
        const res = await request(app)
            .post('/omni/exec/claim')
            .send({ channel: `nosuchaccount${Date.now()}` });
        assert.equal(res.status, 403);
        assert.equal(res.body.error, 'unknown_account');
    });

    it('claims over GET too, because in-game only HttpGet is guaranteed', async () => {
        // Requiring POST left the poller looping on claim forever and never
        // reaching the polling code: jobs queued, lastPollMsAgo null, and the
        // editor reporting "No live session" over a loaded game.
        const res = await request(app).get(`/omni/exec/claim?channel=${CHANNEL}`);
        assert.equal(res.status, 200);
        assert.ok(res.body.token);
    });

    it('accepts a result over GET when the executor has no POST', async () => {
        const claim = await request(app).get(`/omni/exec/claim?channel=${CHANNEL}`);
        const token = claim.body.token;
        await request(app)
            .post('/omni/exec/submit')
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ channel: CHANNEL, script: 'print("get-report")' });
        const poll = await request(app).get(`/omni/exec/poll?t=${token}`);
        assert.ok(poll.body.id);
        const reported = await request(app).get(
            `/omni/exec/report?t=${token}&id=${poll.body.id}&ok=true&output=${encodeURIComponent('hi there')}`);
        assert.equal(reported.status, 200);
        const read = await request(app)
            .get(`/omni/exec/result?id=${poll.body.id}`)
            .set('Authorization', `Bearer ${alice.token}`);
        assert.equal(read.body.output, 'hi there');
    });
});

describe('exec bridge limits', () => {
    let alice;
    const emails = [];
    const codes = [];
    const CHANNEL = `execlim${Date.now()}`;

    before(async () => {
        await connectToDatabase();
        alice = await registerUser(app, { prefix: 'execlim' });
        emails.push(alice.email); codes.push(...alice.codes);
        await request(app)
            .put(`/api/v1/accounts/${CHANNEL}`)
            .set('Authorization', `Bearer ${alice.token}`)
            .send({ cookie: 'c', userId: 1 });
    });

    after(async () => {
        await RobloxAccount.deleteMany({ username: CHANNEL });
        await User.deleteMany({ email: { $in: emails } });
        await LicenseKey.deleteMany({ code: { $in: codes } });
        await mongoose.connection.close();
    });

    it('bounds the queue for a channel nothing is polling', async () => {
        // 50 allowed, the 51st refused: without a cap, clicking Run against a
        // session that never loaded grows this process by 200 KB a click until
        // the 5-minute TTL sweeps it.
        let lastStatus = 200;
        for (let i = 0; i < 55; i++) {
            const res = await request(app)
                .post('/omni/exec/submit')
                .set('Authorization', `Bearer ${alice.token}`)
                .send({ channel: CHANNEL, script: `print(${i})` });
            lastStatus = res.status;
            if (res.status !== 200) {
                assert.equal(res.body.error, 'queue_full');
                break;
            }
        }
        assert.equal(lastStatus, 429, 'the queue must stop accepting eventually');
    });

    it('refuses a result whose submitter can no longer be established', async () => {
        // Fails closed: a job id is short and guessable, so "owner unknown"
        // must not read as "anyone may have it".
        const res = await request(app)
            .get('/omni/exec/result?id=definitely-not-a-real-job')
            .set('Authorization', `Bearer ${alice.token}`);
        assert.equal(res.status, 200);
        assert.equal(res.body.done, false);
    });
});
