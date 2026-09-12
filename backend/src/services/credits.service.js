/**
 * Credit movements against the database.
 *
 * The one rule that matters here: a balance is never read and then written.
 * Every decrement is a single conditional update, so two batches running on one
 * account cannot both spend the last dollar. Everything else is bookkeeping.
 */
import User from '../models/user.model.js';
import CreditTransaction from '../models/creditTransaction.model.js';
import {
    chargeForUpstream, canAffordStep, effectiveBalanceMicros,
} from '../utils/credits.js';

export class CreditsError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'CreditsError';
        this.statusCode = statusCode;
    }
}

async function record({ user, deltaMicros, kind, reason, balanceAfterMicros,
                        actor = null, meta = null, bucket = null }) {
    // A lost ledger row must not undo a balance change that already happened,
    // so this never throws into the caller's path.
    try {
        await CreditTransaction.create({
            user, deltaMicros, kind, reason, balanceAfterMicros, actor, meta, bucket,
        });
    } catch (err) {
        console.error('[credits] ledger write failed', err?.message);
    }
}

/** Add credit to one bucket. Subscription grants also set the expiry. */
export async function grantCredits(userId, amountMicros, {
    bucket = 'permanent', kind = 'grant', reason = null, actor = null,
    meta = null, expiresAt = null,
} = {}) {
    const amount = Math.round(Number(amountMicros) || 0);
    if (amount === 0) {
        const u = await User.findById(userId).select('credits');
        return effectiveBalanceMicros(u?.credits);
    }
    const field = bucket === 'subscription' ? 'credits.subscriptionMicros' : 'credits.permanentMicros';
    const set = {};
    if (bucket === 'subscription' && expiresAt) set['credits.subscriptionCreditsExpireAt'] = expiresAt;
    const updated = await User.findOneAndUpdate(
        { _id: userId },
        { $inc: { [field]: amount }, ...(Object.keys(set).length ? { $set: set } : {}) },
        { new: true },
    ).select('credits');
    if (!updated) throw new CreditsError('User not found', 404);

    const balance = effectiveBalanceMicros(updated.credits);
    await record({ user: userId, deltaMicros: amount, kind, reason,
                   balanceAfterMicros: balance, actor, meta, bucket });
    return balance;
}

/**
 * Spend, subscription-bucket first then permanent, in ONE atomic
 * aggregation-pipeline update (no read-then-write, no transaction). Lazily
 * clears an expired subscription bucket as it goes. Permanent may go negative.
 */
export async function spendCredits(userId, amountMicros, { kind = 'spend', reason = null, meta = null } = {}) {
    const amount = Math.round(Number(amountMicros) || 0);
    if (amount <= 0) {
        const u = await User.findById(userId).select('credits');
        return { chargedMicros: 0, balanceMicros: effectiveBalanceMicros(u?.credits) };
    }
    const now = new Date();
    const before = await User.findById(userId).select('credits');
    if (!before) throw new CreditsError('User not found', 404);

    const updated = await User.findOneAndUpdate(
        { _id: userId },
        [
            { $set: { __subActive: {
                $cond: [
                    { $and: [
                        { $ne: ['$credits.subscriptionCreditsExpireAt', null] },
                        { $gt: ['$credits.subscriptionCreditsExpireAt', now] },
                    ] },
                    { $ifNull: ['$credits.subscriptionMicros', 0] }, 0,
                ] } } },
            { $set: { __fromSub: { $min: ['$__subActive', amount] } } },
            { $set: {
                'credits.subscriptionMicros': { $subtract: ['$__subActive', '$__fromSub'] },
                'credits.subscriptionCreditsExpireAt': {
                    $cond: [{ $gt: [{ $subtract: ['$__subActive', '$__fromSub'] }, 0] },
                        '$credits.subscriptionCreditsExpireAt', null] },
                'credits.permanentMicros': {
                    $subtract: [{ $ifNull: ['$credits.permanentMicros', 0] },
                        { $subtract: [amount, '$__fromSub'] }] },
            } },
            { $unset: ['__subActive', '__fromSub'] },
        ],
        { new: true },
    ).select('credits');

    // Reconstruct the per-bucket split for the ledger (same rule the pipeline used).
    const now2 = now;
    const subActiveBefore =
        before.credits?.subscriptionCreditsExpireAt && new Date(before.credits.subscriptionCreditsExpireAt) > now2
            ? (before.credits.subscriptionMicros || 0) : 0;
    const fromSub = Math.min(subActiveBefore, amount);
    const fromPerm = amount - fromSub;
    const balance = effectiveBalanceMicros(updated.credits);

    if (fromSub > 0) {
        await record({ user: userId, deltaMicros: -fromSub, kind, reason,
            balanceAfterMicros: balance, meta, bucket: 'subscription' });
    }
    if (fromPerm > 0 || fromSub === 0) {
        await record({ user: userId, deltaMicros: -fromPerm, kind, reason,
            balanceAfterMicros: balance, meta, bucket: 'permanent' });
    }
    return { chargedMicros: amount, balanceMicros: balance };
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
    const balance = effectiveBalanceMicros(user.credits);
    return { allowed: canAffordStep(balance), balanceMicros: balance };
}

/**
 * Bill a completed step at the markup over what the model cost us.
 *
 * Charges if and only if the model actually billed us: a policy refusal still
 * costs money upstream and is charged, a gateway timeout with no usage is free.
 */
export async function chargeForSolve(userId, upstreamCostMicros, meta = null) {
    const amount = chargeForUpstream(upstreamCostMicros);
    if (amount <= 0) {
        const u = await User.findById(userId).select('credits');
        return { chargedMicros: 0, balanceMicros: effectiveBalanceMicros(u?.credits) };
    }
    return spendCredits(userId, amount, {
        kind: 'spend', reason: 'captcha solve step',
        meta: { ...(meta || {}), upstreamCostMicros },
    });
}

/**
 * An admin moving credit by hand, in either direction. Always the permanent
 * bucket — a bookkeeping correction, not a user spend — so it does not draw
 * from subscription first.
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
    const balance = await grantCredits(userId, amount, {
        bucket: 'permanent', kind: 'admin', reason: String(reason).trim(), actor,
    });
    const user = await User.findById(userId).select('credits email username');
    return { balanceMicros: balance, user };
}

export async function listTransactions(userId, limit = 50) {
    return CreditTransaction.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(limit) || 50, 200))
        .lean();
}
