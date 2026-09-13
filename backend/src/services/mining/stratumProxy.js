import net from 'net';
import { miningConfig } from '../../config/mining.js';
import MinerSession from '../../models/minerSession.model.js';
import { recordAcceptedShare } from './accounting.js';

/**
 * A transparent bidirectional stratum relay. A miner (e.g. xmrig) connects
 * here as if this WERE the pool; the proxy opens a real connection to the
 * configured pool immediately, relays every line verbatim in both
 * directions, and sniffs the traffic to (a) rewrite the miner's login
 * username to the pool wallet (keyed by the miner's per-user token) and
 * (b) count shares the POOL actually accepted (never shares merely
 * submitted) toward that user's accrual.
 *
 * Injectable deps make it testable without a real pool:
 *  - connectUpstream({ host, port }) -> a net.Socket-like duplex stream
 *  - resolveToken(raw) -> userId (defaults to MinerSession.resolveToken)
 */
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
// trailing line forward in `buf`. Returns { lines, buf }.
function splitLines(buf, chunk) {
    buf += chunk.toString('utf8');
    const lines = [];
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
        lines.push(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
    }
    return { lines, buf };
}

export function startStratumProxy({
    port = miningConfig().proxyBindPort,
    cfg = miningConfig(),
    resolveToken = (raw) => MinerSession.resolveToken(raw),
    connectUpstream = ({ host, port: p }) => net.connect(p, host),
} = {}) {
    const server = net.createServer((sock) => {
        const coin = chooseCoin(cfg);
        if (!coin) { sock.destroy(); return; }
        const { host, port: poolPort } = parsePoolEndpoint(cfg[coin]?.poolUrl);
        if (!host || !poolPort) { sock.destroy(); return; }

        let userId = null;
        let currentDiff = 0;
        const submitIds = new Set();

        let minerBuf = '';
        let poolBuf = '';
        let upstreamConnected = false;
        const pending = []; // raw lines from the miner queued until upstream connects

        let destroyed = false;
        const teardown = () => {
            if (destroyed) return;
            destroyed = true;
            sock.destroy();
            upstream.destroy();
        };

        const upstream = connectUpstream({ host, port: poolPort });

        upstream.on('connect', () => {
            upstreamConnected = true;
            for (const line of pending) upstream.write(line + '\n');
            pending.length = 0;
        });

        upstream.on('data', (chunk) => {
            try {
                const r = splitLines(poolBuf, chunk);
                poolBuf = r.buf;
                for (const line of r.lines) {
                    if (!line) continue;
                    let msg;
                    try { msg = JSON.parse(line); } catch { sock.write(line + '\n'); continue; }

                    if (msg.method === 'mining.set_difficulty' && Array.isArray(msg.params)) {
                        const d = Number(msg.params[0]);
                        if (Number.isFinite(d)) currentDiff = d;
                    } else if (
                        msg.id !== undefined && msg.id !== null
                        && submitIds.has(msg.id)
                        && msg.result === true
                        && !msg.error
                    ) {
                        submitIds.delete(msg.id);
                        if (userId) recordAcceptedShare(String(userId), coin, currentDiff || 1);
                    }

                    sock.write(line + '\n');
                }
            } catch (e) {
                console.error('[mining] proxy pool->miner handler error', e?.message);
                teardown();
            }
        });
        upstream.on('error', teardown);
        upstream.on('close', teardown);

        sock.on('data', async (chunk) => {
            try {
                const r = splitLines(minerBuf, chunk);
                minerBuf = r.buf;
                for (const line of r.lines) {
                    if (!line) continue;
                    let msg;
                    try { msg = JSON.parse(line); } catch {
                        if (upstreamConnected) upstream.write(line + '\n'); else pending.push(line);
                        continue;
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
                        const rewritten = isLogin
                            ? { ...msg, params: { ...msg.params, login: newUsername } }
                            : { ...msg, params: [newUsername, ...msg.params.slice(1)] };
                        const outLine = JSON.stringify(rewritten);
                        if (upstreamConnected) upstream.write(outLine + '\n'); else pending.push(outLine);
                        continue;
                    }

                    if (msg.method === 'mining.submit' || msg.method === 'submit') {
                        if (msg.id !== undefined && msg.id !== null) submitIds.add(msg.id);
                        if (upstreamConnected) upstream.write(line + '\n'); else pending.push(line);
                        continue;
                    }

                    if (upstreamConnected) upstream.write(line + '\n'); else pending.push(line);
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
