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

    it('requires createdBy', () => {
        const key = new LicenseKey({ code: 'OMNI-TEST-TEST-TEST', plan: 'lifetime' });
        const err = key.validateSync();
        assert.ok(err && err.errors.createdBy);
    });
});
