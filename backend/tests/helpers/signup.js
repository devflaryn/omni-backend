import request from 'supertest';

import LicenseKey from '../../src/models/licenseKey.model.js';
import { generateKeyCode } from '../../src/utils/generateKeyCode.js';

/*
 * Registering now costs a license key, so every suite that needs a user has to
 * mint one first. Keys are created directly through the model rather than the
 * admin endpoint on purpose: the endpoint needs an admin, an admin needs an
 * account, and an account needs a key — the tests would never get off the
 * ground. This is the same bootstrap scripts/seed-keys.js performs.
 */
export async function mintKey(plan = 'lifetime') {
    const key = await LicenseKey.create({ code: generateKeyCode(), plan, note: 'test' });
    return key.code;
}

/** Register a fresh user, returning everything a test needs to clean up. */
export async function registerUser(app, { plan = 'lifetime', prefix = 'test' } = {}) {
    const email = `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@omni.test`;
    const code = await mintKey(plan);
    const res = await request(app)
        .post('/api/v1/auth/sign-up')
        .send({ email, password: 'hunter22', key: code });
    if (res.status !== 201) {
        throw new Error(`sign-up failed (${res.status}): ${JSON.stringify(res.body)}`);
    }
    return { email, code, token: res.body.data.token, user: res.body.data.user };
}
