/**
 * Credits: the user's own view, the solver's metering hooks, and the admin desk.
 *
 * The captcha solver is a separate Python service, so it cannot be trusted to
 * say who a request belongs to. It forwards the USER'S token and its own shared
 * service secret; this file verifies both. Identity has exactly one authority
 * and it is here, not in the solver.
 */
import jwt from 'jsonwebtoken';

import User from '../models/user.model.js';
import { JWT_SECRET } from '../config/env.js';
import { displayBalanceMicros, microsToDollars } from '../utils/credits.js';
import {
    authorizeStep,
    chargeForSolve,
    adminAdjust,
    listTransactions,
    CreditsError,
} from '../services/credits.service.js';

const SERVICE_TOKEN = process.env.CAPTCHA_SERVICE_TOKEN || '';

/** Reject a service-to-service call before it costs a database lookup. */
function serviceAuthorized(req) {
    if (!SERVICE_TOKEN) return false;      // unset means the hooks are closed
    return req.get('X-Service-Token') === SERVICE_TOKEN;
}

/** Resolve the END USER from the token the solver forwarded. */
async function userFromForwardedToken(req) {
    const raw = req.body?.userToken || '';
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
    if (!token) return null;
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return await User.findById(decoded.userId).select('credits');
    } catch {
        return null;
    }
}

function balanceView(balanceMicros) {
    const shown = displayBalanceMicros(balanceMicros);
    return { balanceMicros: shown, balance: microsToDollars(shown) };
}

// --------------------------------------------------------------- the user

export const getMyCredits = async (req, res, next) => {
    try {
        const user = await User.findById(req.user._id).select('credits');
        res.status(200).json({ success: true, data: balanceView(user?.credits?.balanceMicros) });
    } catch (error) {
        next(error);
    }
};

export const getMyTransactions = async (req, res, next) => {
    try {
        res.status(200).json({
            success: true,
            data: await listTransactions(req.user._id, req.query.limit),
        });
    } catch (error) {
        next(error);
    }
};

// ------------------------------------------------------- the solver hooks

export const internalAuthorize = async (req, res, next) => {
    try {
        if (!serviceAuthorized(req)) {
            return res.status(401).json({ success: false, message: 'Bad service token' });
        }
        const user = await userFromForwardedToken(req);
        if (!user) {
            return res.status(401).json({ success: false, message: 'Bad user token' });
        }
        const { allowed, balanceMicros } = await authorizeStep(user._id);
        res.status(200).json({
            success: true,
            data: {
                allowed,
                userId: String(user._id),
                // Clamped: the solver echoes this into the client UI, which
                // must never show the small overdraft the last step can leave.
                ...balanceView(balanceMicros),
            },
        });
    } catch (error) {
        next(error);
    }
};

export const internalCharge = async (req, res, next) => {
    try {
        if (!serviceAuthorized(req)) {
            return res.status(401).json({ success: false, message: 'Bad service token' });
        }
        const user = await userFromForwardedToken(req);
        if (!user) {
            return res.status(401).json({ success: false, message: 'Bad user token' });
        }
        const { chargedMicros, balanceMicros } = await chargeForSolve(
            user._id, req.body?.upstreamCostMicros, req.body?.meta);
        res.status(200).json({
            success: true,
            data: { chargedMicros, ...balanceView(balanceMicros) },
        });
    } catch (error) {
        next(error);
    }
};

// ------------------------------------------------------------ the admin

export const adminListUsers = async (req, res, next) => {
    try {
        const q = String(req.query.q || '').trim();
        const filter = q
            ? { $or: [{ email: new RegExp(q, 'i') }, { username: new RegExp(q, 'i') }] }
            : {};
        const users = await User.find(filter)
            .select('email username role credits subscription createdAt')
            .sort({ createdAt: -1 })
            .limit(50)
            .lean();
        res.status(200).json({
            success: true,
            data: users.map((u) => ({
                ...u,
                // The admin sees the TRUE balance, overdraft included — they are
                // the one person who needs the real number to reconcile it.
                balanceMicros: u.credits?.balanceMicros ?? 0,
            })),
        });
    } catch (error) {
        next(error);
    }
};

export const adminAdjustCredits = async (req, res, next) => {
    try {
        const { deltaMicros, reason } = req.body || {};
        const { balanceMicros, user } = await adminAdjust(req.params.id, deltaMicros, {
            reason,
            actor: req.user._id,
        });
        res.status(200).json({
            success: true,
            data: { userId: String(user._id), balanceMicros },
        });
    } catch (error) {
        if (error instanceof CreditsError) {
            return res.status(error.statusCode).json({
                success: false, message: error.message,
            });
        }
        next(error);
    }
};

export const adminUserTransactions = async (req, res, next) => {
    try {
        res.status(200).json({
            success: true,
            data: await listTransactions(req.params.id, req.query.limit),
        });
    } catch (error) {
        next(error);
    }
};
