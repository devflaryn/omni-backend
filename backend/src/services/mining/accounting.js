import mongoose from 'mongoose';
import { shareValueMicros } from './valuation.js';
import { MINING_PAYOUT_RATE } from '../../utils/credits.js';
import { grantCredits as defaultGrant } from '../credits.service.js';
import { miningConfig } from '../../config/mining.js';
import CreditTransaction from '../../models/creditTransaction.model.js';
import MinerSession from '../../models/minerSession.model.js';

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
 * grant to the PERMANENT bucket, and subtract only what was paid for.
 *
 * `grant()` is awaited, and share submits keep arriving concurrently (the
 * proxy calls `recordAcceptedShare` from its own socket handlers, not from
 * here), so the entry in `accrual` can change while this is in flight. To
 * never lose or double-pay a share, each iteration SNAPSHOTS the difficulty
 * it is about to pay for before awaiting the grant, then on success subtracts
 * exactly that snapshot from the (possibly-grown) live entry — never deletes
 * it outright. Any difficulty recorded during the await survives untouched.
 * The sub-micro remainder of the payout (gross * rate is rarely an integer)
 * is carried forward as `leftoverMicros` and added into the next flush.
 */
export async function flushPayouts({ cfg = miningConfig(), grant = defaultGrant } = {}) {
    const results = [];
    for (const [userId, a] of accrual.entries()) {
        const snap = { xmr: a.diffByCoin.xmr || 0, rvn: a.diffByCoin.rvn || 0 };
        const leftover = a.leftoverMicros || 0;
        const grossMicros = shareValueMicros('xmr', snap.xmr, cfg) + shareValueMicros('rvn', snap.rvn, cfg);
        const payoutExact = grossMicros * MINING_PAYOUT_RATE + leftover;
        const payMicros = Math.floor(payoutExact);
        if (payMicros <= 0) { continue; } // entry left untouched, nothing to pay yet

        try {
            await grant(userId, payMicros, {
                bucket: 'permanent', kind: 'mining', reason: 'mining payout',
                meta: { xmrDiff: snap.xmr, rvnDiff: snap.rvn },
            });
        } catch (e) {
            console.error('[mining] payout failed', userId, e?.message);
            continue; // entry left entirely unchanged, retried next flush
        }
        // Success: subtract only what we just paid for, keep anything that
        // accrued during the await, and carry the sub-micro remainder.
        a.diffByCoin.xmr -= snap.xmr;
        a.diffByCoin.rvn -= snap.rvn;
        a.leftoverMicros = payoutExact - payMicros;
        results.push({ userId, grantedMicros: payMicros });
    }
    return results;
}

export function startPayoutLoop({ intervalMs = 60_000 } = {}) {
    const t = setInterval(() => { flushPayouts().catch((e) => console.error('[mining] flush', e?.message)); }, intervalMs);
    t.unref?.();
    return () => clearInterval(t);
}

/** Live status: real enrollment + lifetime credited read from the ledger (the
 *  source of truth once a payout has landed), in-memory accrual for the
 *  session view. Both DB reads are guarded — a unit context with no DB
 *  connection reports "not enrolled" / zero credited rather than throwing. */
export async function getUserMiningStatus(userId) {
    const a = accrual.get(String(userId));

    let enrolled = false;
    try {
        enrolled = !!(await MinerSession.findOne({ user: userId, revokedAt: null }).lean());
    } catch { /* no DB in a unit context */ }

    let creditedMicros = 0;
    try {
        const rows = await CreditTransaction.aggregate([
            { $match: { user: mongoose.Types.ObjectId.createFromHexString(String(userId)), kind: 'mining' } },
            { $group: { _id: null, total: { $sum: '$deltaMicros' } } },
        ]);
        creditedMicros = rows[0]?.total || 0;
    } catch { /* no DB in a unit context */ }

    return {
        enrolled,
        hashrate: a?.hashrate || 0,
        creditedMicros,
        sessionMicros: a?.sessionMicros || 0,
        lastShareAt: a?.lastShareAt || null,
    };
}
