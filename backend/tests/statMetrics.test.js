import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    slugKey,
    parseNumeric,
    normalizeMetric,
    normalizeMetrics,
    metricDeltas,
    historyPoint,
    MAX_METRICS,
} from '../src/utils/statMetrics.js';

// The half of Stat Track that needs no database: what a game hands us versus
// what the dashboard is allowed to claim.
describe('stat metric normalisation', () => {
    it('slugs a key so the same stat cannot split into two rows', () => {
        assert.equal(slugKey(' Total Gems '), 'total_gems');
        assert.equal(slugKey('Gems!!'), 'gems');
        assert.equal(slugKey('Gems'), slugKey('gems'));
        assert.equal(slugKey('   '), '');
    });

    it('parses the abbreviations a Roblox UI actually prints', () => {
        assert.equal(parseNumeric('1.2M'), 1_200_000);
        assert.equal(parseNumeric('3,400'), 3400);
        assert.equal(parseNumeric('1.5k'), 1500);
        assert.equal(parseNumeric(42), 42);
        assert.equal(parseNumeric(true), 1);
    });

    it('refuses to invent a number for something that is not one', () => {
        // The important half: a rank name must be null, NOT 0 — a 0 renders as
        // a real value that just dropped to nothing.
        assert.equal(parseNumeric('Gold III'), null);
        assert.equal(parseNumeric(''), null);
        assert.equal(parseNumeric(NaN), null);
        assert.equal(parseNumeric(Infinity), null);
    });

    it('keeps both readings, because neither can be derived from the other', () => {
        const m = normalizeMetric({ key: 'Gems', value: '1.2M' });
        assert.equal(m.key, 'gems');
        assert.equal(m.label, 'Gems');       // what the game called it survives
        assert.equal(m.value, 1_200_000);
        assert.equal(m.display, '1.2M');     // what the player sees survives too
    });

    it('drops a metric that says nothing at all', () => {
        assert.equal(normalizeMetric({ key: 'Gems' }), null);
        assert.equal(normalizeMetric({ key: 'Gems', value: null }), null);
        assert.equal(normalizeMetric({ value: 5 }), null);          // no key
        assert.equal(normalizeMetric('gems'), null);
    });

    it('accepts a map as readily as an array, and first writer wins', () => {
        const fromMap = normalizeMetrics({ Gems: 10, Coins: 20 });
        assert.deepEqual(fromMap.map((m) => m.key), ['gems', 'coins']);

        // leaderstats is collected first, so its reading must beat the sweep's.
        const dupes = normalizeMetrics([
            { key: 'Gems', value: 100, source: 'leaderstats' },
            { key: 'gems', value: 999, source: 'found' },
        ]);
        assert.equal(dupes.length, 1);
        assert.equal(dupes[0].value, 100);
        assert.equal(dupes[0].source, 'leaderstats');
    });

    it('caps how many metrics one report can carry', () => {
        const many = Object.fromEntries(
            Array.from({ length: MAX_METRICS + 20 }, (_, i) => [`stat${i}`, i])
        );
        assert.equal(normalizeMetrics(many).length, MAX_METRICS);
    });

    it('has no delta for a metric it is seeing for the first time', () => {
        // "gems went up by 1.2M" on the first ever report is an invented gain,
        // and on a farming dashboard it is the number someone would act on.
        const deltas = metricDeltas([{ key: 'gems', value: 100 }], [
            { key: 'gems', value: 175 },
            { key: 'coins', value: 40 },
            { key: 'rank', value: null },
        ]);
        assert.deepEqual(deltas, { gems: 75 });
    });

    it('puts only numeric readings in the history point', () => {
        const point = historyPoint([
            { key: 'gems', value: 5 },
            { key: 'rank', value: null },
        ], new Date(0));
        assert.deepEqual(point.values, [{ key: 'gems', value: 5 }]);
        assert.equal(point.at.getTime(), 0);
    });
});
