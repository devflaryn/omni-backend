/** Mining is pure config. The real upstream pool + wallet stay unset for now;
 *  the proxy relays to a real (or test-fake) pool via services/mining/stratumProxy.js. */
export function miningConfig() {
    return {
        stratumHost: process.env.MINING_STRATUM_HOST || '179.198.197.7',
        stratumPort: Number(process.env.MINING_STRATUM_PORT || 3333),
        proxyBindPort: Number(process.env.MINING_PROXY_PORT || 3333),
        // The proxy binds a raw, unauthenticated TCP port that arcjet does not
        // cover; it must stay OFF until a real pool is wired in (see the
        // TODO(real-pool) note in stratumProxy.js) — opt in explicitly.
        proxyEnabled: process.env.MINING_PROXY_ENABLED === '1',
        xmr: { poolUrl: process.env.XMR_POOL_URL || '', wallet: process.env.XMR_WALLET || '' },
        rvn: { poolUrl: process.env.RVN_POOL_URL || '', wallet: process.env.RVN_WALLET || '' },
        // Per-coin valuation inputs (env-tunable; sane placeholders for tests).
        valuation: {
            xmr: { usdPerDiff: Number(process.env.XMR_USD_PER_DIFF || 0.0000001) },
            rvn: { usdPerDiff: Number(process.env.RVN_USD_PER_DIFF || 0.00000005) },
        },
    };
}
