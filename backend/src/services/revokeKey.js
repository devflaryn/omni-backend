import mongoose from 'mongoose';

import LicenseKey from '../models/licenseKey.model.js';
import User from '../models/user.model.js';
import CreditTransaction from '../models/creditTransaction.model.js';

/*
 * Revoke a licence key — and undo what redeeming it granted.
 *
 * A key can be revoked in two situations:
 *   1. A crypto payment was SEEN but never confirmed. We mint keys optimistically
 *      at InvoiceProcessing so the buyer isn't left waiting an hour, which means
 *      we need a compensating action when the payment turns out to be worthless.
 *   2. An admin revokes one by hand (fraud, chargeback, mistake).
 *
 * If the key was never redeemed this is trivial: flip the status and stop. The
 * interesting case is a key already applied to an account, where we must reverse
 * both halves of what redeemKey() did, in the SAME transaction, exactly as it
 * granted them.
 */

export class RevokeError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.name = 'RevokeError';
        this.statusCode = statusCode;
    }
}

/**
 * Pure: what should this subscription become once `grantedMs` of time, granted
 * by the key being revoked, is taken back?
 *
 * We subtract the EXACT milliseconds the key added (recorded at redeem time)
 * rather than restoring a snapshot wholesale. That matters because the user may
 * have stacked more keys since: restoring the snapshot would silently destroy
 * time they paid for separately, whereas subtracting composes correctly no
 * matter how many redemptions happened in between.
 *
 * `lifetime` is the exception — it isn't a duration, so there is nothing to
 * subtract and we restore what was there before.
 */
export function computeSubscriptionAfterRevoke(currentSubscription, key) {
    const before = key.subscriptionBefore ?? null;

    if (key.plan === 'lifetime') {
        return {
            plan: before?.plan ?? null,
            expiresAt: before?.expiresAt ?? null,
        };
    }

    const currentExpiresAt = currentSubscription?.expiresAt
        ? new Date(currentSubscription.expiresAt)
        : null;

    // Nothing to claw back from — the account has no dated plan.
    if (!currentExpiresAt) return currentSubscription ?? { plan: null, expiresAt: null };

    const grantedMs = Number(key.grantedMs) || 0;
    const reduced = new Date(currentExpiresAt.getTime() - grantedMs);

    return {
        plan: currentSubscription?.plan ?? null,
        expiresAt: reduced,
    };
}

/**
 * Revoke `code`, reversing its grant if it was redeemed.
 *
 * Returns a summary of what was undone so callers can log or surface it.
 * Idempotent: revoking an already-revoked key is a no-op, not an error, because
 * BTCPay redelivers webhooks and this must survive being called twice.
 */
export async function revokeKey({ code, reason = null, session: existingSession = null }) {
    const ownSession = existingSession ? null : await mongoose.startSession();
    const session = existingSession ?? ownSession;
    if (ownSession) session.startTransaction();

    try {
        const key = await LicenseKey.findOne({ code }).session(session);
        if (!key) throw new RevokeError('Key not found', 404);

        // Already done. Not an error: webhooks are delivered more than once.
        if (key.status === 'revoked') {
            if (ownSession) await session.commitTransaction();
            return { alreadyRevoked: true, code, creditsReversedMicros: 0 };
        }

        const wasRedeemed = key.status === 'redeemed' && key.redeemedBy;
        let creditsReversedMicros = 0;
        let subscriptionAfter = null;

        if (wasRedeemed) {
            const user = await User.findById(key.redeemedBy).session(session);
            if (user) {
                // --- subscription ---
                subscriptionAfter = computeSubscriptionAfterRevoke(user.subscription, key);
                user.subscription = subscriptionAfter;

                // --- credits ---
                // May drive the balance negative. That is deliberate and already
                // supported: user.model.js documents balanceMicros as allowed to
                // go negative, with every user-facing surface clamping to 0. The
                // alternative — clamping here — would silently gift the spent
                // credit of anyone who pays with a doomed transaction.
                creditsReversedMicros = Number(key.creditsGrantedMicros) || 0;
                if (creditsReversedMicros > 0) {
                    if (!user.credits) user.credits = {};
                    user.credits.balanceMicros =
                        (user.credits.balanceMicros || 0) - creditsReversedMicros;
                }

                await user.save({ session });

                if (creditsReversedMicros > 0) {
                    await CreditTransaction.create([{
                        user: user._id,
                        deltaMicros: -creditsReversedMicros,
                        kind: 'revocation',
                        reason: reason || `Key ${key.code} revoked`,
                    }], { session });
                }
            }
        }

        key.status = 'revoked';
        key.revokedAt = new Date();
        key.revokedReason = reason;
        await key.save({ session });

        if (ownSession) await session.commitTransaction();

        return {
            alreadyRevoked: false,
            code: key.code,
            wasRedeemed,
            creditsReversedMicros,
            subscriptionAfter,
        };
    } catch (error) {
        if (ownSession) await session.abortTransaction();
        throw error;
    } finally {
        if (ownSession) await session.endSession();
    }
}

export default revokeKey;
