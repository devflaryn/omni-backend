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

// Which coin to relay for. Only one pool is active per proxy instance today
// (the beta ships RVN only); if more than one is ever configured at once,
// rvn wins.
function chooseCoin(cfg) {
    if (cfg?.rvn?.poolUrl) return 'rvn';
    if (cfg?.xmr?.poolUrl) return 'xmr';
    return null;
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
    // Real pools (observed against HeroMiners RVN) periodically close their
    // end of an otherwise-healthy long-lived stratum connection. Losing the
    // upstream must never surface as a disconnect to the miner: we
    // reconnect transparently after a short backoff. Configurable so tests
    // don't have to wait out a real-world backoff.
    reconnectDelayMs = 2000,
} = {}) {
    const server = net.createServer((sock) => {
        const coin = chooseCoin(cfg);
        if (!coin) { sock.destroy(); return; }
        const { host, port: poolPort } = parsePoolEndpoint(cfg[coin]?.poolUrl);
        if (!host || !poolPort) { sock.destroy(); return; }

        let userId = null;
        let currentDiff = 0;

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

        // The most recent OUTBOUND handshake lines the miner sent (after
        // id-rewrite and, for authorize/login, wallet-rewrite) — i.e.
        // exactly what the pool actually saw. Replayed against a fresh
        // upstream socket after a reconnect so the new connection ends up
        // in the same state the old one was in, without the miner having
        // to do anything.
        let handshakeSubscribe = null;
        let handshakeAuthorize = null;
        // Fresh proxy ids assigned to a REPLAYED handshake line. The miner
        // already got its own subscribe/authorize response the first time
        // around, so a response landing on one of these ids must be
        // consumed silently — never forwarded, never credited.
        const swallowIds = new Set();

        let reconnectAttempts = 0;
        let reconnectTimer = null;
        const MAX_RECONNECTS = 60; // ~an hour of attempts at the default backoff

        let destroyed = false;
        const teardown = () => {
            if (destroyed) return;
            destroyed = true;
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            sock.destroy();
            upstream?.destroy();
        };

        let upstream; // reassigned on every reconnect; see wireUpstream/scheduleReconnect

        // Write backpressure, both directions: if the destination socket's
        // writable buffer is full (write() returns false), pause the SOURCE
        // socket so it stops emitting more data until the destination has
        // drained, then resume it. Each direction guards against stacking
        // duplicate 'drain' listeners with its own `*Paused` flag — while
        // paused, the source emits no more 'data', so at most one drain
        // handler is ever pending per direction. Both read the CURRENT
        // `upstream` binding, so they keep working transparently across a
        // post-reconnect swap.
        let minerPausedForUpstream = false;
        function writeToUpstream(line) {
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
                upstream.pause();
                sock.once('drain', () => {
                    upstreamPausedForMiner = false;
                    upstream.resume();
                });
            }
            return ok;
        }

        // Called on the dropped upstream's 'error' and/or 'close' — guarded
        // so both firing for the same dead socket schedules only once.
        // Gives up (tearing everything down) once the miner is already gone
        // or MAX_RECONNECTS is exhausted.
        function scheduleReconnect(deadUpstream) {
            if (destroyed || reconnectTimer) return;
            deadUpstream?.destroy();
            upstreamConnected = false;
            // A pause/drain pair armed against the now-dead upstream would
            // otherwise never fire — don't leave the miner socket stuck.
            if (minerPausedForUpstream) {
                minerPausedForUpstream = false;
                sock.resume();
            }
            upstreamPausedForMiner = false;

            if (reconnectAttempts >= MAX_RECONNECTS) { teardown(); return; }
            reconnectAttempts += 1;
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                if (destroyed) return;
                const newUpstream = connectUpstream({ host, port: poolPort });
                wireUpstream(newUpstream, { replay: true });
                upstream = newUpstream;
            }, reconnectDelayMs);
            if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
        }

        // Attaches the pool-facing connect/data/error/close logic to an
        // upstream socket — the original one, or (replay: true) a fresh one
        // created after a reconnect. On a first connect this only flushes
        // whatever the miner already queued; on a reconnect it also resets
        // per-upstream state and transparently replays the miner's
        // handshake with fresh proxy ids, so nothing the miner did needs to
        // happen again.
        function wireUpstream(u, { replay = false } = {}) {
            u.on('connect', () => {
                reconnectAttempts = 0;
                if (!replay) {
                    upstreamConnected = true;
                    flushSendQueue();
                    return;
                }

                pending.clear();
                upstreamConnected = true;
                for (const stored of [handshakeSubscribe, handshakeAuthorize]) {
                    if (stored === null) continue;
                    const msg = JSON.parse(stored);
                    const uid = nextUpstreamId++;
                    msg.id = uid;
                    swallowIds.add(uid);
                    writeToUpstream(JSON.stringify(msg));
                }
                flushSendQueue();
            });

            u.on('data', (chunk) => {
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

                        // A response to a handshake line WE replayed after a
                        // reconnect — the miner already completed its own
                        // handshake, so swallow this one instead of forwarding
                        // or crediting it.
                        if (msg.id !== undefined && msg.id !== null && swallowIds.has(msg.id)) {
                            swallowIds.delete(msg.id);
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

            // The pool dropping its end must not surface as a disconnect to
            // the miner — reconnect transparently instead of tearing down
            // (scheduleReconnect itself gives up once the miner is gone or
            // MAX_RECONNECTS is exhausted).
            u.on('error', () => scheduleReconnect(u));
            u.on('close', () => scheduleReconnect(u));
        }

        upstream = connectUpstream({ host, port: poolPort });
        wireUpstream(upstream, { replay: false });

        sock.on('data', async (chunk) => {
            try {
                const r = splitLines(minerBuf, chunk);
                minerBuf = r.buf;
                if (r.overflow) { teardown(); return; }
                for (const line of r.lines) {
                    if (!line) continue;
                    let msg;
                    try { msg = JSON.parse(line); } catch { continue; } // drop malformed, never relay garbage

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
                        msg.params = isLogin
                            ? { ...msg.params, login: newUsername }
                            : [newUsername, ...msg.params.slice(1)];
                    }

                    const isSubmit = msg.method === 'mining.submit' || msg.method === 'submit';
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

                    // Remember the exact outbound handshake lines (post
                    // id-rewrite, post wallet-rewrite) so a future reconnect
                    // can replay precisely what the pool actually saw.
                    if (msg.method === 'mining.subscribe') {
                        handshakeSubscribe = outLine;
                    } else if (msg.method === 'mining.authorize' || msg.method === 'login') {
                        handshakeAuthorize = outLine;
                    }

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
