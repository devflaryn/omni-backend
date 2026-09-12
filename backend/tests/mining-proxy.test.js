import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { startStratumProxy, stopStratumProxy } from '../src/services/mining/stratumProxy.js';
import { FakeUpstream } from '../src/services/mining/upstream.js';
import { _getAccrual } from '../src/services/mining/accounting.js';

test('proxy authorizes a token and counts an accepted share', async () => {
    const PORT = 39333;
    const server = startStratumProxy({
        port: PORT,
        upstreamFactory: () => new FakeUpstream({ difficulty: 1000 }),
        resolveToken: async () => 'user-abc',
    });
    try {
        await new Promise((resolve, reject) => {
            const c = net.connect(PORT, '127.0.0.1', () => {
                c.write(JSON.stringify({ id: 1, method: 'login', params: { login: 'tok.xmr' } }) + '\n');
                setTimeout(() => {
                    c.write(JSON.stringify({ id: 2, method: 'submit', params: {} }) + '\n');
                }, 50);
            });
            let seen = 0;
            c.on('data', () => { seen += 1; if (seen >= 2) { c.end(); resolve(); } });
            c.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 2000);
        });
        await new Promise((r) => setTimeout(r, 50));
        const a = _getAccrual().get('user-abc');
        assert.ok(a && a.diffByCoin.xmr === 1000, 'accepted share difficulty accrued');
    } finally {
        await stopStratumProxy(server);
    }
});
