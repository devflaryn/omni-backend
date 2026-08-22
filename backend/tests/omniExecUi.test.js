/*
 * The in-game UI payload, as the executor receives it.
 *
 * The middleware is exercised directly rather than over HTTP: this route runs
 * BEFORE arcjet and the routers, it touches no model, and it needs no database,
 * so standing one up would only add a way for the test to fail for reasons that
 * have nothing to do with the payload.
 *
 * What is actually being protected here is the assembly contract. The modules
 * are concatenated into ONE Luau chunk and their numeric prefixes ARE the
 * dependency order, so a rename that reorders them, a stray file that lands in
 * the middle, or a `__OMNI_BASE__` that survives into the served text are all
 * silent breakages: the payload still serves 200 OK and the menu simply never
 * appears in-game, where nothing here can see it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import omniExec from '../src/omni-exec/omniExec.middleware.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAYLOADS = path.join(HERE, '..', 'src', 'omni-exec', 'payloads');
const UIDIR = path.join(PAYLOADS, 'ui');

function fakeRes() {
    const res = { statusCode: null, headers: {}, body: null };
    res.status = (code) => { res.statusCode = code; return res; };
    res.set = (key, value) => { res.headers[key] = value; return res; };
    res.end = (buf) => { res.body = buf; return res; };
    return res;
}

/** Run the middleware for `url`. Returns {res, nexted, text}. */
function serve(url) {
    const res = fakeRes();
    let nexted = false;
    omniExec({ url }, res, () => { nexted = true; });
    return {
        res,
        nexted,
        text: res.body ? Buffer.from(res.body).toString('utf8') : '',
    };
}

const uiModules = () =>
    fs.readdirSync(UIDIR).filter(n => n.endsWith('.lua')).sort();

describe('omni-exec in-game UI payload', () => {
    it('serves the assembled UI for /gist', () => {
        const { res, text } = serve('/gist');
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['Content-Type'], /^text\/plain/);
        assert.ok(text.length > 1000, 'payload is implausibly small');
    });

    it('concatenates every ui/*.lua module, in filename order', () => {
        const { text } = serve('/gist');
        const names = uiModules();
        assert.ok(names.length >= 2, 'expected several UI modules on disk');

        const seen = [...text.matchAll(/--\[\[ file: (.+?) \]\]/g)].map(m => m[1]);
        assert.deepEqual(seen, names,
            'banner order must match the sorted filenames — the prefixes ARE '
            + 'the dependency order');
    });

    it('lists the modules in a manifest comment', () => {
        const { text } = serve('/gist');
        assert.ok(text.includes(`-- modules, in load order: ${uiModules().join(', ')}`));
    });

    it('substitutes __OMNI_BASE__ with nothing left over', () => {
        const { text } = serve('/gist');
        assert.ok(!text.includes('__OMNI_BASE__'),
            'an unsubstituted placeholder leaves the exec bridge polling a '
            + 'host that does not exist');
        assert.ok(/OMNI\.BASE\s*=\s*"https?:\/\//.test(text),
            'OMNI.BASE should carry a real URL after substitution');
    });

    it('wraps the whole chunk in one pcall with a reporting warn', () => {
        const { text } = serve('/gist');
        const opens = text.match(/local __omni_ok, __omni_err = pcall\(function\(\)/g) || [];
        assert.equal(opens.length, 1, 'exactly one wrapper');
        assert.ok(text.includes('if not __omni_ok then warn('),
            'a failed chunk must say so in the executor console');
        // The wrapper must come before the first module and close after the last.
        const firstBanner = text.indexOf('--[[ file:');
        assert.ok(text.indexOf('pcall(function()') < firstBanner);
        assert.ok(text.lastIndexOf('end)') > text.lastIndexOf('--[[ file:'));
    });

    it('keeps the marker name in step with omnidroid/execmark.py', () => {
        const { text } = serve('/gist');
        // execmark.MARKER_NAME and OMNI.MARKER are one contract with no
        // runtime negotiation between them; this is the only place the two
        // halves are ever checked against each other.
        assert.ok(text.includes('OMNI.MARKER = "omni_host.data"'),
            'the marker name changed here but not in omnidroid/execmark.py');
    });

    it('falls back to custom_ui.lua when ui/ is absent', () => {
        const parked = `${UIDIR}.__test_parked`;
        fs.renameSync(UIDIR, parked);
        try {
            const { res, text } = serve('/gist');
            assert.equal(res.statusCode, 200);
            assert.ok(text.includes('OMNI-EXEC'),
                'the single-file payload should still serve a menu');
            assert.ok(!text.includes('--[[ file:'),
                'the fallback is not assembled from modules');
            assert.ok(!text.includes('__OMNI_BASE__'),
                'the fallback still needs its base substituted');
        } finally {
            fs.renameSync(parked, UIDIR);
        }
    });

    it('leaves non-executor paths to the rest of the app', () => {
        const { nexted, res } = serve('/api/v1/users/me');
        assert.equal(nexted, true, 'the real API must never be intercepted');
        assert.equal(res.statusCode, null);
    });
});
