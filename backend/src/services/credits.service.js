/**
 * Credit movements against the database.
 *
 * The one rule that matters here: a balance is never read and then written.
 * Every decrement is a single conditional update, so two batches running on one
 * account cannot both spend the last dollar. Everything else is bookkeeping.
 */
import User from '../models/user.model.js';
import CreditTransaction from '../models/creditTransaction.model.js';
import { chargeForUpstream, canAffordStep } from '../utils/credits.js';

export class CreditsError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'CreditsError';
        this.statusCode = statusCode;
    }
}

async function record({ user, deltaMicros, kind, reason, balanceAfterMicros,
                        actor = null, meta = null }) {
    // A lost ledger row must not undo a balance change that already happened,
    // so this never throws into the caller's path.
    try {
        await CreditTransaction.create({
            user, deltaMicros, kind, reason, balanceAfterMicros, actor, meta,
        });
    } catch (err) {
        console.error('[credits] ledger write failed', err?.message);
    }
}

/**
 * Add credit. Used by key redemption and by admin top-ups.
 * Returns the new balance in micros.
 */
export async function grantCredits(userId, amountMicros, {
    kind = 'grant', reason = null, actor = null, meta = null,
} = {}) {
    const amount = Math.round(Number(amountMicros) || 0);
    if (amount === 0) {
        const user = await User.findById(userId).select('credits');
        return user?.credits?.balanceMicros ?? 0;
    }
    const updated = await User.findOneAndUpdate(
        { _id: userId },
        { $inc: { 'credits.balanceMicros': amount } },
        { new: true },
    ).select('credits');
    if (!updated) throw new CreditsError('User not found', 404);

    const balance = updated.credits?.balanceMicros ?? 0;
    await record({ user: userId, deltaMicros: amount, kind, reason,
                   balanceAfterMicros: balance, actor, meta });
    return balance;
}

/**
 * May this account start one more solve step?
 *
 * Deliberately only a READ. The charge lands after the model answers, because
 * the true cost is unknown until then — see canAffordStep for why exactly one
 * step is allowed to run past zero.
 */
export async function authorizeStep(userId) {
    const user = await User.findById(userId).select('credits');
    if (!user) throw new CreditsError('User not found', 404);
    const balance = user.credits?.balanceMicros ?? 0;
    return { allowed: canAffordStep(balance), balanceMicros: balance };
}

/**
 * Bill a completed step at the markup over what the model cost us.
 *
 * Charges if and only if the model actually billed us: a policy refusal still
 * costs money upstream and is charged, a gateway timeout with no usage is free.
 * The decrement is unconditional — this step was already authorised and already
 * consumed, so refusing to record it would just lose money.
 */
export async function chargeForSolve(userId, upstreamCostMicros, meta = null) {
    const amount = chargeForUpstream(upstreamCostMicros);
    if (amount <= 0) {
        const user = await User.findById(userId).select('credits');
        return { chargedMicros: 0, balanceMicros: user?.credits?.balanceMicros ?? 0 };
    }
    const updated = await User.findOneAndUpdate(
        { _id: userId },
        { $inc: { 'credits.balanceMicros': -amount } },
        { new: true },
    ).select('credits');
    if (!updated) throw new CreditsError('User not found', 404);

    const balance = updated.credits?.balanceMicros ?? 0;
    await record({
        user: userId, deltaMicros: -amount, kind: 'spend',
        reason: 'captcha solve step', balanceAfterMicros: balance,
        meta: { ...(meta || {}), upstreamCostMicros },
    });
    return { chargedMicros: amount, balanceMicros: balance };
}

/**
 * An admin moving credit by hand, in either direction.
 *
 * A reason is REQUIRED: the whole point of the ledger is that a balance change
 * can be explained later, and "someone adjusted it" explains nothing.
 */
export async function adminAdjust(userId, deltaMicros, { reason, actor }) {
    const amount = Math.round(Number(deltaMicros) || 0);
    if (!Number.isFinite(amount) || amount === 0) {
        throw new CreditsError('Adjustment must be a non-zero number of micros');
    }
    if (!reason || !String(reason).trim()) {
        throw new CreditsError('A reason is required for a manual adjustment');
    }
    const updated = await User.findOneAndUpdate(
        { _id: userId },
        { $inc: { 'credits.balanceMicros': amount } },
        { new: true },
    ).select('credits email username');
    if (!updated) throw new CreditsError('User not found', 404);

    const balance = updated.credits?.balanceMicros ?? 0;
    await record({ user: userId, deltaMicros: amount, kind: 'admin',
                   reason: String(reason).trim(), balanceAfterMicros: balance,
                   actor: actor || null });
    return { balanceMicros: balance, user: updated };
}

export async function listTransactions(userId, limit = 50) {
    return CreditTransaction.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(limit) || 50, 200))
        .lean();
}
