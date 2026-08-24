import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import User from '../models/user.model.js';
import { JWT_SECRET, JWT_EXPIRES_IN } from "../config/env.js";
import {
    isSubscriptionActive,
    daysRemaining,
    PLAN_LABELS,
} from '../utils/applyLicenseKey.js';

const MIN_PASSWORD = 6;

function signToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * The subscription view every client renders from.
 *
 * `tier` is the whole account model in one word: an account is FREE until a key
 * is redeemed and PREMIUM while that plan holds, and it lapses back to free
 * rather than to a locked-out state. It is derived from `active`, not stored,
 * so an expiry can never leave the two disagreeing.
 */
export function subscriptionView(user, now = new Date()) {
    const sub = user?.subscription ?? { plan: null, expiresAt: null };
    const active = isSubscriptionActive(sub, now);
    return {
        plan: sub.plan ?? null,
        planLabel: sub.plan ? (PLAN_LABELS[sub.plan] ?? sub.plan) : null,
        expiresAt: sub.expiresAt ?? null,
        active,
        tier: active ? 'premium' : 'free',
        daysRemaining: daysRemaining(sub, now),
    };
}

function badRequest(message, statusCode = 400) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;
const USERNAME_MIN = 3;
const USERNAME_MAX = 24;

/**
 * Register. Sign-up is FREE and takes no license key.
 *
 * It used to require one, on the reasoning that an account with no plan could
 * do nothing with the app. That is no longer true: a free account is a real
 * account that owns its Roblox accounts and cookies, and a key now BUYS TIME on
 * an account that already exists (see keys.controller.js redeemKey) rather than
 * being the thing that brings one into being. One consequence worth naming: the
 * transaction is gone with the key claim, because creating a user is a single
 * write and there is no second document to keep in step with it.
 */
export const signUp = async (req, res, next) => {
    try {
        const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
        const password = typeof req.body?.password === 'string' ? req.body.password : '';
        const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';

        if (!email) throw badRequest('An email address is required');
        if (!username) throw badRequest('A username is required');
        if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
            throw badRequest(`Username must be between ${USERNAME_MIN} and ${USERNAME_MAX} characters`);
        }
        if (!USERNAME_PATTERN.test(username)) {
            throw badRequest('Username may only contain letters, numbers and underscores');
        }
        if (password.length < MIN_PASSWORD) {
            throw badRequest(`Password must be at least ${MIN_PASSWORD} characters`);
        }

        // Checked up front so the common case gets the message that names the
        // right field. The unique indexes below are what actually PREVENT a
        // duplicate — two simultaneous sign-ups both pass this check.
        if (await User.findOne({ email })) throw badRequest('User already exists', 409);
        if (await User.findOne({ usernameLower: username.toLowerCase() })) {
            throw badRequest('That username is taken', 409);
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        let user;
        try {
            user = await User.create({
                email,
                username,
                password: hashedPassword,
                subscription: { plan: null, expiresAt: null },
            });
        } catch (error) {
            // The index caught what the lookup above raced past. Which field
            // collided is in keyPattern, so the loser of the race still gets
            // told which one to change instead of a bare "duplicate key".
            if (error?.code === 11000) {
                throw badRequest(
                    error.keyPattern?.usernameLower ? 'That username is taken' : 'User already exists',
                    409
                );
            }
            throw error;
        }

        const token = signToken(user._id);

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
