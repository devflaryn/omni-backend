import net from 'net';
import { miningConfig } from '../../config/mining.js';
import MinerSession from '../../models/minerSession.model.js';
import { recordAcceptedShare } from './accounting.js';

/**
 * A transparent bidirectional stratum relay. A miner (e.g. xmrig) connects
 * here as if this WERE the pool; the proxy opens a real connection to the
 * configured pool immediately, relays traffic in both directions, and
 * sniffs it to (a) rewrite the miner's login username to the pool wallet
 * (keyed by the miner's per-user token) and (b) count shares the POOL
 * actually accepted (never shares merely submitted) toward that user's
 * accrual.
 *
 * SECURITY: the miner is untrusted and fully controls the JSON-RPC `id` it
 * sends. Crediting must never be keyed on a miner-supplied id, or a miner
 * could mint credits by reusing an id from an earlier request the pool
 * happens to answer with `result:true` (e.g. re-authorize) without ever
 * submitting a valid share. To close this, every miner request id is
 * REWRITTEN to a proxy-assigned, per-connection monotonic id before it is
 * forwarded upstream; `pending` remembers what that id was for (in
 * particular, whether it was a submit, and the difficulty in effect at the
 * time). Only a pool response that lands on one of OUR ids, for an entry we
 * recorded as a submit, with `result === true` and no `error`, credits a
 * share — and that entry is removed on ANY response (accepted or not), so
 * an id can never be reused to trigger a second credit.
 *
 * Injectable deps make it testable without a real pool:
 *  - connectUpstream({ host, port }) -> a net.Socket-like duplex stream
 *  - resolveToken(raw) -> userId (defaults to MinerSession.resolveToken)
 */

// This is an unauthenticated raw TCP port. Bound the per-line buffer (a
// miner that never sends '\n' must not grow memory unbounded), the
// pre-connect send queue (a miner that floods before upstream connects must
// not grow memory unbounded either), and in-flight requests (a miner that
// floods submits faster than the pool's RTT must not grow the id-tracking
// map unbounded). Write backpressure (see writeToUpstream/writeToMiner
// below) bounds the last unbounded thing: a fast sender ballooning the
// destination socket's internal writable buffer.
const MAX_LINE = 64 * 1024;
const MAX_QUEUED = 1000;
// Exported so the test can flood exactly MAX_INFLIGHT + 1 requests without
// duplicating the constant.
export const MAX_INFLIGHT = 2000;

function parsePoolEndpoint(poolUrl) {
    const raw = String(poolUrl || '').trim();
    if (!raw) return { host: undefined, port: undefined };
    const [host, portStr] = raw.split(':');
    const port = portStr ? Number(portStr) : undefined;
    return { host: host || undefined, port: Number.isFinite(port) ? port : undefined };
}

// Fallback coin choice, used only when the miner's first message doesn't
// itself identify the coin (see routing below). If more than one pool is
// configured, rvn wins.
function chooseCoin(cfg) {
    if (cfg?.rvn?.poolUrl) return 'rvn';
    if (cfg?.xmr?.poolUrl) return 'xmr';
    return null;
}

// Routing is PER CONNECTION, decided by the miner's first message, so a
// CPU (xmr/RandomX) miner and a GPU (rvn/KawPow) miner can share one port:
//  - Monero-style stratum opens with `login` -> xmr.
//  - KawPow/stratum-v1 pools open with `mining.subscribe` -> rvn.
//  - Anything else (a pool protocol we don't specifically recognize) falls
//    back to chooseCoin(cfg), preserving the single-coin behavior.
function coinFromFirstMessage(msg, cfg) {
    if (msg?.method === 'login') return 'xmr';
    if (msg?.method === 'mining.subscribe') return 'rvn';
    return chooseCoin(cfg);
}

// Split a newline-delimited chunk into complete lines, carrying any partial
// trailing line forward in `buf`. `overflow` is set when the still-partial
// buffer has grown past MAX_LINE with no newline in sight — the caller
// should treat that as abusive input and tear the connection down.
function splitLines(buf, chunk) {
    buf += chunk.toString('utf8');
    const lines = [];
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
    }
    return { lines, buf, overflow: buf.length > MAX_LINE };
}

export function startStratumProxy({
    port = miningConfig().proxyBindPort,
    cfg = miningConfig(),
    resolveToken = (raw) => MinerSession.resolveToken(raw),
    connectUpstream = ({ host, port: p }) => net.connect(p, host),
} = {}) {
    const server = net.createServer((sock) => {
        // Coin/host/port/upstream are unknown until the miner's first message
        // is parsed (see the routing block inside sock.on('data') below) —
        // all four are resolved once, then held for the rest of the connection.
        let coin = null;
        let host, poolPort;
        let upstream = null;

        let userId = null;
        let currentDiff = 0;
        // The wallet-based username we authorized to the pool. The miner keeps
        // using its OWN worker name in every mining.submit params[0]; the pool
        // ties a submit to the connection's authorized worker, so the submit's
        // worker field must be rewritten to this too or the pool rejects the
        // share ("Malformed PoW result").
        let poolUsername = null;

        // Proxy-assigned ids for every miner request we forward upstream,
        // so acceptance can never be keyed on a miner-controlled id (see
        // the SECURITY note above). Popped (deleted) on ANY pool response,
        // accepted or not, so the map stays bounded and an id can never be
        // reused to trigger a second credit.
        let nextUpstreamId = 1;
        const pending = new Map(); // upstreamId -> { minerId, isSubmit, diffAtSubmit }

        let minerBuf = '';
        let poolBuf = '';
        let upstreamConnected = false;
        const sendQueue = []; // rewritten lines queued until upstream connects

        let destroyed = false;
        const teardown = () => {
            if (destroyed) return;
            destroyed = true;
            sock.destroy();
            upstream?.destroy?.();
        };

        // Write backpressure, both directions: if the destination socket's
        // writable buffer is full (write() returns false), pause the SOURCE
        // socket so it stops emitting more data until the destination has
        // drained, then resume it. Each direction guards against stacking
        // duplicate 'drain' listeners with its own `*Paused` flag — while
        // paused, the source emits no more 'data', so at most one drain
        // handler is ever pending per direction.
        let minerPausedForUpstream = false;
        function writeToUpstream(line) {
            if (!upstream) return false; // no upstream yet — caller must queue instead
            const ok = upstream.write(line + '\n');
            if (!ok && !minerPausedForUpstream) {
                minerPausedForUpstream = true;
                sock.pause();
                upstream.once('drain', () => {
                    minerPausedForUpstream = false;
                    sock.resume();
                    flushSendQueue();
                });
            }
            return ok;
        }
        // Drains the pre-connect queue onto the upstream socket, respecting
        // backpressure: stops as soon as a write is refused (writeToUpstream
        // has already arranged to resume us via 'drain') and picks back up
        // from where it left off once that fires.
        function flushSendQueue() {
            while (sendQueue.length) {
                const line = sendQueue.shift();
                if (!writeToUpstream(line)) return;
            }
        }

        let upstreamPausedForMiner = false;
        function writeToMiner(line) {
            const ok = sock.write(line + '\n');
            if (!ok && !upstreamPausedForMiner) {
                upstreamPausedForMiner = true;
                upstream?.pause?.();
                sock.once('drain', () => {
                    upstreamPausedForMiner = false;
                    upstream?.resume?.();
                });
            }
            return ok;
        }

        // Wires up the (now-created) upstream socket. Called once, the first
        // time a miner message resolves `coin`/`host`/`poolPort` and opens
        // the real pool connection (see the routing block in sock.on('data')
        // below) — never at connection accept time anymore.
        function attachUpstreamHandlers() {
            upstream.on('connect', () => {
                upstreamConnected = true;
                flushSendQueue();
            });

            upstream.on('data', (chunk) => {
                try {
                    const r = splitLines(poolBuf, chunk);
                    poolBuf = r.buf;
                    if (r.overflow) { teardown(); return; }
                    for (const line of r.lines) {
                        if (!line) continue;
                        let msg;
                        try { msg = JSON.parse(line); } catch { continue; } // drop malformed, never relay garbage

                        if (msg.method === 'mining.set_difficulty' && Array.isArray(msg.params)) {
                            const d = Number(msg.params[0]);
                            if (Number.isFinite(d)) currentDiff = d;
                            writeToMiner(line);
                            continue;
                        }

                        // KawPow/ProgPoW pools (Ravencoin at HeroMiners) do NOT send
                        // mining.set_difficulty — they encode the share difficulty in
                        // each job's TARGET (mining.notify params[3], a 256-bit hex).
                        // Derive it: difficulty = 2^256 / target. Without this the
                        // relay never learns the difficulty and every accepted share
                        // is valued at the diff=1 fallback (i.e. ~zero credits).
                        if (msg.method === 'mining.notify' && Array.isArray(msg.params)) {
                            const target = msg.params[3];
                            if (typeof target === 'string' && /^[0-9a-fA-F]{1,64}$/.test(target)) {
                                try {
                                    const t = BigInt('0x' + target);
                                    if (t > 0n) currentDiff = Number((1n << 256n) / t);
                                } catch { /* keep prior currentDiff */ }
                            }
                            writeToMiner(line);
                            continue;
                        }

                        if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
                            const entry = pending.get(msg.id);
                            pending.delete(msg.id); // remove on ANY response — bounds the map, kills id reuse
                            if (entry.isSubmit && msg.result === true && !msg.error && userId) {
                                recordAcceptedShare(String(userId), coin, entry.diffAtSubmit || currentDiff || 1);
                            }
                            writeToMiner(JSON.stringify({ ...msg, id: entry.minerId }));
                            continue;
                        }

                        // Pool-initiated request/notification not correlated to
                        // one of our forwarded ids — forward untouched.
                        writeToMiner(line);
                    }
                } catch (e) {
                    console.error('[mining] proxy pool->miner handler error', e?.message);
                    teardown();
                }
            });
            upstream.on('error', teardown);
            upstream.on('close', teardown);
        }

        sock.on('data', async (chunk) => {
            try {
                const r = splitLines(minerBuf, chunk);
                minerBuf = r.buf;
                if (r.overflow) { teardown(); return; }
                for (const line of r.lines) {
                    if (!line) continue;
                    let msg;
                    try { msg = JSON.parse(line); } catch { continue; } // drop malformed, never relay garbage

                    // PER-CONNECTION coin routing, decided by the miner's FIRST
                    // parsed message: resolve coin/host/port, open the real
                    // upstream pool connection (deferred until now — never at
                    // accept time), and wire its handlers. Every line before
                    // this point (there are none, since this runs on the very
                    // first parsed line) and every line after it flows through
                    // the existing queue-until-connected logic below unchanged.
                    if (!coin) {
                        coin = coinFromFirstMessage(msg, cfg);
                        if (!coin) { teardown(); return; }
                        const ep = parsePoolEndpoint(cfg[coin]?.poolUrl);
                        host = ep.host;
                        poolPort = ep.port;
                        if (!host || !poolPort) { teardown(); return; }
                        upstream = connectUpstream({ host, port: poolPort });
                        attachUpstreamHandlers();
                    }

                    if (msg.method === 'mining.authorize' || msg.method === 'login') {
                        const isLogin = msg.method === 'login';
                        const username = isLogin ? (msg.params?.login || '') : (msg.params?.[0] || '');
                        const [token] = String(username).split('.');
                        const resolved = await resolveToken(token);
                        if (!resolved) { teardown(); return; }
                        userId = resolved;
                        const workerTag = String(userId).slice(-8);
                        const wallet = cfg[coin]?.wallet;
                        const newUsername = `${wallet}.${workerTag}`;
                        poolUsername = newUsername;
                        msg.params = isLogin
                            ? { ...msg.params, login: newUsername }
                            : [newUsername, ...msg.params.slice(1)];
                    }

                    const isSubmit = msg.method === 'mining.submit' || msg.method === 'submit';
                    // Rewrite the submit's worker (params[0]) to the same
                    // wallet-based name we authorized with, so the pool accepts
                    // the share instead of rejecting it as malformed.
                    if (isSubmit && poolUsername && Array.isArray(msg.params) && msg.params.length > 0) {
                        msg.params = [poolUsername, ...msg.params.slice(1)];
                    }
                    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null;
                    if (hasId) {
                        if (pending.size >= MAX_INFLIGHT) {
                            console.error('[mining] proxy teardown: too_many_inflight');
                            teardown();
                            return;
                        }
                        const uid = nextUpstreamId++;
                        pending.set(uid, { minerId: msg.id, isSubmit, diffAtSubmit: currentDiff });
                        msg.id = uid;
                    }

                    const outLine = JSON.stringify(msg);
                    if (upstreamConnected) {
                        writeToUpstream(outLine);
                    } else {
                        if (sendQueue.length >= MAX_QUEUED) { teardown(); return; }
                        sendQueue.push(outLine);
                    }
                }
            } catch (e) {
                console.error('[mining] proxy miner->pool handler error', e?.message);
                teardown();
            }
        });
        sock.on('error', teardown);
        sock.on('close', teardown);
    });
    server.listen(port);
    return server;
}

export function stopStratumProxy(server) {
    return new Promise((resolve) => (server ? server.close(resolve) : resolve()));
}
