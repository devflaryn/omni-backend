import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import User from '../src/models/user.model.js';

describe('User model defaults', () => {
    it('defaults role to user and subscription to inactive', () => {
        const user = new User({ email: 'defaults@omni.test', password: 'hunter22' });
        const obj = user.toObject();
        assert.equal(obj.role, 'user');
        assert.equal(obj.subscription.plan, null);
        assert.equal(obj.subscription.expiresAt, null);
    });

    it('rejects an invalid role', () => {
        const user = new User({ email: 'bad@omni.test', password: 'hunter22', role: 'superuser' });
        const err = user.validateSync();
        assert.ok(err, 'expected a validation error');
        assert.ok(err.errors.role, 'expected role to be the invalid field');
    });
});
