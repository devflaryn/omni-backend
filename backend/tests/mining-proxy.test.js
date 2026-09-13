import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { startStratumProxy, stopStratumProxy, MAX_INFLIGHT } from '../src/services/mining/stratumProxy.js';
import { _getAccrual } from '../src/services/mining/accounting.js';

// A minimal fake KawPow/stratum pool: replies to subscribe/authorize/submit
// the way a real HeroMiners RVN pool would, and remembers (a) the username
// it was authorized with (so the test can assert the wallet swap happened)
// and (b) every request id it actually received (so the test can assert
// the proxy rewrote miner-controlled ids to its own, rather than relaying
// them verbatim). `rejectSubmitJobIds` lets a test make specific submits
// come back rejected, the way a stale/invalid share would.
function startFakePool({ rejectSubmitJobIds = new Set() } = {}) {
    const authorizedUsernames = [];
    const receivedIds = [];
    const server = net.createServer((sock) => {
        let buf = '';
        sock.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }
                receivedIds.push(msg.id);

                if (msg.method === 'mining.subscribe') {
                    sock.write(JSON.stringify({ id: msg.id, result: [[], '', 4], error: null }) + '\n');
                    sock.write(JSON.stringify({ id: null, method: 'mining.set_difficulty', params: [1000] }) + '\n');
                } else if (msg.method === 'mining.authorize') {
                    authorizedUsernames.push(msg.params?.[0]);
                    sock.write(JSON.stringify({ id: msg.id, result: true, error: null }) + '\n');
                } else if (msg.method === 'mining.submit') {
                    const jobId = msg.params?.[1];
                    const accept = !rejectSubmitJobIds.has(jobId);
                    sock.write(JSON.stringify({
                        id: msg.id,
                        result: accept,
                        error: accept ? null : [21, 'Job not found', null],
                    }) + '\n');
                }
            }
        });
    });
    return { server, authorizedUsernames, receivedIds };
}

// A fake pool that behaves the way a real one (HeroMiners RVN) has been
// observed to: on the FIRST connection it handles subscribe/authorize
// normally, sends one job, then closes its end of the socket right after.
// On the SECOND connection it again handles subscribe/authorize and sends a
// job, and answers a submit with result:true. Used to prove the proxy
// reconnects to the pool transparently instead of dropping the miner.
function startReconnectingFakePool() {
    let connectionCount = 0;
    const server = net.createServer((sock) => {
        connectionCount += 1;
        const myConnNum = connectionCount;
        let buf = '';
        sock.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }

                if (msg.method === 'mining.subscribe') {
                    sock.write(JSON.stringify({ id: msg.id, result: [[], '', 4], error: null }) + '\n');
                } else if (msg.method === 'mining.authorize') {
                    sock.write(JSON.stringify({ id: msg.id, result: true, error: null }) + '\n');
                    const jobId = `job${myConnNum}`;
                    const target = '00000000ffff0000000000000000000000000000000000000000000000000000';
                    sock.write(JSON.stringify({ id: null, method: 'mining.notify', params: [jobId, '', '', '', target, '', '', true] }) + '\n');
                    if (myConnNum === 1) {
                        // Simulate the pool dropping this connection right
                        // after handing out a job. .end() flushes the job
                        // line first, then closes — exactly like a real pool
                        // cycling its connections mid-session.
                        sock.end();
                    }
                } else if (msg.method === 'mining.submit') {
                    sock.write(JSON.stringify({ id: msg.id, result: true, error: null }) + '\n');
                }
            }
        });
    });
    return { server };
}

// Collects every newline-delimited JSON message a miner client receives.
function collectMinerMessages(client) {
    const messages = [];
    let buf = '';
    client.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            messages.push(JSON.parse(line));
        }
    });
    return messages;
}

// Polls `predicate` until it's true or `timeout` elapses.
function waitUntil(predicate, { timeout = 5000, interval = 10 } = {}) {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const tick = () => {
            if (predicate()) { resolve(); return; }
            if (Date.now() - start > timeout) { reject(new Error('timeout waiting for condition')); return; }
            setTimeout(tick, interval);
        };
        tick();
    });
}

function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
}

// Drives a subscribe -> authorize -> (one or more) submit sequence over a
// connected client socket, resolving with every parsed message the miner
// received, once `stopWhen(msg)` returns true.
function driveMiner(client, { subscribeId, authorizeId, submits }, stopWhen) {
    const received = [];
    return new Promise((resolve, reject) => {
        let buf = '';
        let submitIdx = 0;
        client.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                const msg = JSON.parse(line);
                received.push(msg);

                if (msg.id === subscribeId && Array.isArray(msg.result)) {
                    client.write(JSON.stringify({ id: authorizeId, method: 'mining.authorize', params: ['tok.rvn', 'x'] }) + '\n');
                } else if (msg.id === authorizeId && msg.result === true && submitIdx < submits.length) {
                    const s = submits[submitIdx];
                    client.write(JSON.stringify({ id: s.id, method: 'mining.submit', params: ['tok.rvn', s.jobId, '0', '0', '0'] }) + '\n');
                } else if (submits.some((s) => s.id === msg.id) && msg.id !== authorizeId) {
                    submitIdx += 1;
                    if (submitIdx < submits.length) {
                        const s = submits[submitIdx];
                        client.write(JSON.stringify({ id: s.id, method: 'mining.submit', params: ['tok.rvn', s.jobId, '0', '0', '0'] }) + '\n');
                    }
                }

                if (stopWhen(msg, received)) { resolve(received); return; }
            }
        });
        client.on('error', reject);
        client.write(JSON.stringify({ id: subscribeId, method: 'mining.subscribe', params: [] }) + '\n');
        setTimeout(() => reject(new Error('timeout waiting for expected message')), 3000);
    });
}

test('proxy relays subscribe/authorize/submit to a real pool, swaps the wallet, rewrites ids, and credits an accepted share exactly once', async () => {
    const POOL_PORT = 39501;
    const PROXY_PORT = 39502;
    const { server: pool, authorizedUsernames, receivedIds } = startFakePool();
    let proxy;
    let client;
    try {
        await listen(pool, POOL_PORT);
        _getAccrual().clear();

        const cfg = {
            rvn: { poolUrl: `127.0.0.1:${POOL_PORT}`, wallet: 'RVNWALLET' },
            xmr: { poolUrl: '' },
        };
        proxy = startStratumProxy({ port: PROXY_PORT, cfg, resolveToken: async () => 'user-abc' });

        // Deliberately large, non-sequential miner-chosen ids — distinct
        // from anything a proxy-assigned monotonic counter (1, 2, 3, ...)
        // would ever produce — so we can prove the proxy is NOT relaying
        // the miner's own ids upstream.
        client = net.connect(PROXY_PORT, '127.0.0.1');
        const received = await driveMiner(
            client,
            { subscribeId: 9001, authorizeId: 9002, submits: [{ id: 9003, jobId: 'job1' }] },
            (msg) => msg.id === 9003,
        );

        // 1. the fake pool received the wallet-substituted username, not the raw token.
        assert.equal(authorizedUsernames.length, 1);
        assert.ok(authorizedUsernames[0].startsWith('RVNWALLET.'), `expected wallet-prefixed username, got ${authorizedUsernames[0]}`);

        // Proof of id rewriting: the pool never saw the miner's chosen ids ...
        assert.ok(!receivedIds.includes(9001) && !receivedIds.includes(9002) && !receivedIds.includes(9003),
            `pool must never see miner-chosen ids, got ${JSON.stringify(receivedIds)}`);
        // ... it saw a proxy-assigned monotonic sequence instead.
        assert.deepEqual(receivedIds, [1, 2, 3]);
        // ... yet the miner still gets back its OWN ids (rewritten on the way out).
        assert.ok(received.some((m) => m.id === 9001 && Array.isArray(m.result)), 'subscribe response used the miner id');
        assert.ok(received.some((m) => m.id === 9002 && m.result === true), 'authorize response used the miner id');
        assert.ok(received.some((m) => m.id === 9003 && m.result === true), 'submit response used the miner id');

        // 2. the accepted submit was credited exactly once, at the set difficulty.
        await new Promise((r) => setTimeout(r, 50));
        const a = _getAccrual().get('user-abc');
        assert.ok(a, 'accrual entry exists for user-abc');
        assert.equal(a.diffByCoin.rvn, 1000);

        // 3. the miner received the pool's subscribe result and set_difficulty (relay works both ways).
        const setDiff = received.find((m) => m.method === 'mining.set_difficulty');
        assert.ok(setDiff && setDiff.params[0] === 1000);
    } finally {
        client?.destroy();
        await stopStratumProxy(proxy);
        await new Promise((r) => pool.close(r));
    }
});

test('a rejected submit records no accrual', async () => {
    const POOL_PORT = 39505;
    const PROXY_PORT = 39506;
    const { server: pool } = startFakePool({ rejectSubmitJobIds: new Set(['badjob']) });
    let proxy;
    let client;
    try {
        await listen(pool, POOL_PORT);
        _getAccrual().clear();

        const cfg = {
            rvn: { poolUrl: `127.0.0.1:${POOL_PORT}`, wallet: 'RVNWALLET' },
            xmr: { poolUrl: '' },
        };
        proxy = startStratumProxy({ port: PROXY_PORT, cfg, resolveToken: async () => 'user-rej' });

        client = net.connect(PROXY_PORT, '127.0.0.1');
        await driveMiner(
            client,
            { subscribeId: 1, authorizeId: 2, submits: [{ id: 3, jobId: 'badjob' }] },
            (msg) => msg.id === 3,
        );

        await new Promise((r) => setTimeout(r, 50));
        assert.equal(_getAccrual().get('user-rej'), undefined, 'a rejected submit must not accrue anything');
    } finally {
        client?.destroy();
        await stopStratumProxy(proxy);
        await new Promise((r) => pool.close(r));
    }
});

test('reusing a miner-chosen id after a rejected submit cannot forge a credit', async () => {
    // This is the exploit the id-rewriting defends against: the OLD
    // implementation keyed acceptance on "a message with this miner id came
    // back with result:true", so a miner could submit a bogus/rejected
    // share, then send an unrelated request reusing THE SAME id (anything
    // the pool answers with result:true, e.g. a second authorize) and get
    // credited for a share it never actually got accepted.
    const POOL_PORT = 39507;
    const PROXY_PORT = 39508;
    const { server: pool } = startFakePool({ rejectSubmitJobIds: new Set(['badjob']) });
    let proxy;
    let client;
    try {
        await listen(pool, POOL_PORT);
        _getAccrual().clear();

        const cfg = {
            rvn: { poolUrl: `127.0.0.1:${POOL_PORT}`, wallet: 'RVNWALLET' },
            xmr: { poolUrl: '' },
        };
        proxy = startStratumProxy({ port: PROXY_PORT, cfg, resolveToken: async () => 'user-exploit' });

        const REUSED_ID = 777;
        client = net.connect(PROXY_PORT, '127.0.0.1');
        const received = await driveMiner(
            client,
            { subscribeId: 1, authorizeId: 2, submits: [{ id: REUSED_ID, jobId: 'badjob' }] },
            (msg) => msg.id === REUSED_ID,
        );
        // Confirm the submit really was rejected before attempting the reuse.
        const submitResp = received.find((m) => m.id === REUSED_ID);
        assert.equal(submitResp.result, false);

        // Now reuse the SAME miner id on an unrelated request (an
        // authorize) the pool will happily answer with result:true.
        await new Promise((resolve, reject) => {
            let buf = '';
            client.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line) continue;
                    const msg = JSON.parse(line);
                    if (msg.id === REUSED_ID && msg.result === true) { resolve(); return; }
                }
            });
            client.write(JSON.stringify({ id: REUSED_ID, method: 'mining.authorize', params: ['tok.rvn', 'x'] }) + '\n');
            client.on('error', reject);
            setTimeout(() => reject(new Error('timeout waiting for reused-id authorize response')), 3000);
        });

        await new Promise((r) => setTimeout(r, 50));
        assert.equal(_getAccrual().get('user-exploit'), undefined, 'reusing a miner id must never forge a credit');
    } finally {
        client?.destroy();
        await stopStratumProxy(proxy);
        await new Promise((r) => pool.close(r));
    }
});

test('a line with no newline that exceeds the buffer cap destroys the connection', async () => {
    const POOL_PORT = 39509;
    const PROXY_PORT = 39510;
    const { server: pool } = startFakePool();
    let proxy;
    let client;
    try {
        await listen(pool, POOL_PORT);
        const cfg = {
            rvn: { poolUrl: `127.0.0.1:${POOL_PORT}`, wallet: 'RVNWALLET' },
            xmr: { poolUrl: '' },
        };
        proxy = startStratumProxy({ port: PROXY_PORT, cfg, resolveToken: async () => 'user-abc' });

        await new Promise((resolve, reject) => {
            client = net.connect(PROXY_PORT, '127.0.0.1', () => {
                client.write('{'.repeat(70 * 1024)); // > MAX_LINE, never terminated
            });
            client.resume();
            client.on('close', resolve);
            client.on('error', resolve);
            setTimeout(() => reject(new Error('timeout: oversized unterminated line did not destroy the socket')), 3000);
        });
    } finally {
        client?.destroy();
        await stopStratumProxy(proxy);
        await new Promise((r) => pool.close(r));
    }
});

test('an in-flight cap prevents a flooding miner from growing the pending map unbounded', async () => {
    // A fake pool that accepts the connection but NEVER responds to
    // anything — nothing ever drains `pending`, so a miner that floods
    // id'd requests faster than any real pool's RTT would otherwise grow
    // that map without bound. MAX_INFLIGHT + 1 id'd submits must trip the
    // cap and destroy the miner socket instead.
    const POOL_PORT = 39511;
    const PROXY_PORT = 39512;
    const pool = net.createServer((sock) => { sock.on('data', () => {}); }); // never writes back
    let proxy;
    let client;
    try {
        await listen(pool, POOL_PORT);
        _getAccrual().clear();

        const cfg = {
            rvn: { poolUrl: `127.0.0.1:${POOL_PORT}`, wallet: 'RVNWALLET' },
            xmr: { poolUrl: '' },
        };
        proxy = startStratumProxy({ port: PROXY_PORT, cfg, resolveToken: async () => 'user-flood' });

        await new Promise((resolve, reject) => {
            client = net.connect(PROXY_PORT, '127.0.0.1', () => {
                let payload = '';
                for (let i = 1; i <= MAX_INFLIGHT + 1; i++) {
                    payload += JSON.stringify({ id: i, method: 'mining.submit', params: ['tok.rvn', `job${i}`, '0', '0', '0'] }) + '\n';
                }
                client.write(payload);
            });
            client.resume();
            client.on('close', resolve);
            client.on('error', resolve);
            setTimeout(() => reject(new Error('timeout: in-flight cap did not destroy the socket')), 5000);
        });

        await new Promise((r) => setTimeout(r, 50));
        assert.equal(_getAccrual().get('user-flood'), undefined, 'a flood of never-answered submits must never accrue anything');
    } finally {
        client?.destroy();
        await stopStratumProxy(proxy);
        await new Promise((r) => pool.close(r));
    }
});

test('an unknown miner token is refused: socket destroyed, nothing credited', async () => {
    const POOL_PORT = 39503;
    const PROXY_PORT = 39504;
    const { server: pool } = startFakePool();
    let proxy;
    let client;
    try {
        await listen(pool, POOL_PORT);
        _getAccrual().clear();

        const cfg = {
            rvn: { poolUrl: `127.0.0.1:${POOL_PORT}`, wallet: 'RVNWALLET' },
            xmr: { poolUrl: '' },
        };
        proxy = startStratumProxy({
            port: PROXY_PORT,
            cfg,
            resolveToken: async () => null,
        });

        await new Promise((resolve, reject) => {
            client = net.connect(PROXY_PORT, '127.0.0.1', () => {
                client.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: [] }) + '\n');
                setTimeout(() => {
                    client.write(JSON.stringify({ id: 2, method: 'mining.authorize', params: ['badtok.rvn', 'x'] }) + '\n');
                }, 50);
            });
            // A paused stream (no 'data' listener) never emits 'end'/'close' —
            // resume it so the destroyed-socket signal actually arrives here.
            client.resume();
            client.on('close', resolve);
            client.on('error', resolve);
            setTimeout(() => reject(new Error('timeout: socket was not destroyed')), 3000);
        });

        assert.equal(_getAccrual().get('user-abc'), undefined);
        assert.equal(_getAccrual().size, 0);
    } finally {
        client?.destroy();
        await stopStratumProxy(proxy);
        await new Promise((r) => pool.close(r));
    }
});

test('a dropped upstream reconnects transparently: the miner never sees a disconnect, still gets jobs, and a post-reconnect submit is still credited', async () => {
    const POOL_PORT = 39515;
    const PROXY_PORT = 39516;
    const { server: pool } = startReconnectingFakePool();
    let proxy;
    let client;
    try {
        await listen(pool, POOL_PORT);
        _getAccrual().clear();

        const cfg = {
            rvn: { poolUrl: `127.0.0.1:${POOL_PORT}`, wallet: 'RVNWALLET' },
            xmr: { poolUrl: '' },
        };
        proxy = startStratumProxy({
            port: PROXY_PORT,
            cfg,
            resolveToken: async () => 'user-reconnect',
            reconnectDelayMs: 50,
        });

        client = net.connect(PROXY_PORT, '127.0.0.1');
        let minerClosed = false;
        client.on('close', () => { minerClosed = true; });
        const messages = collectMinerMessages(client);

        client.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: [] }) + '\n');
        await waitUntil(() => messages.some((m) => m.id === 1 && Array.isArray(m.result)));

        client.write(JSON.stringify({ id: 2, method: 'mining.authorize', params: ['tok.rvn', 'x'] }) + '\n');
        await waitUntil(() => messages.some((m) => m.id === 2 && m.result === true));

        // The job from the FIRST upstream connection.
        await waitUntil(() => messages.some((m) => m.method === 'mining.notify' && m.params?.[0] === 'job1'));

        // The fake pool now drops its end of that first connection. The
        // proxy must reconnect (replaying subscribe+authorize on a fresh
        // socket) without the miner ever seeing its own socket close, and
        // the miner must still receive a job from the NEW connection.
        await waitUntil(
            () => messages.some((m) => m.method === 'mining.notify' && m.params?.[0] === 'job2'),
            { timeout: 5000 },
        );

        assert.equal(minerClosed, false, 'miner socket must never see a close across an upstream reconnect');
        // The replayed handshake responses must never reach the miner as
        // NEW subscribe/authorize responses for ids 1/2 (only the originals
        // should ever have arrived).
        assert.equal(messages.filter((m) => m.id === 1).length, 1, 'replayed subscribe response must be swallowed, not re-delivered');
        assert.equal(messages.filter((m) => m.id === 2).length, 1, 'replayed authorize response must be swallowed, not re-delivered');

        // A submit after the reconnect must still be relayed to the (new)
        // upstream and credited.
        client.write(JSON.stringify({ id: 3, method: 'mining.submit', params: ['tok.rvn', 'job2', '0', '0', '0'] }) + '\n');
        await waitUntil(() => messages.some((m) => m.id === 3 && m.result === true));

        await new Promise((r) => setTimeout(r, 50));
        const a = _getAccrual().get('user-reconnect');
        assert.ok(a, 'accrual entry exists after a post-reconnect accepted submit');

        assert.equal(minerClosed, false, 'miner socket must still never have closed');
    } finally {
        client?.destroy();
        await stopStratumProxy(proxy);
        await new Promise((r) => pool.close(r));
    }
});
