/*
 * STAT TRACK — ingest from inside the game, and read back for a dashboard.
 *
 * The two halves have completely different callers and therefore completely
 * different gates:
 *
 *   INGEST  is called by payloads/stattrack.lua running inside a Roblox client.
 *           It has no user credential and never will — it holds only the exec
 *           bridge session token, which fixes the CHANNEL (a Roblox username).
 *           The owner is looked up from that channel; nothing about identity is
 *           taken from the request body. Mounted on the exec bridge (not /api)
 *           so arcjet's bot detection never sees it, for the same reason the
 *           remote-execute poller lives there.
 *
 *   READ    is called by the desktop app and the website with a JWT, and is
 *           owner-scoped by query. It is the premium feature: a free account
 *           gets 402 and the client renders the locked state.
 *
 * PREMIUM IS ENFORCED ON INGEST TOO, not only on read. Storing reports for an
 * account that cannot look at them would be a write path a free account can
 * drive at will, and the point of gating a feature server-side is that turning
 * off the client does not turn off the cost.
 */
import RobloxAccount from '../models/robloxAccount.model.js';
import StatSnapshot, { MAX_HISTORY, isStatFresh } from '../models/statSnapshot.model.js';
import { presenceView } from '../utils/presence.js';
import { isSubscriptionActive } from '../utils/applyLicenseKey.js';
import { normalizeMetrics, metricDeltas, historyPoint } from '../utils/statMetrics.js';

const MAX_TEXT = 120;

const text = (v) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, MAX_TEXT));

function httpError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

/**
 * Ingest one report for `channel`.
 *
 * Returns a plain result object rather than touching `res`, so the exec bridge
 * can answer the GET and POST forms identically — the in-game script uses
 * whichever of the two the executor gives it, and a report that succeeded over
 * one shape and failed over the other would be the worst kind of bug to chase.
 *
 * Never throws for a normal refusal: every "no" is a status the script reads
 * and reacts to (`stop` tells it to give up rather than retry forever).
 */
export async function recordReport(channel, payload) {
    const username = String(channel || '').trim();
    if (!username) return { status: 400, body: { ok: false, error: 'channel_required' } };

    // The channel names a Roblox account; the OWNER comes from that row. A
    // report for an account no Omni user has claimed is dropped rather than
    // stored against nobody.
    const account = await RobloxAccount.findOne({ username }).populate('owner');
    if (!account || !account.owner) {
        return { status: 404, body: { ok: false, error: 'unknown_account', stop: true } };
    }
    if (!isSubscriptionActive(account.owner.subscription)) {
        return {
            status: 402,
            body: {
                ok: false,
                error: 'subscription_inactive',
                stop: true,      // the script stops reporting instead of retrying
                message: 'Stat Track is a premium feature.',
            },
        };
    }

    const metrics = normalizeMetrics(payload?.metrics ?? payload?.stats);
    const now = new Date();

    const existing = await StatSnapshot.findOne({ owner: account.owner._id, username });
    const deltas = metricDeltas(existing?.metrics, metrics);

    const set = {
        owner: account.owner._id,
        username,
        metrics,
        reportedAt: now,
    };

    // ABSENT IS NOT NULL. Only fields the report actually carried are written:
    // the collector fills placeName from a MarketplaceService lookup that can
    // fail on any given tick, and a plain $set of every field would let one
    // such tick blank a name the dashboard had been showing for an hour. The
    // rule reads the same for every optional field so the next one added
    // inherits it.
    const optional = {
        displayName: text(payload?.displayName),
        placeId: text(payload?.placeId),
        placeName: text(payload?.placeName),
        jobId: text(payload?.jobId),
        executor: text(payload?.executor),
        scriptVersion: text(payload?.scriptVersion),
    };
    for (const [field, value] of Object.entries(optional)) {
        if (value !== null) set[field] = value;
    }

    const userId = payload?.userId !== undefined && payload?.userId !== null
        ? Number(payload.userId) || null
        : null;
    if (userId !== null) set.userId = userId;

    const uptimeSec = Number.isFinite(Number(payload?.uptimeSec)) ? Number(payload.uptimeSec) : null;
    if (uptimeSec !== null) {
        set.uptimeSec = uptimeSec;
        // Derived here rather than trusted from the client: a session start
        // that moves backwards on every report would make "in-game for" grow
        // forever.
        set.sessionStartedAt = new Date(now.getTime() - uptimeSec * 1000);
    }

    // What the account row already knows fills the gaps on FIRST insert only,
    // so a report never has to re-send what the cloud store already has.
    const onInsert = {};
    if (set.userId === undefined && account.userId != null) onInsert.userId = account.userId;
    if (set.displayName === undefined && account.displayName) onInsert.displayName = account.displayName;
    if (set.placeId === undefined && account.placeId) onInsert.placeId = account.placeId;

    const update = {
        $set: set,
        $inc: { reportCount: 1 },
    };
    if (Object.keys(onInsert).length) update.$setOnInsert = onInsert;
    // Only numeric readings go into history, and only when there are any —
    // $push with an empty array still rewrites the field.
    const point = historyPoint(metrics, now);
    if (point.values.length) {
        update.$push = { history: { $each: [point], $slice: -MAX_HISTORY } };
    }

    await StatSnapshot.updateOne(
        { owner: account.owner._id, username },
        update,
        { upsert: true, setDefaultsOnInsert: true }
    );

    return {
        status: 200,
        body: {
            ok: true,
            channel: username,
            metrics: metrics.length,
            deltas,
            // How long the script should wait before reporting again. Sent by
            // the server so the interval can be tuned without reshipping a
            // script that is already baked into a running fleet.
            nextInSec: 20,
        },
    };
}

/** The shape both dashboards render one row from. */
function snapshotView(snapshot, account, viewerDeviceId, now = Date.now()) {
    const presence = account ? presenceView(account, viewerDeviceId, now) : null;
    return {
        username: snapshot?.username ?? account?.username ?? null,
        userId: snapshot?.userId ?? account?.userId ?? null,
        displayName: snapshot?.displayName ?? account?.displayName ?? null,
        customName: account?.customName ?? null,
        // "Is a VM up" and "is the script talking" are different facts and the
        // UI needs both: an instance can be running with a dead client, which
        // is exactly the state a farming dashboard exists to catch.
        presence,
        tracking: snapshot ? isStatFresh(snapshot, now) : false,
        placeId: snapshot?.placeId ?? account?.placeId ?? null,
        placeName: snapshot?.placeName ?? null,
        jobId: snapshot?.jobId ?? null,
        metrics: snapshot?.metrics ?? [],
        uptimeSec: snapshot?.uptimeSec ?? null,
        executor: snapshot?.executor ?? null,
        reportedAt: snapshot?.reportedAt ?? null,
        reportCount: snapshot?.reportCount ?? 0,
    };
}

/**
 * GET /api/v1/stats — every account this user owns, with its latest reading.
 *
 * Accounts that have never reported are INCLUDED, with `tracking: false`. A
 * dashboard that lists only the accounts already reporting cannot show you the
 * one that stopped, which is the row you came to look at.
 */
export const listStats = async (req, res, next) => {
    try {
        const deviceId = (req.headers['x-omni-device-id'] || '').toString().slice(0, 128) || null;
        const [accounts, snapshots] = await Promise.all([
            RobloxAccount.find({ owner: req.user._id }).sort({ username: 1 }),
            StatSnapshot.find({ owner: req.user._id }).select('-history'),
        ]);
        const byName = new Map(snapshots.map((s) => [s.username, s]));
        const now = Date.now();
        const rows = accounts.map((a) => snapshotView(byName.get(a.username), a, deviceId, now));

        res.status(200).json({
            success: true,
            data: {
                accounts: rows,
                summary: {
                    accounts: rows.length,
                    online: rows.filter((r) => r.presence?.state === 'running').length,
                    tracking: rows.filter((r) => r.tracking).length,
                },
            },
        });
    } catch (error) {
        next(error);
    }
};

/** GET /api/v1/stats/:username — one account, with its recent history. */
export const getAccountStats = async (req, res, next) => {
    try {
        const username = String(req.params.username || '').trim();
        const deviceId = (req.headers['x-omni-device-id'] || '').toString().slice(0, 128) || null;
        const [account, snapshot] = await Promise.all([
            RobloxAccount.findOne({ owner: req.user._id, username }),
            StatSnapshot.findOne({ owner: req.user._id, username }),
        ]);
        if (!account && !snapshot) throw httpError('Account not found', 404);

        res.status(200).json({
            success: true,
            data: {
                account: snapshotView(snapshot, account, deviceId),
                history: snapshot?.history ?? [],
            },
        });
    } catch (error) {
        next(error);
    }
};

/** DELETE /api/v1/stats/:username — forget what one account reported. */
export const clearAccountStats = async (req, res, next) => {
    try {
        const username = String(req.params.username || '').trim();
        const result = await StatSnapshot.deleteOne({ owner: req.user._id, username });
        res.status(200).json({ success: true, data: { deleted: result.deletedCount } });
    } catch (error) {
        next(error);
    }
};
