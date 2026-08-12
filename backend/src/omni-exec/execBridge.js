/*
 * OMNI-EXEC remote-execute bridge.
 *
 * A tiny on-demand command queue so the Omni Executor GUI can run Luau in a LIVE
 * game session (manual — only when the user clicks Execute, never auto-exec):
 *
 *   GUI  --POST /omni/exec/submit {channel, script}-->  [queue]
 *   in-game custom UI  --GET /omni/exec/poll?channel=--> pops the job, loadstring()s it
 *   in-game custom UI  --POST /omni/exec/result {id,ok,output}--> [results]
 *   GUI  --GET /omni/exec/result?id=--> shows ok/output
 *
 * `channel` is the account's Roblox UserId (the GUI knows it per account; the in-game
 * script reads game.Players.LocalPlayer.UserId). State is in-memory (single PM2 fork).
 * Mounted at /omni/exec in server.js, before the static catch-all.
 */
import { Router } from 'express';

const router = Router();

const queues   = new Map();   // channel -> [ {id, script, ts} ]
const results  = new Map();   // id -> { channel, ok, output, ts }
const lastPoll = new Map();   // channel -> ts (liveness)
let seq = 0;
const now = () => Date.now();
const MAX_SCRIPT = 200_000;   // 200 KB cap per script

// GUI -> queue a script for a channel
router.post('/submit', (req, res) => {
  const channel = String((req.body && req.body.channel) ?? '').trim();
  const script  = (req.body && req.body.script);
  if (!channel || typeof script !== 'string' || !script.trim())
    return res.status(400).json({ ok: false, error: 'channel and non-empty script required' });
  if (script.length > MAX_SCRIPT)
    return res.status(413).json({ ok: false, error: 'script too large' });
  const id = `${now().toString(36)}-${(++seq).toString(36)}`;
  const q = queues.get(channel) || [];
  q.push({ id, script, ts: now() });
  queues.set(channel, q);
  const last = lastPoll.get(channel);
  res.json({ ok: true, id, queued: q.length, connected: !!(last && now() - last < 8000) });
});

// in-game poller -> next pending job (removed on delivery)
router.get('/poll', (req, res) => {
  const channel = String(req.query.channel || '');
  lastPoll.set(channel, now());
  const q = queues.get(channel);
  if (!q || !q.length) return res.json({});
  const job = q.shift();
  res.json({ id: job.id, script: job.script });
});

// in-game poller -> report result
router.post('/result', (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '');
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });
  results.set(id, {
    channel: String(b.channel || ''),
    ok: !!b.ok,
    output: String(b.output ?? '').slice(0, 8000),
    ts: now(),
  });
  res.json({ ok: true });
});

// GUI -> read result of a submitted job
router.get('/result', (req, res) => {
  const r = results.get(String(req.query.id || ''));
  if (!r) return res.json({ done: false });
  res.json({ done: true, ok: r.ok, output: r.output });
});

// GUI -> is an in-game poller alive for this channel? how many pending?
router.get('/status', (req, res) => {
  const channel = String(req.query.channel || '');
  const last = lastPoll.get(channel);
  res.json({
    ok: true,
    connected: !!(last && now() - last < 8000),
    lastPollMsAgo: last ? now() - last : null,
    pending: (queues.get(channel) || []).length,
  });
});

// housekeeping: drop jobs/results older than 5 min so memory can't grow unbounded
setInterval(() => {
  const cutoff = now() - 5 * 60 * 1000;
  for (const [id, r] of results) if (r.ts < cutoff) results.delete(id);
  for (const [ch, q] of queues) {
    const fresh = q.filter(j => j.ts > cutoff);
    if (fresh.length) queues.set(ch, fresh); else queues.delete(ch);
  }
}, 60 * 1000).unref();

export default router;
