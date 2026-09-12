/** Mining is pure config. The real upstream pool + wallet stay unset for now;
 *  the proxy runs against a fake upstream in tests (see services/mining/upstream.js). */
export function miningConfig() {
    return {
        stratumHost: process.env.MINING_STRATUM_HOST || '179.198.197.7',
        stratumPort: Number(process.env.MINING_STRATUM_PORT || 3333),
        proxyBindPort: Number(process.env.MINING_PROXY_PORT || 3333),
        xmr: { poolUrl: process.env.XMR_POOL_URL || '', wallet: process.env.XMR_WALLET || '' },
        rvn: { poolUrl: process.env.RVN_POOL_URL || '', wallet: process.env.RVN_WALLET || '' },
        // Per-coin valuation inputs (env-tunable; sane placeholders for tests).
        valuation: {
            xmr: { usdPerDiff: Number(process.env.XMR_USD_PER_DIFF || 0.0000001) },
            rvn: { usdPerDiff: Number(process.env.RVN_USD_PER_DIFF || 0.00000005) },
        },
    };
}
