// In-memory per-user accrual, keyed by userId string. Flushed to credits by
// the payout loop (Task 10). Replaced/extended there — keep the export name.
const accrual = new Map(); // userId -> { diffByCoin: {xmr,rvn}, hashrate, lastShareAt, sessionMicros }

export function recordAcceptedShare(userId, coin, difficulty) {
    const a = accrual.get(userId) || { diffByCoin: { xmr: 0, rvn: 0 }, hashrate: 0, lastShareAt: null, sessionMicros: 0 };
    a.diffByCoin[coin] = (a.diffByCoin[coin] || 0) + Number(difficulty || 0);
    a.lastShareAt = new Date();
    accrual.set(userId, a);
}

export function _getAccrual() { return accrual; }

export async function getUserMiningStatus(userId) {
    const a = accrual.get(String(userId));
    return {
        enrolled: true,
        hashrate: a?.hashrate || 0,
        creditedMicros: 0, // filled from the ledger in Task 10
        sessionMicros: a?.sessionMicros || 0,
        lastShareAt: a?.lastShareAt || null,
    };
}
