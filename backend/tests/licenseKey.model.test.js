import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import LicenseKey from '../src/models/licenseKey.model.js';

describe('LicenseKey model', () => {
    it('defaults status to unused', () => {
        const key = new LicenseKey({
            code: 'OMNI-TEST-TEST-TEST',
            plan: '1_month',
            createdBy: new mongoose.Types.ObjectId(),
        });
        assert.equal(key.toObject().status, 'unused');
    });

    it('rejects an invalid plan', () => {
        const key = new LicenseKey({
            code: 'OMNI-TEST-TEST-TEST',
            plan: 'yearly',
            createdBy: new mongoose.Types.ObjectId(),
        });
        const err = key.validateSync();
        assert.ok(err && err.errors.plan);
    });

    it('allows a key with no creator (seeded before any admin exists)', () => {
        // Sign-up requires a key, so the first keys cannot be minted by an
        // admin — there is no account to promote yet. scripts/seed-keys.js
        // creates them with createdBy unset, and that has to validate.
        const key = new LicenseKey({ code: 'OMNI-TEST-TEST-TEST', plan: 'lifetime' });
        const err = key.validateSync();
        assert.equal(err, undefined);
        assert.equal(key.createdBy, null);
    });

    it('accepts the day-based plans', () => {
        for (const plan of ['30_day', '90_day']) {
            const key = new LicenseKey({ code: `OMNI-TEST-TEST-${plan}`, plan });
            assert.equal(key.validateSync(), undefined);
        }
    });
});
