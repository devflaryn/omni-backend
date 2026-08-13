import mongoose from 'mongoose';

/*
 * A Roblox account owned by ONE Omni user.
 *
 * This is the record that used to live only in omnidroid's local accounts.json,
 * which meant a machine was the unit of ownership: whoever sat at that computer
 * had every cookie on it, and moving to another machine meant re-logging in
 * everything. Hosting it here makes the OMNI USER the unit of ownership — the
 * same login on Windows, macOS or Linux sees the same accounts — and gives the
 * exec bridge something to check before it will run a script against a session.
 *
 * The cookie is stored SEALED (AES-256-GCM, utils/secretBox.js), never raw.
 */
const runningSchema = new mongoose.Schema({
    // Stable per-installation id the desktop app generates once and reuses.
    deviceId: { type: String, default: null },
    // What a human calls that machine ("Mac mini", "berat-PC") — this is the
    // string the UI renders as "Running on Mac mini".
    deviceName: { type: String, default: null },
    os: { type: String, default: null },          // win32 | darwin | linux
    mode: { type: String, default: null },        // playable | farming | ...
    placeId: { type: String, default: null },
    since: { type: Date, default: null },
    // Presence is a LEASE, not a flag: a machine that crashes or loses power
    // never sends "stopped", so a bare boolean would strand the account as
    // "Running" forever. Anything older than RUNNING_LEASE_MS is stale and
    // reported as stopped (see utils/presence.js).
    heartbeatAt: { type: Date, default: null },
}, { _id: false });

const robloxAccountSchema = new mongoose.Schema({
    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    username: {                                   // the Roblox login name; the identity everywhere
        type: String,
        required: true,
        trim: true,
    },
    userId: { type: Number, default: null },      // Roblox numeric id
    displayName: { type: String, default: null },
    customName: { type: String, default: null },
    cookie: { type: String, default: null },      // SEALED .ROBLOSECURITY
    // sha256 of the PLAINTEXT cookie. Safe to publish (it is a hash of a
    // high-entropy secret) and it is what makes sync converge: the sealed blob
    // differs on every write because the nonce does, so comparing ciphertext
    // could never tell "same cookie" from "re-uploaded cookie", and the two
    // stores would push and pull the same value forever.
    cookieHash: { type: String, default: null },
    cookieUpdatedAt: { type: Date, default: null },
    placeId: { type: String, default: null },
    group: { type: String, default: null },
    notes: { type: String, default: null },
    running: { type: runningSchema, default: () => ({}) },
}, { timestamps: true });

// Two different users may both own an account called "farm3" (they are different
// Roblox accounts, or the same one shared deliberately); one user may not have
// two rows for the same username.
robloxAccountSchema.index({ owner: 1, username: 1 }, { unique: true });

// Ownership lookups from the exec bridge go by username alone, then filter by
// owner — this index keeps that a point lookup rather than a collection scan.
robloxAccountSchema.index({ username: 1 });

robloxAccountSchema.set('toJSON', {
    transform(_doc, ret) {
        delete ret.cookie;      // never leaves through a list/get response
        return ret;
    },
});

const RobloxAccount = mongoose.model('RobloxAccount', robloxAccountSchema);

export default RobloxAccount;
