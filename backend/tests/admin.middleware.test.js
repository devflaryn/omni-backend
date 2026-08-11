import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import adminOnly from '../src/middlewares/admin.middleware.js';

function mockRes() {
    const res = {};
    res.statusCode = null;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

describe('adminOnly middleware', () => {
    it('calls next for an admin user', () => {
        let called = false;
        adminOnly({ user: { role: 'admin' } }, mockRes(), () => { called = true; });
        assert.ok(called);
    });

    it('403s a non-admin user', () => {
        let called = false;
        const res = mockRes();
        adminOnly({ user: { role: 'user' } }, res, () => { called = true; });
        assert.equal(called, false);
        assert.equal(res.statusCode, 403);
    });

    it('403s when req.user is missing', () => {
        const res = mockRes();
        adminOnly({}, res, () => {});
        assert.equal(res.statusCode, 403);
    });
});
