import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Artifact from '../src/models/artifact.model.js';

describe('Artifact model', () => {
    it('accepts a valid qemu artifact with no arch', () => {
        const artifact = new Artifact({
            category: 'qemu',
            platform: 'windows',
            version: '9.1.0',
            filename: 'qemu/windows/qemu-portable-9.1.0.zip',
            sha256: 'a'.repeat(64),
            sizeBytes: 123456,
        });
        assert.equal(artifact.validateSync(), undefined);
    });

    it('accepts a valid base_image artifact with arch', () => {
        const artifact = new Artifact({
            category: 'base_image',
            platform: 'windows',
            arch: 'arm',
            version: '2026.08.11',
            filename: 'base_image/windows/arm/base_arm.qcow2',
            sha256: 'b'.repeat(64),
            sizeBytes: 5_000_000_000,
        });
        assert.equal(artifact.validateSync(), undefined);
    });

    it('rejects an unknown category', () => {
        const artifact = new Artifact({
            category: 'launcher',
            platform: 'windows',
            version: '1.0.0',
            filename: 'x',
            sha256: 'a'.repeat(64),
            sizeBytes: 1,
        });
        const err = artifact.validateSync();
        assert.ok(err && err.errors.category);
    });
});
