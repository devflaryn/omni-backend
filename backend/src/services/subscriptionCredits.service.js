import mongoose from 'mongoose';
import User from '../models/user.model.js';
import CreditTransaction from '../models/creditTransaction.model.js';
import { CreditsError } from './credits.service.js';
import { DAY_PRICE_MICROS, splitSpend, effectiveBalanceMicros } from '../utils/credits.js';

/**
 * Spend 80 credits and add exactly one day of subscription, atomically.
 * A credit-bought day grants NO new subscription credits (no mine->day->credits
 * loop). Stacks onto whatever time is left, same as a key redemption.
 */
export async function redeemDayWithCredits(userId) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const user = await User.findById(userId).session(session);
        if (!user) throw new CreditsError('User not found', 404);

        const now = new Date();
        const effective = effectiveBalanceMicros(user.credits, now);
        if (effective < DAY_PRICE_MICROS) {
            throw new CreditsError('Not enough credits for a subscription day', 402);
        }
        if (user.subscription?.plan === 'lifetime') {
            throw new CreditsError('Account already has a lifetime plan', 409);
        }

        // Spend, subscription bucket first.
        const plan = splitSpend(user.credits, DAY_PRICE_MICROS, now);
        if (!user.credits) user.credits = {};
        user.credits.permanentMicros = plan.next.permanentMicros;
        user.credits.subscriptionMicros = plan.next.subscriptionMicros;
        user.credits.subscriptionCreditsExpireAt = plan.next.subscriptionCreditsExpireAt;

        // Extend by one day, stacking onto whatever time is left (or now if lapsed).
        const base = (user.subscription?.expiresAt && new Date(user.subscription.expiresAt) > now)
            ? new Date(user.subscription.expiresAt) : now;
        const oneDay = new Date(base.getTime() + 24 * 60 * 60 * 1000);
        user.subscription = { plan: user.subscription?.plan || '30_day', expiresAt: oneDay };

        await user.save({ session });

        const balanceAfter = effectiveBalanceMicros(user.credits, now);
        const rows = [];
        if (plan.fromSubMicros > 0) rows.push({
            user: user._id, deltaMicros: -plan.fromSubMicros, kind: 'subscription_purchase',
            reason: '1 day of subscription via credits', balanceAfterMicros: balanceAfter,
            bucket: 'subscription',
        });
        if (plan.fromPermanentMicros > 0) rows.push({
            user: user._id, deltaMicros: -plan.fromPermanentMicros, kind: 'subscription_purchase',
            reason: '1 day of subscription via credits', balanceAfterMicros: balanceAfter,
            bucket: 'permanent',
        });
        if (rows.length) await CreditTransaction.create(rows, { session });

        await session.commitTransaction();
        session.endSession();
        return { user };
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        throw err;
    }
}
