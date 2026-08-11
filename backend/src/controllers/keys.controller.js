import mongoose from 'mongoose';

import LicenseKey from '../models/licenseKey.model.js';
import { generateKeyCode } from '../utils/generateKeyCode.js';
import { computeSubscriptionAfterRedeem } from '../utils/applyLicenseKey.js';

const VALID_PLANS = ['1_month', '3_month', 'lifetime'];
const MAX_GENERATE_COUNT = 100;

async function createUniqueKey(plan, createdBy, attemptsLeft = 5) {
    const code = generateKeyCode();
    try {
        const key = await LicenseKey.create({ code, plan, createdBy });
        return key.code;
    } catch (error) {
        if (error.code === 11000 && attemptsLeft > 1) {
            return createUniqueKey(plan, createdBy, attemptsLeft - 1);
        }
        throw error;
    }
}

export const generateKeys = async (req, res, next) => {
    try {
        const { plan, count = 1 } = req.body;

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

        const codes = [];
        for (let i = 0; i < count; i++) {
            codes.push(await createUniqueKey(plan, req.user._id));
        }

        res.status(201).json({ success: true, data: { codes } });
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

        req.user.subscription = computeSubscriptionAfterRedeem(req.user.subscription, key.plan);
        await req.user.save({ session });

        key.status = 'redeemed';
        key.redeemedBy = req.user._id;
        key.redeemedAt = new Date();
        await key.save({ session });

        await session.commitTransaction();
        session.endSession();

        res.status(200).json({ success: true, data: { subscription: req.user.subscription } });
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        next(error);
    }
};
