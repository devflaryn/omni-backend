import request from 'supertest';

import LicenseKey from '../../src/models/licenseKey.model.js';
import { generateKeyCode } from '../../src/utils/generateKeyCode.js';

/*
 * Minting keys directly through the model rather than the admin endpoint is
 * deliberate: that endpoint needs an admin, and promoting an admin needs an
 * account. Going through the model keeps the bootstrap a single write, the
 * same way scripts/seed-keys.js does it.
 */
export async function mintKey(plan = 'lifetime') {
    const key = await LicenseKey.create({ code: generateKeyCode(), plan, note: 'test' });
    return key.code;
}

/**
 * An email/username pair no other test run can collide with.
 *
 * Base36 rather than decimal because usernames cap at 24 characters: a
 * millisecond timestamp plus six random digits is 19 characters in decimal and
 * would have to be truncated — which is exactly how two "unique" fixtures end
 * up identical. Base36 fits the same entropy in 12.
 */
export function freshIdentity(prefix = 'test') {
    const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const slug = prefix.replace(/[^a-z0-9]/gi, '').slice(0, 10);
    return { email: `${prefix}-${stamp}@omni.test`, username: `${slug}${stamp}` };
}

/**
 * Register a fresh user, returning everything a test needs to clean up.
 *
 * Sign-up is free and produces a FREE account. Pass `plan` when a test needs a
 * premium one — the key is redeemed after the fact, which is the only way an
 * account gets a plan now that sign-up no longer takes a key.
 */
export async function registerUser(app, { plan = null, prefix = 'test' } = {}) {
    const { email, username } = freshIdentity(prefix);
    const res = await request(app)
        .post('/api/v1/auth/sign-up')
        .send({ email, username, password: 'hunter22' });
    if (res.status !== 201) {
        throw new Error(`sign-up failed (${res.status}): ${JSON.stringify(res.body)}`);
    }

    const token = res.body.data.token;
    const codes = [];
    if (plan) {
        const code = await mintKey(plan);
        codes.push(code);
        const redeemed = await request(app)
            .post('/api/v1/keys/redeem')
            .set('Authorization', `Bearer ${token}`)
            .send({ code });
        if (redeemed.status !== 200) {
            throw new Error(`redeem failed (${redeemed.status}): ${JSON.stringify(redeemed.body)}`);
        }
    }

    return { email, username, token, codes, user: res.body.data.user };
}
