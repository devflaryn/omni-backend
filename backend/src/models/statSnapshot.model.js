import mongoose from 'mongoose';

import { MAX_HISTORY } from '../utils/statMetrics.js';

/*
 * STAT TRACK — the last thing an account reported from inside the game.
 *
 * One document per (owner, roblox username), overwritten in place. It is a
 * SNAPSHOT and not a log on purpose: the question the dashboard asks is "what
 * does this account have right now, and is it still climbing", which needs the
 * latest reading plus enough recent ones to draw a line — not every reading
 * ever taken. A farming fleet of 25 accounts reporting every 20 seconds writes
 * 108,000 documents a day if this were a log, to answer a question that only
 * ever looks at the tail.
 *
 * `history` is that tail, capped by $slice at write time (MAX_HISTORY), so the
 * document has a hard ceiling and no sweeper is needed to keep it there.
 *
 * WHO WRITES THIS. The in-game script (payloads/stattrack.lua) via the exec
 * bridge's /omni/exec/stats, authenticated by the same session token the
 * remote-execute poller claims. It carries no user credential — it runs inside
 * Roblox — so the OWNER is resolved from the account row the channel names,
 * never sent by the client. A report for an account nobody owns is dropped.
 */

const metricSchema = new mongoose.Schema({
    key: { type: String, required: true },     // slugged; the identity across reports
    label: { type: String, default: '' },      // what the game called it
    // Both readings are kept. See utils/statMetrics.js: `display` is the string
    // the player sees, `value` is the parse, and null means "not a number" —
    // which is different from zero and must never be rendered as zero.
    value: { type: Number, default: null },
    display: { type: String, default: '' },
    source: { type: String, default: 'script' },
}, { _id: false });

const historySchema = new mongoose.Schema({
    at: { type: Date, required: true },
    values: [{
        _id: false,
        key: String,
        value: Number,
    }],
}, { _id: false });

const statSnapshotSchema = new mongoose.Schema({
    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    username: { type: String, required: true, trim: true },   // the Roblox login name
    userId: { type: Number, default: null },
    displayName: { type: String, default: null },

    // Where the reading came from. placeId is the game; jobId is the server
    // instance, which is what tells two reports from the same account apart
    // when it hops servers.
    placeId: { type: String, default: null },
    placeName: { type: String, default: null },
    jobId: { type: String, default: null },

    metrics: { type: [metricSchema], default: [] },
    history: { type: [historySchema], default: [] },

    // The session as the CLIENT sees it, which is the only place that knows.
    // uptimeSec is reported rather than derived from timestamps because a
    // report can be delayed by a slow guest and "in-game for 4 minutes" must
    // not drift into "in-game for 9 minutes" because the network was bad.
    sessionStartedAt: { type: Date, default: null },
    uptimeSec: { type: Number, default: null },

    executor: { type: String, default: null },      // what ran the script
    scriptVersion: { type: String, default: null },

    reportedAt: { type: Date, default: null, index: true },
    reportCount: { type: Number, default: 0 },
}, { timestamps: true });

// One snapshot per account per owner. The upsert relies on this: two reports
// racing from a rejoin must collide on the index rather than create a second
// row that the dashboard would then show as a duplicate account.
statSnapshotSchema.index({ owner: 1, username: 1 }, { unique: true });

/**
 * How stale is a reading? The dashboard renders "live" from this rather than
 * from the account's running lease, because those answer different questions:
 * the lease says a VM is up, this says the SCRIPT inside it is talking. An
 * instance whose client crashed keeps its lease for a minute and stops
 * reporting immediately, and "still farming" is the claim that matters.
 */
export const STAT_FRESH_MS = 90_000;    // ~4 missed reports at 20 s

export function isStatFresh(snapshot, now = Date.now()) {
    const at = snapshot?.reportedAt ? new Date(snapshot.reportedAt).getTime() : 0;
    return at > 0 && now - at < STAT_FRESH_MS;
}

export { MAX_HISTORY };

const StatSnapshot = mongoose.model('StatSnapshot', statSnapshotSchema);

export default StatSnapshot;
