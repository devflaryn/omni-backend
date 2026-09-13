import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { startStratumProxy, stopStratumProxy } from '../src/services/mining/stratumProxy.js';
import { _getAccrual } from '../src/services/mining/accounting.js';

// A minimal fake KawPow/stratum pool: replies to subscribe/authorize/submit
// the way a real HeroMiners RVN pool would, and remembers the username it
// was authorized with so the test can assert the wallet swap happened.
function startFakePool() {
    const authorizedUsernames = [];
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

                if (msg.method === 'mining.subscribe') {
                    sock.write(JSON.stringify({ id: msg.id, result: [[], '', 4], error: null }) + '\n');
                    sock.write(JSON.stringify({ id: null, method: 'mining.set_difficulty', params: [1000] }) + '\n');
                } else if (msg.method === 'mining.authorize') {
                    authorizedUsernames.push(msg.params?.[0]);
                    sock.write(JSON.stringify({ id: msg.id, result: true, error: null }) + '\n');
                } else if (msg.method === 'mining.submit') {
                    sock.write(JSON.stringify({ id: msg.id, result: true, error: null }) + '\n');
                }
            }
        });
    });
    return { server, authorizedUsernames };
}

function listen(server, port) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });
}

test('proxy relays subscribe/authorize/submit to a real pool, swaps the wallet, and credits an accepted share', async () => {
    const POOL_PORT = 39501;
    const PROXY_PORT = 39502;
    const { server: pool, authorizedUsernames } = startFakePool();
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
            resolveToken: async () => 'user-abc',
        });

        const received = [];
        await new Promise((resolve, reject) => {
            client = net.connect(PROXY_PORT, '127.0.0.1', () => {
                client.write(JSON.stringify({ id: 1, method: 'mining.subscribe', params: [] }) + '\n');
            });
            let buf = '';
            client.on('data', (chunk) => {
                buf += chunk.toString('utf8');
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line) continue;
                    const msg = JSON.parse(line);
                    received.push(msg);

                    if (msg.result && Array.isArray(msg.result) && msg.id === 1) {
                        // subscribe result arrived — now authorize.
                        client.write(JSON.stringify({ id: 2, method: 'mining.authorize', params: ['tok.rvn', 'x'] }) + '\n');
                    } else if (msg.id === 2 && msg.result === true) {
                        // authorized — now submit a share.
                        client.write(JSON.stringify({ id: 3, method: 'mining.submit', params: ['tok.rvn', 'job1', '0', '0', '0'] }) + '\n');
                    } else if (msg.id === 3 && msg.result === true) {
                        resolve();
                    }
                }
            });
            client.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 3000);
        });

        // 1. the fake pool received the wallet-substituted username, not the raw token.
        assert.equal(authorizedUsernames.length, 1);
        assert.ok(authorizedUsernames[0].startsWith('RVNWALLET.'), `expected wallet-prefixed username, got ${authorizedUsernames[0]}`);

        // 2. the accepted submit was credited at the set difficulty.
        await new Promise((r) => setTimeout(r, 50));
        const a = _getAccrual().get('user-abc');
        assert.ok(a, 'accrual entry exists for user-abc');
        assert.equal(a.diffByCoin.rvn, 1000);

        // 3. the miner received the pool's subscribe result and set_difficulty (relay works both ways).
        const subscribeResult = received.find((m) => m.id === 1);
        assert.ok(subscribeResult && Array.isArray(subscribeResult.result));
        const setDiff = received.find((m) => m.method === 'mining.set_difficulty');
        assert.ok(setDiff && setDiff.params[0] === 1000);
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
