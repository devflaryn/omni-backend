/*
 * OMNI-EXEC remote-execute bridge.
 *
 * A tiny on-demand command queue so the Omni Executor GUI can run Luau in a LIVE
 * game session (manual — only when the user clicks Execute, never auto-exec):
 *
 *   GUI  --POST /omni/exec/submit {channel, script}-->  [queue]
 *   in-game custom UI  --POST /omni/exec/claim {channel}--> session token
 *   in-game custom UI  --GET /omni/exec/poll?t=--> pops the job, loadstring()s it
 *   in-game custom UI  --POST /omni/exec/result {id,ok,output,t}--> [results]
 *   GUI  --GET /omni/exec/result?id=--> shows ok/output
 *
 * `channel` is the account's Roblox USERNAME (the GUI knows it per account; the
 * in-game script reads game.Players.LocalPlayer.Name). State is in-memory
 * (single PM2 fork). Mounted at /omni/exec in server.js, before the static
 * catch-all.
 *
 * ---- WHO IS ALLOWED TO DO WHAT ----
 *
 * This used to be wide open: any caller who knew (or guessed) a username could
 * push Luau into that account's live session — including sessions belonging to
 * other people. Running arbitrary code in someone else's logged-in Roblox
 * client is about as far as a privilege boundary can be crossed, so:
 *
 *   submit / status / read-result  require a JWT, an active plan, and that the
 *                                  channel be an account THAT USER owns.
 *   poll / post-result             require a session token from /claim, which
 *                                  also fixes the channel — a token cannot be
 *                                  pointed at a different account.
 *   claim                          is granted only while the account's owner
 *                                  device holds a fresh "running" lease on it
 *                                  (see utils/presence.js) — i.e. only during a
 *                                  launch the owner actually started.
 *
 * The in-game poller has no user credential to present (it runs inside Roblox),
 * so /claim is deliberately the weakest link: a racing attacker who knew the
 * username and the exact launch window could obtain a poll token. What that
 * buys is nothing they can execute — the queue they would drain can only be
 * filled by the owner.
 */
import crypto from 'crypto';
import { Router } from 'express';

import authorize from '../middlewares/auth.middleware.js';
import requireActiveSubscription from '../middlewares/subscription.middleware.js';
import RobloxAccount from '../models/robloxAccount.model.js';


const router = Router();

const queues    = new Map();   // channel -> [ {id, script, ts, ownerId} ]
const inFlight  = new Map();   // id -> {ownerId, ts} (handed to a poller, awaiting result)
const results   = new Map();   // id -> { channel, ownerId, ok, output, ts }
const lastPoll  = new Map();   // channel -> ts (liveness)
const sessions  = new Map();   // token -> { channel, ts }
let seq = 0;

const now = () => Date.now();
const MAX_SCRIPT = 200_000;                // 200 KB cap per script
const MAX_QUEUED = 50;                     // pending scripts per channel
const JOB_TTL = 5 * 60 * 1000;             // an undelivered job is stale after 5 min
const SESSION_TTL = 6 * 60 * 60 * 1000;    // a poll token outlives a long play session
const CONNECTED_MS = 8000;                 // "a poller answered this recently"

// ---- AUTOEXEC -------------------------------------------------------------
//
// Scripts the host drops in its autoexec directory, which the omnidroid engine
// pushes here (keyed by the account's Roblox username) once per launch. The
// in-game UI GETs them at session start and runLuau()s each — the executor's
// own "autoexec folder", but sourced from the host and delivered over the one
// HTTP call every executor provides (game:HttpGet), so it does not depend on
// the executor exposing a writable workspace.
//
// SET is admin-gated (it runs code in a live session — the same privilege the
// submit queue guards with a JWT; here the host holds a shared secret instead,
// because the engine has no user credential). GET is public like /gist: the
// worst it leaks is the scripts a channel would already run, and a channel a
// stranger names simply has nothing stored.
const autoexecStore   = new Map();          // channel -> { scripts:[{name,body}], ts }
const AUTOEXEC_TTL    = 24 * 60 * 60 * 1000; // a stored bundle outlives a long session
const MAX_AUTOEXEC    = 25;                  // files per channel
const ADMIN_SECRET    = process.env.OMNI_EXEC_ADMIN_SECRET || 'omni-autoexec-dev-6f3a91';

/** The account row for `channel`, but only if `userId` owns it. */
function ownedAccount(userId, channel) {
    if (!channel) return null;
    return RobloxAccount.findOne({ owner: userId, username: channel });
}

function denyChannel(res, channel) {
    // Same answer whether the account exists under someone else or not at all:
    // a distinct 404 would make this endpoint an account-enumeration oracle.
    return res.status(403).json({
        ok: false,
        error: 'not_your_account',
        message: `'${channel}' is not one of your accounts.`,
    });
}

/** Resolve a poll token from query, body or header. Returns {channel} or null. */
function sessionFor(req) {
    const token = String(req.query?.t || req.body?.t || req.get('x-omni-exec-token') || '');
    if (!token) return null;
    const s = sessions.get(token);
    if (!s) return null;
    if (now() - s.ts > SESSION_TTL) { sessions.delete(token); return null; }
    return s;
}

// ---- GUI side: authenticated, paid, and owner-scoped -----------------------

const guiGate = [authorize, requireActiveSubscription];

// GUI -> queue a script for a channel
router.post('/submit', ...guiGate, async (req, res, next) => {
    try {
        const channel = String(req.body?.channel ?? '').trim();
        const script = req.body?.script;
        if (!channel || typeof script !== 'string' || !script.trim())
            return res.status(400).json({ ok: false, error: 'channel and non-empty script required' });
        if (script.length > MAX_SCRIPT)
            return res.status(413).json({ ok: false, error: 'script too large' });

        const account = await ownedAccount(req.user._id, channel);
        if (!account) return denyChannel(res, channel);

        const q = queues.get(channel) || [];
        if (q.length >= MAX_QUEUED) {
            // An account with no live poller accumulates everything sent to it
            // until the TTL sweeps it. Bounded so a user hammering Run against
            // a session that never loaded cannot grow this process's memory by
            // 200 KB a click for five minutes.
            return res.status(429).json({
                ok: false, error: 'queue_full',
                message: `'${channel}' already has ${q.length} scripts waiting — `
                    + `is the in-game UI loaded?`,
            });
        }

        const id = `${now().toString(36)}-${(++seq).toString(36)}`;
        q.push({ id, script, ts: now(), ownerId: String(req.user._id) });
        queues.set(channel, q);
        const last = lastPoll.get(channel);
        res.json({ ok: true, id, queued: q.length, connected: !!(last && now() - last < CONNECTED_MS) });
    } catch (error) { next(error); }
});

// GUI -> read result of a submitted job
router.get('/result', ...guiGate, (req, res) => {
    const id = String(req.query.id || '');
    const r = results.get(id);
    if (!r) return res.json({ done: false });
    // Fails CLOSED on a null owner. A result whose submitter can no longer be
    // established (its in-flight record aged out before the poller answered) is
    // not "public" — and job ids are short and sequential enough to guess, so
    // treating unknown as allowed would be a readable hole in the wall.
    if (r.ownerId !== String(req.user._id)) {
        return res.status(403).json({ ok: false, error: 'not_your_job' });
    }
    res.json({ done: true, ok: r.ok, output: r.output });
});

// GUI -> is an in-game poller alive for this channel? how many pending?
router.get('/status', ...guiGate, async (req, res, next) => {
    try {
        const channel = String(req.query.channel || '');
        const account = await ownedAccount(req.user._id, channel);
        if (!account) return denyChannel(res, channel);
        const last = lastPoll.get(channel);
        res.json({
            ok: true,
            connected: !!(last && now() - last < CONNECTED_MS),
            lastPollMsAgo: last ? now() - last : null,
            pending: (queues.get(channel) || []).length,
        });
    } catch (error) { next(error); }
});

// ---- in-game side: session token, gated on a live owner launch -------------

/*
 * Claim is reachable by GET as well as POST, and that is not tidiness.
 *
 * The in-game script runs inside Roblox, where the only HTTP call guaranteed
 * to exist is `game:HttpGet` — a GET. A POST needs an executor-provided
 * `syn.request`/`http.request`/`request`, and this executor does not always
 * expose one. Requiring POST to claim meant the poller sat in its claim loop
 * forever and never reached the polling code at all: `lastPollMsAgo: null`
 * with jobs queued, reported as "No live session" while the game was plainly
 * loaded. The old poller only ever needed HttpGet, so requiring more was a
 * regression.
 */
async function claim(req, res, next) {
    try {
        const channel = String(req.query?.channel ?? req.body?.channel ?? '').trim();
        if (!channel) return res.status(400).json({ ok: false, error: 'channel required' });
        // The account must EXIST. It used to have to be under a fresh
        // "running" lease as well, and that was over-tight: the lease is
        // renewed only by the desktop app's heartbeat, so an instance launched
        // from the CLI, or with the app closed, or before the first sync, could
        // not be claimed — the in-game poller never got a token and the editor
        // reported "No live session" over a game that was plainly loaded.
        //
        // Dropping it costs little. The wall is on SUBMIT, which needs a JWT,
        // an active plan, and ownership of the channel. A poll token on its own
        // drains a queue that only the owner can fill, so the worst a stranger
        // who guesses a username can do is receive nothing.
        const account = await RobloxAccount.findOne({ username: channel });
        if (!account) {
            return res.status(403).json({
                ok: false, error: 'unknown_account',
                message: 'No such account is registered.',
            });
        }
        const token = crypto.randomBytes(24).toString('base64url');
        sessions.set(token, { channel, ts: now() });
        res.json({ ok: true, token });
    } catch (error) { next(error); }
}

router.get('/claim', claim);
router.post('/claim', claim);

// in-game poller -> next pending job (removed on delivery)
router.get('/poll', (req, res) => {
    const s = sessionFor(req);
    if (!s) return res.status(403).json({ ok: false, error: 'no_session' });
    lastPoll.set(s.channel, now());
    const q = queues.get(s.channel);
    if (!q || !q.length) return res.json({});
    const job = q.shift();
    inFlight.set(job.id, { ownerId: job.ownerId, ts: now() });   // who to show the result to
    res.json({ id: job.id, script: job.script });
});

/*
 * GET twin of the result post, for the same reason claim has one: reporting
 * needs an executor-provided POST, and when the executor has none the script
 * still RUNS but its output never comes back — the editor shows "no result
 * yet" for a job that finished. Output is truncated hard because this rides in
 * a query string.
 */
router.get('/report', (req, res) => {
    const s = sessionFor(req);
    if (!s) return res.status(403).json({ ok: false, error: 'no_session' });
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    results.set(id, {
        channel: s.channel,
        ownerId: inFlight.get(id)?.ownerId ?? null,
        ok: String(req.query.ok) === 'true',
        output: String(req.query.output ?? '').slice(0, 2000),
        ts: now(),
    });
    inFlight.delete(id);
    res.json({ ok: true });
});

// in-game poller -> report result
router.post('/result', (req, res) => {
    const s = sessionFor(req);
    if (!s) return res.status(403).json({ ok: false, error: 'no_session' });
    const id = String(req.body?.id || '');
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    results.set(id, {
        channel: s.channel,
        ownerId: inFlight.get(id)?.ownerId ?? null,
        ok: !!req.body?.ok,
        output: String(req.body?.output ?? '').slice(0, 8000),
        ts: now(),
    });
    inFlight.delete(id);
    res.json({ ok: true });
});

// ---- autoexec: host engine SETs the bundle (admin-gated) -------------------
router.post('/autoexec/set', (req, res) => {
    if ((req.get('x-omni-admin') || '') !== ADMIN_SECRET) {
        return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const channel = String(req.body?.channel ?? '').trim();
    if (!channel) return res.status(400).json({ ok: false, error: 'channel required' });
    const raw = Array.isArray(req.body?.scripts) ? req.body.scripts : [];
    const scripts = raw
        .filter(s => s && typeof s.body === 'string' && s.body.trim())
        .slice(0, MAX_AUTOEXEC)
        .map(s => ({
            name: String(s.name ?? 'script').slice(0, 120),
            body: String(s.body).slice(0, MAX_SCRIPT),
        }));
    if (scripts.length) {
        autoexecStore.set(channel, { scripts, ts: now() });
    } else {
        // An empty push CLEARS a channel — dropping every file from the host
        // dir has to actually stop them running, not leave the last set stuck.
        autoexecStore.delete(channel);
    }
    res.json({ ok: true, channel, count: scripts.length });
});

// ---- autoexec: in-game GETs the bundle at session start (public, like /gist)
router.get('/autoexec', (req, res) => {
    const channel = String(req.query?.channel ?? '').trim()
        || (sessionFor(req)?.channel ?? '');
    const entry = channel ? autoexecStore.get(channel) : null;
    const scripts = (entry && now() - entry.ts < AUTOEXEC_TTL) ? entry.scripts : [];
    res.set('Access-Control-Allow-Origin', '*');
    res.json({ ok: true, channel, scripts });
});

// housekeeping: drop jobs/results/sessions past their TTL so memory can't grow
// unbounded
setInterval(() => {
    const cutoff = now() - JOB_TTL;
    for (const [id, r] of results) if (r.ts < cutoff) results.delete(id);
    // A poller that took a job and died never posts a result; drop the claim.
    for (const [id, f] of inFlight) if (f.ts < cutoff) inFlight.delete(id);
    for (const [ch, q] of queues) {
        const fresh = q.filter(j => j.ts > cutoff);
        if (fresh.length) queues.set(ch, fresh); else queues.delete(ch);
    }
    const sessionCutoff = now() - SESSION_TTL;
    for (const [t, s] of sessions) if (s.ts < sessionCutoff) sessions.delete(t);
    const autoexecCutoff = now() - AUTOEXEC_TTL;
    for (const [ch, e] of autoexecStore) if (e.ts < autoexecCutoff) autoexecStore.delete(ch);
}, 60 * 1000).unref();

export default router;
