import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyCode } from '../src/utils/generateKeyCode.js';

describe('generateKeyCode', () => {
    it('matches the OMNI-XXXX-XXXX-XXXX format', () => {
        const code = generateKeyCode();
        assert.match(code, /^OMNI-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });

    it('excludes ambiguous characters (0, O, 1, I)', () => {
        const code = generateKeyCode();
        // Extract just the generated part (everything after "OMNI-")
        const generatedPart = code.replace(/^OMNI-/, '').replace(/-/g, '');
        assert.doesNotMatch(generatedPart, /[01OI]/);
    });

    it('produces distinct codes across many calls', () => {
        const codes = new Set(Array.from({ length: 500 }, generateKeyCode));
        assert.equal(codes.size, 500);
    });
});
