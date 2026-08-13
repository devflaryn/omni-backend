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
import { isLeaseFresh } from '../utils/presence.js';

const router = Router();

const queues    = new Map();   // channel -> [ {id, script, ts, ownerId} ]
const inFlight  = new Map();   // id -> {ownerId, ts} (handed to a poller, awaiting result)
const results   = new Map();   // id -> { channel, ownerId, ok, output, ts }
const lastPoll  = new Map();   // channel -> ts (liveness)
const sessions  = new Map();   // token -> { channel, ts }
let seq = 0;

const now = () => Date.now();
const MAX_SCRIPT = 200_000;                // 200 KB cap per script
const JOB_TTL = 5 * 60 * 1000;             // an undelivered job is stale after 5 min
const SESSION_TTL = 6 * 60 * 60 * 1000;    // a poll token outlives a long play session
const CONNECTED_MS = 8000;                 // "a poller answered this recently"

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

        const id = `${now().toString(36)}-${(++seq).toString(36)}`;
        const q = queues.get(channel) || [];
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
    if (r.ownerId && r.ownerId !== String(req.user._id)) {
        // Job ids are short and sequential enough to guess; the output of
        // someone else's script is theirs.
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

// in-game poller -> exchange a channel for a poll token
router.post('/claim', async (req, res, next) => {
    try {
        const channel = String(req.body?.channel ?? '').trim();
        if (!channel) return res.status(400).json({ ok: false, error: 'channel required' });
        const account = await RobloxAccount.findOne({ username: channel });
        if (!account || !isLeaseFresh(account.running)) {
            return res.status(403).json({
                ok: false, error: 'not_launched',
                message: 'No live launch is registered for this account.',
            });
        }
        const token = crypto.randomBytes(24).toString('base64url');
        sessions.set(token, { channel, ts: now() });
        res.json({ ok: true, token });
    } catch (error) { next(error); }
});

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
}, 60 * 1000).unref();

export default router;
