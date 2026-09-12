import net from 'net';
import { RealUpstream } from './upstream.js';
import { miningConfig } from '../../config/mining.js';
import MinerSession from '../../models/minerSession.model.js';
import { recordAcceptedShare } from './accounting.js';

/**
 * A TCP stratum proxy. A miner logs in with its minerToken as the username;
 * the proxy resolves it to a userId, opens an upstream connection (real pool or
 * a fake), forwards traffic, and counts ONLY upstream-accepted shares.
 *
 * Injectable deps make it testable without a real pool:
 *  - upstreamFactory({ coin, cfg, worker }) -> upstream emitting 'accepted'
 *  - resolveToken(raw) -> userId (defaults to MinerSession.resolveToken)
 */
export function startStratumProxy({
    port = miningConfig().proxyBindPort,
    upstreamFactory = ({ coin, cfg, worker }) => new RealUpstream({
        host: cfg[coin]?.poolUrl, // deferred: unset until a real pool/wallet is configured
        port, wallet: cfg[coin]?.wallet, worker,
    }),
    resolveToken = (raw) => MinerSession.resolveToken(raw),
    cfg = miningConfig(),
} = {}) {
    const server = net.createServer((sock) => {
        let userId = null;
        let coin = 'xmr';
        let upstream = null;
        let buf = '';

        sock.on('data', async (chunk) => {
            try {
                buf += chunk.toString('utf8');
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, nl).trim();
                    buf = buf.slice(nl + 1);
                    if (!line) continue;
                    let msg;
                    try { msg = JSON.parse(line); } catch { continue; }

                    // Login: {"method":"login","params":{"login":"<token>.<coin>"}}
                    if (msg.method === 'login' || msg.method === 'mining.authorize') {
                        const login = msg.params?.login || msg.params?.[0] || '';
                        const [rawToken, coinTag] = String(login).split('.');
                        coin = coinTag === 'rvn' ? 'rvn' : 'xmr';
                        userId = await resolveToken(rawToken);
                        if (!userId) { sock.destroy(); return; }
                        // A second login on the same socket replaces the upstream —
                        // destroy the old one first so it doesn't leak.
                        upstream?.destroy?.();
                        upstream = upstreamFactory({ coin, cfg, worker: userId });
                        upstream.on('accepted', ({ difficulty }) => {
                            recordAcceptedShare(String(userId), coin, difficulty);
                        });
                        upstream.on('error', () => sock.destroy());
                        upstream.on('close', () => sock.destroy());
                        upstream.connect();
                        sock.write(JSON.stringify({ id: msg.id, result: { status: 'OK' }, error: null }) + '\n');
                        continue;
                    }
                    // Share submit → forward to upstream.
                    if (msg.method === 'submit' || msg.method === 'mining.submit') {
                        if (userId && upstream) {
                            upstream.submit(msg.params);
                            sock.write(JSON.stringify({ id: msg.id, result: true, error: null }) + '\n');
                        }
                        continue;
                    }
                }
            } catch (e) {
                console.error('[mining] proxy data handler error', e?.message);
                sock.destroy();
            }
        });
        sock.on('error', () => { upstream?.destroy?.(); });
        sock.on('close', () => { upstream?.destroy?.(); });
    });
    server.listen(port);
    return server;
}

export function stopStratumProxy(server) {
    return new Promise((resolve) => (server ? server.close(resolve) : resolve()));
}
