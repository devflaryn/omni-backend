import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';
import Artifact from '../src/models/artifact.model.js';
import { DOWNLOADS_ROOT } from '../src/controllers/downloads.controller.js';

// These HTTP-level tests rely on Arcjet's detectBot({ mode: "LIVE" }) not
// blocking loopback/local-network requests. If that ever changes, requests
// here would need the browser-like headers documented in scripts/smoke-test.sh.
describe('downloads API', () => {
    let userToken, userEmail;
    const testRelativePath = 'qemu/windows/_test-artifact.txt';
    const testContent = 'not a real qemu build, just test bytes\n';

    before(async () => {
        await connectToDatabase();

        userEmail = `downloads-user-${Date.now()}@omni.test`;
        const signUp = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email: userEmail, password: 'hunter22' });
        userToken = signUp.body.data.token;

        const absolutePath = path.join(DOWNLOADS_ROOT, testRelativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, testContent);

        await Artifact.create({
            category: 'qemu',
            platform: 'windows',
            version: '0.0.0-test',
            filename: testRelativePath,
            sha256: crypto.createHash('sha256').update(testContent).digest('hex'),
            sizeBytes: Buffer.byteLength(testContent),
        });
    });

    after(async () => {
        await User.deleteOne({ email: userEmail });
        await Artifact.deleteMany({ version: { $in: ['0.0.0-test', '0.0.0-test-traversal'] } });
        fs.rmSync(path.join(DOWNLOADS_ROOT, testRelativePath), { force: true });
        await mongoose.connection.close();
    });

    it('rejects an unauthenticated manifest request', async () => {
        const res = await request(app).get('/api/v1/downloads/manifest');
        assert.equal(res.status, 401);
    });

    it('lists the test artifact in the manifest', async () => {
        const res = await request(app)
            .get('/api/v1/downloads/manifest')
            .set('Authorization', `Bearer ${userToken}`);
        assert.equal(res.status, 200);
        const entry = res.body.data.find((a) => a.version === '0.0.0-test');
        assert.ok(entry, 'expected the test artifact in the manifest');
        assert.equal(entry.url, '/api/v1/downloads/file/qemu/windows');
    });

    it('downloads the file with matching bytes and sha256', async () => {
        const res = await request(app)
            .get('/api/v1/downloads/file/qemu/windows')
            .set('Authorization', `Bearer ${userToken}`);
        assert.equal(res.status, 200);
        assert.equal(res.text, testContent);
        const sha256 = crypto.createHash('sha256').update(res.text).digest('hex');
        const artifact = await Artifact.findOne({ version: '0.0.0-test' });
        assert.equal(sha256, artifact.sha256);
    });

    it('404s on an unpublished platform', async () => {
        const res = await request(app)
            .get('/api/v1/downloads/file/qemu/macos')
            .set('Authorization', `Bearer ${userToken}`);
        assert.equal(res.status, 404);
    });

    it('rejects a path-traversal artifact filename', async () => {
        await Artifact.create({
            category: 'base_image',
            platform: 'linux',
            version: '0.0.0-test-traversal',
            filename: '../../../../etc/passwd',
            sha256: crypto.createHash('sha256').update('irrelevant').digest('hex'),
            sizeBytes: 0,
        });

        const res = await request(app)
            .get('/api/v1/downloads/file/base_image/linux')
            .set('Authorization', `Bearer ${userToken}`);
        assert.equal(res.status, 500);
        assert.equal(res.body.message, 'Invalid artifact path');
    });
});
