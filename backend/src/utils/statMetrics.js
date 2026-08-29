/*
 * Normalising what a Roblox game calls a number.
 *
 * The in-game collector (payloads/stattrack.lua) is deliberately generic: it
 * scrapes leaderstats, attributes and any currency-shaped value it can reach,
 * because every game stores its money somewhere different and none of them
 * agree. That means what arrives here is UNTRUSTED IN SHAPE as well as in
 * origin — a metric may be a string ("1.2M"), a float, a bool, or absent — and
 * the dashboard still has to render one tidy row per stat.
 *
 * So the rule is: keep BOTH readings. `display` is whatever the game showed
 * (that is the number the user recognises), `value` is the numeric parse or
 * null (that is what a delta and a chart need). Neither is derived from the
 * other at render time, because "1.2M" -> 1200000 is a guess and 1200000 ->
 * "1.2M" is a formatting choice, and getting either wrong silently makes a
 * dashboard that lies about someone's currency.
 *
 * Pure functions, no mongoose: this is the half of Stat Track that can be
 * tested without a database.
 */

// A key is a stable identity across reports, so it is slugged hard: the same
// stat must not split into two rows because the game renamed "Gems " to "Gems".
const KEY_RE = /[^a-z0-9_]+/g;

export const MAX_METRICS = 40;          // per report; a game with more is a bug
export const MAX_HISTORY = 120;         // ~40 min at one report per 20 s
const MAX_LABEL = 64;
const MAX_DISPLAY = 48;

export function slugKey(name) {
    const slug = String(name ?? '').trim().toLowerCase().replace(KEY_RE, '_').replace(/^_+|_+$/g, '');
    return slug.slice(0, 48);
}

/**
 * "1.2M" / "3,400" / "1.5k" -> a number, or null when it is not one.
 *
 * Suffix parsing is case-insensitive and deliberately short: k/m/b/t is what
 * Roblox UIs abbreviate with. Anything else (a rank name, a pet name, a time
 * string) has no numeric reading and gets null rather than a fabricated 0 —
 * a 0 would show up as a real value that dropped to nothing.
 */
const SUFFIX = { k: 1e3, m: 1e6, b: 1e9, t: 1e12, q: 1e15 };

export function parseNumeric(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw === 'boolean') return raw ? 1 : 0;
    if (typeof raw !== 'string') return null;
    const text = raw.trim().replace(/,/g, '');
    if (!text) return null;
    const m = /^([+-]?\d+(?:\.\d+)?)\s*([a-zA-Z]?)$/.exec(text);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    const suffix = m[2] ? SUFFIX[m[2].toLowerCase()] : 1;
    return suffix ? n * suffix : null;
}

/**
 * One incoming metric -> the stored shape, or null if there is nothing in it.
 *
 * A metric with neither a numeric value nor a display string is dropped: an
 * empty row is worse than a missing one, because it takes up space on the
 * dashboard while saying nothing.
 */
export function normalizeMetric(item) {
    if (!item || typeof item !== 'object') return null;
    const key = slugKey(item.key ?? item.name ?? item.label);
    if (!key) return null;

    const rawValue = item.value !== undefined ? item.value : item.display;
    const value = parseNumeric(rawValue);
    const display = item.display !== undefined && item.display !== null
        ? String(item.display).slice(0, MAX_DISPLAY)
        : (rawValue === undefined || rawValue === null ? '' : String(rawValue).slice(0, MAX_DISPLAY));

    if (value === null && !display) return null;

    return {
        key,
        label: String(item.label ?? item.name ?? item.key ?? key).slice(0, MAX_LABEL),
        value,
        display,
        source: String(item.source ?? 'script').slice(0, 24),
    };
}

/**
 * A whole report's metrics. Accepts either an array of {key,value} objects or
 * a plain {gems: 1200} map, because the Lua side finds it far easier to build
 * a map and an array is what everything downstream wants.
 *
 * FIRST WRITER WINS on a duplicate key. leaderstats is collected before the
 * attribute sweep and the currency guess, so the reading a game actually put
 * on screen beats a same-named value found somewhere deeper.
 */
export function normalizeMetrics(raw) {
    const items = Array.isArray(raw)
        ? raw
        : (raw && typeof raw === 'object'
            ? Object.entries(raw).map(([key, value]) => ({ key, value }))
            : []);

    const out = [];
    const seen = new Set();
    for (const item of items) {
        const metric = normalizeMetric(item);
        if (!metric || seen.has(metric.key)) continue;
        seen.add(metric.key);
        out.push(metric);
        if (out.length >= MAX_METRICS) break;
    }
    return out;
}

/**
 * What changed between two reports, keyed by metric.
 *
 * Only numeric metrics can have a delta, and a metric that is new in `next`
 * has none either — "gems went up by 1.2M" the first time we ever saw gems is
 * an invented gain, and on a farming dashboard that is the one number someone
 * would actually act on.
 */
export function metricDeltas(previous, next) {
    const before = new Map((previous || []).map((m) => [m.key, m]));
    const out = {};
    for (const m of next || []) {
        const was = before.get(m.key);
        if (!was || was.value === null || m.value === null) continue;
        out[m.key] = m.value - was.value;
    }
    return out;
}

/** A history entry: the numeric readings only, which is all a chart needs. */
export function historyPoint(metrics, at = new Date()) {
    return {
        at,
        values: (metrics || [])
            .filter((m) => m.value !== null && m.value !== undefined)
            .map((m) => ({ key: m.key, value: m.value })),
    };
}
