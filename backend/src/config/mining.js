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
        // Per-coin USD value of one unit of accepted-share difficulty. RVN is
        // calibrated (~8.2e-14) against a real HeroMiners run on 2026-09-13:
        // ~$7.0e-5 realized per 1073M-diff share => usdPerDiff ~ 8.2e-14 (this
        // credits 80% of realized value). RECALIBRATE periodically as RVN price
        // and network difficulty move. XMR is a rough placeholder (CPU deferred).
        valuation: {
            xmr: { usdPerDiff: Number(process.env.XMR_USD_PER_DIFF || 1e-13) },
            rvn: { usdPerDiff: Number(process.env.RVN_USD_PER_DIFF || 8.2e-14) },
        },
    };
}
