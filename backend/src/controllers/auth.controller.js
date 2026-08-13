import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import User from '../models/user.model.js';
import LicenseKey from '../models/licenseKey.model.js';
import { JWT_SECRET, JWT_EXPIRES_IN } from "../config/env.js";
import {
    computeSubscriptionAfterRedeem,
    isSubscriptionActive,
    daysRemaining,
    PLAN_LABELS,
} from '../utils/applyLicenseKey.js';

const MIN_PASSWORD = 6;

function signToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/** The subscription view every client renders its paywall from. */
export function subscriptionView(user, now = new Date()) {
    const sub = user?.subscription ?? { plan: null, expiresAt: null };
    return {
        plan: sub.plan ?? null,
        planLabel: sub.plan ? (PLAN_LABELS[sub.plan] ?? sub.plan) : null,
        expiresAt: sub.expiresAt ?? null,
        active: isSubscriptionActive(sub, now),
        daysRemaining: daysRemaining(sub, now),
    };
}

function badRequest(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

/**
 * Register. Unlike the original open sign-up, a valid, unredeemed license key is
 * now REQUIRED: the desktop app is the product, an account with no plan can do
 * nothing with it, and letting anyone create empty accounts on a public host is
 * just a spam surface. The key is consumed in the same transaction that creates
 * the user, so a crash can never leave a burned key with no account behind it.
 */
export const signUp = async (req, res, next) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const code = typeof req.body?.key === 'string' ? req.body.key.trim().toUpperCase() : '';

        if (!email) throw badRequest('An email address is required');
        if (password.length < MIN_PASSWORD) {
            throw badRequest(`Password must be at least ${MIN_PASSWORD} characters`);
        }
        if (!code) throw badRequest('A license key is required to register');

        const existingUser = await User.findOne({ email }).session(session);
        if (existingUser) throw badRequest('User already exists', 409);

        // Claim the key with a single conditional update: two simultaneous
        // sign-ups on the same code cannot both match { status: 'unused' }, so
        // the loser gets "already redeemed" instead of a second free account.
        const key = await LicenseKey.findOneAndUpdate(
            { code, status: 'unused' },
            { status: 'redeemed', redeemedAt: new Date() },
            { new: true, session }
        );
        if (!key) {
            const known = await LicenseKey.findOne({ code }).session(session);
            throw known
                ? badRequest(`That key is already ${known.status}`, 409)
                : badRequest('That license key is not valid', 404);
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const subscription = computeSubscriptionAfterRedeem(null, key.plan);

        const newUsers = await User.create(
            [{ email, password: hashedPassword, subscription }],
            { session }
        );
        const user = newUsers[0];

        key.redeemedBy = user._id;
        await key.save({ session });

        const token = signToken(user._id);

        await session.commitTransaction();
        session.endSession();

        res.status(201).json({
            success: true,
            message: 'User successfully created',
            data: {
                token,
                user,
                subscription: subscriptionView(user),
            }
        })
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        next(error)
    }
}

export const signIn = async (req, res, next) => {
    try {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';

        const user = await User.findOne({ email })

        // Same message for "no such email" and "wrong password" on purpose:
        // distinguishing them turns sign-in into an account-existence oracle.
        const invalid = badRequest('Invalid email or password', 401);
        if (!user) throw invalid;
        if (!await bcrypt.compare(password, user.password)) throw invalid;

        const token = signToken(user._id);

        res.status(200).json({
            success: true,
            message: 'User successfully signed in',
            data: {
                token,
                user,
                subscription: subscriptionView(user),
            }
        });
    } catch (error) {
        next(error);
    }
}

/** Who am I, and is my plan still good? Called by the app on every launch. */
export const me = async (req, res, next) => {
    try {
        res.status(200).json({
            success: true,
            data: {
                user: req.user,
                subscription: subscriptionView(req.user),
            },
        });
    } catch (error) {
        next(error);
    }
}

/**
 * Sign-out is client-side: the JWT is stateless and short-lived, so there is
 * nothing on the server to invalidate. It answers 200 so the app has one
 * consistent call to make, and so a future token-denylist can land here without
 * a client change.
 */
export const signOut = async (req, res) => {
    res.status(200).json({ success: true, message: 'Signed out' });
}
