import mongoose from 'mongoose';
import { shareValueMicros } from './valuation.js';
import { MINING_PAYOUT_RATE } from '../../utils/credits.js';
import { grantCredits as defaultGrant } from '../credits.service.js';
import { miningConfig } from '../../config/mining.js';
import CreditTransaction from '../../models/creditTransaction.model.js';

// In-memory per-user accrual, keyed by userId string. Flushed to credits by
// the payout loop below.
const accrual = new Map(); // userId -> { diffByCoin: {xmr,rvn}, hashrate, lastShareAt, sessionMicros }

export function recordAcceptedShare(userId, coin, difficulty) {
    const a = accrual.get(userId) || { diffByCoin: { xmr: 0, rvn: 0 }, hashrate: 0, lastShareAt: null, sessionMicros: 0 };
    a.diffByCoin[coin] = (a.diffByCoin[coin] || 0) + Number(difficulty || 0);
    a.lastShareAt = new Date();
    accrual.set(userId, a);
}

export function _getAccrual() { return accrual; }

/**
 * Convert accrued accepted-share difficulty into credits at MINING_PAYOUT_RATE,
 * grant to the PERMANENT bucket, and drain the accrual. Sub-credit remainders
 * are carried forward (kept in the accrual as leftover micros).
 */
export async function flushPayouts({ cfg = miningConfig(), grant = defaultGrant } = {}) {
    const results = [];
    for (const [userId, a] of accrual.entries()) {
        let grossMicros = a.leftoverMicros || 0;
        for (const coin of ['xmr', 'rvn']) {
            grossMicros += shareValueMicros(coin, a.diffByCoin[coin] || 0, cfg);
        }
        const payMicros = Math.floor(grossMicros * MINING_PAYOUT_RATE);
        if (payMicros <= 0) { continue; }
        try {
            await grant(userId, payMicros, {
                bucket: 'permanent', kind: 'mining', reason: 'mining payout',
                meta: { xmrDiff: a.diffByCoin.xmr || 0, rvnDiff: a.diffByCoin.rvn || 0 },
            });
            results.push({ userId, grantedMicros: payMicros });
        } catch (e) {
            console.error('[mining] payout failed', userId, e?.message);
            continue; // keep the accrual so a failed grant is retried next flush
        }
        accrual.delete(userId);
    }
    return results;
}

export function startPayoutLoop({ intervalMs = 60_000 } = {}) {
    const t = setInterval(() => { flushPayouts().catch((e) => console.error('[mining] flush', e?.message)); }, intervalMs);
    t.unref?.();
    return () => clearInterval(t);
}

/** Live status: in-memory accrual for the session view, lifetime credited read
 *  straight from the ledger (the source of truth once a payout has landed). */
export async function getUserMiningStatus(userId) {
    const a = accrual.get(String(userId));
    let creditedMicros = 0;
    try {
        const rows = await CreditTransaction.aggregate([
            { $match: { user: mongoose.Types.ObjectId.createFromHexString(String(userId)), kind: 'mining' } },
            { $group: { _id: null, total: { $sum: '$deltaMicros' } } },
        ]);
        creditedMicros = rows[0]?.total || 0;
    } catch { /* no DB in a unit context */ }
    return {
        enrolled: true,
        hashrate: a?.hashrate || 0,
        creditedMicros,
        sessionMicros: a?.sessionMicros || 0,
        lastShareAt: a?.lastShareAt || null,
    };
}
