import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { seal, open, isSealed } from '../src/utils/secretBox.js';

describe('secretBox', () => {
    const secret = '_|WARNING:-DO-NOT-SHARE-THIS.|_abc123';

    it('round-trips a value', () => {
        assert.equal(open(seal(secret)), secret);
    });

    it('produces a different blob every time (fresh nonce)', () => {
        assert.notEqual(seal(secret), seal(secret));
    });

    it('refuses a tampered ciphertext instead of returning garbage', () => {
        const blob = seal(secret);
        const [v, iv, tag, ct] = blob.split('.');
        const flipped = Buffer.from(ct, 'base64url');
        flipped[0] ^= 0xff;
        assert.throws(() => open([v, iv, tag, flipped.toString('base64url')].join('.')));
    });

    it('recognises its own format', () => {
        assert.ok(isSealed(seal(secret)));
        assert.ok(!isSealed(secret));
        assert.ok(!isSealed(null));
    });
});
