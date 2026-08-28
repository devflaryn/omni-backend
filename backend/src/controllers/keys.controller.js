import mongoose from 'mongoose';

import LicenseKey from '../models/licenseKey.model.js';
import User from '../models/user.model.js';
import { generateKeyCode } from '../utils/generateKeyCode.js';
import { computeSubscriptionAfterRedeem, VALID_PLANS } from '../utils/applyLicenseKey.js';
import { creditsForKey, displayBalanceMicros, MICROS_PER_DOLLAR } from '../utils/credits.js';
import CreditTransaction from '../models/creditTransaction.model.js';
import { subscriptionView } from './auth.controller.js';

const MAX_GENERATE_COUNT = 100;

async function createUniqueKey(plan, createdBy, creditsMicros = null, note = null,
                               attemptsLeft = 5) {
    const code = generateKeyCode();
    try {
        const key = await LicenseKey.create({ code, plan, createdBy, creditsMicros, note });
        return key.code;
    } catch (error) {
        if (error.code === 11000 && attemptsLeft > 1) {
            return createUniqueKey(plan, createdBy, creditsMicros, note, attemptsLeft - 1);
        }
        throw error;
    }
}

export const generateKeys = async (req, res, next) => {
    try {
        const { plan, count = 1, creditsDollars, note } = req.body;

        if (!VALID_PLANS.includes(plan)) {
            const error = new Error(`plan must be one of ${VALID_PLANS.join(', ')}`);
            error.statusCode = 400;
            throw error;
        }
        if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATE_COUNT) {
            const error = new Error(`count must be an integer between 1 and ${MAX_GENERATE_COUNT}`);
            error.statusCode = 400;
            throw error;
        }

        // `creditsDollars` OVERRIDES the plan's default grant. Omit it for a
        // normal key; pass 2 to mint a full plan that only carries $2 of
        // solving credit, and pass 0 to gift the app with no credit at all.
        // Undefined and 0 are deliberately different things here.
        let creditsMicros = null;
        if (creditsDollars !== undefined && creditsDollars !== null) {
            const n = Number(creditsDollars);
            if (!Number.isFinite(n) || n < 0) {
                const error = new Error('creditsDollars must be a non-negative number');
                error.statusCode = 400;
                throw error;
            }
            creditsMicros = Math.round(n * MICROS_PER_DOLLAR);
        }

        const codes = [];
        for (let i = 0; i < count; i++) {
            codes.push(await createUniqueKey(plan, req.user._id, creditsMicros,
                                             note ? String(note).trim() : null));
        }

        res.status(201).json({
            success: true,
            data: {
                codes,
                creditsMicros: creditsMicros ?? creditsForKey({ plan }),
            },
        });
    } catch (error) {
        next(error);
    }
};

export const redeemKey = async (req, res, next) => {
    // Both writes (the user's new subscription and the key's redeemed
    // status) must land together — a crash between them would otherwise
    // hand out the subscription while leaving the key reusable. Follows
    // the same session/transaction pattern as auth.controller.js's signUp.
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const { code } = req.body;
        if (typeof code !== 'string' || !code.trim()) {
            const error = new Error('A key code is required');
            error.statusCode = 400;
            throw error;
        }

        const key = await LicenseKey.findOne({ code: code.trim() }).session(session);
        if (!key) {
            const error = new Error('Key not found');
            error.statusCode = 404;
            throw error;
        }
        if (key.status !== 'unused') {
            const error = new Error(`Key is already ${key.status}`);
            error.statusCode = 409;
            throw error;
        }

        const user = await User.findById(req.user._id).session(session);
        user.subscription = computeSubscriptionAfterRedeem(user.subscription, key.plan);

        // Credits ride along inside the SAME transaction as the subscription.
        // Granting them afterwards would mean a crash in between hands out a
        // plan with no credit and no record of why. The key's own
        // `creditsMicros` overrides the plan default, which is what lets a gift
        // key carry a full plan but only a token amount of solving credit.
        const granted = creditsForKey(key);
        if (!user.credits) user.credits = {};
        user.credits.balanceMicros = (user.credits.balanceMicros || 0) + granted;
        await user.save({ session });

        if (granted > 0) {
            await CreditTransaction.create([{
                user: user._id,
                deltaMicros: granted,
                kind: 'grant',
                reason: `redeemed ${key.plan} key`,
                balanceAfterMicros: user.credits.balanceMicros,
                meta: { licenseKey: key.code, plan: key.plan },
            }], { session });
        }

        key.status = 'redeemed';
        key.redeemedBy = req.user._id;
        key.redeemedAt = new Date();
        await key.save({ session });

        await session.commitTransaction();
        session.endSession();

        // subscriptionView, not the raw subdocument: redeeming is the moment a
        // free account becomes premium, and the client repaints its tier badge
        // straight from this response rather than chasing it with a /me call.
        res.status(200).json({
            success: true,
            data: {
                subscription: subscriptionView(user),
                credits: {
                    grantedMicros: creditsForKey(key),
                    balanceMicros: displayBalanceMicros(user.credits?.balanceMicros),
                },
            },
        });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        next(error);
    }
};
