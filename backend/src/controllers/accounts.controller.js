import crypto from 'crypto';

import RobloxAccount from '../models/robloxAccount.model.js';
import { seal, open } from '../utils/secretBox.js';
import { presenceView } from '../utils/presence.js';

const USERNAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

const cookieHash = (cookie) => crypto.createHash('sha256').update(cookie).digest('hex');

function httpError(message, statusCode) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
}

function badUsername(name) {
    return !(typeof name === 'string' && USERNAME_RE.test(name));
}

/** Device identity comes from headers so every call carries it without a body. */
function deviceOf(req) {
    const h = req.headers;
    return {
        deviceId: (h['x-omni-device-id'] || '').toString().slice(0, 128) || null,
        deviceName: (h['x-omni-device-name'] || '').toString().slice(0, 128) || null,
        os: (h['x-omni-device-os'] || '').toString().slice(0, 32) || null,
    };
}

function view(account, viewerDeviceId) {
    const json = account.toJSON();
    return {
        username: json.username,
        userId: json.userId ?? null,
        displayName: json.displayName ?? null,
        customName: json.customName ?? null,
        placeId: json.placeId ?? null,
        group: json.group ?? null,
        notes: json.notes ?? null,
        hasCookie: !!account.cookie,
        cookieHash: json.cookieHash ?? null,
        cookieUpdatedAt: json.cookieUpdatedAt ?? null,
        updatedAt: json.updatedAt ?? null,
        presence: presenceView(account, viewerDeviceId),
    };
}

/** GET /api/v1/accounts — every account this user owns, with running state. */
export const listAccounts = async (req, res, next) => {
    try {
        const { deviceId } = deviceOf(req);
        const accounts = await RobloxAccount.find({ owner: req.user._id }).sort({ username: 1 });
        res.status(200).json({
            success: true,
            data: { accounts: accounts.map((a) => view(a, deviceId)) },
        });
    } catch (error) {
        next(error);
    }
};

/**
 * PUT /api/v1/accounts/:username — create or update. The cookie is optional:
 * a metadata-only update (place id, custom name) must not require re-sending
 * the secret, and must not wipe a stored one.
 */
export const upsertAccount = async (req, res, next) => {
    try {
        const { username } = req.params;
        if (badUsername(username)) throw httpError('Invalid account name', 400);

        const body = req.body ?? {};
        const update = { owner: req.user._id, username };

        if (typeof body.cookie === 'string' && body.cookie.trim()) {
            const cookie = body.cookie.trim();
            update.cookie = seal(cookie);
            update.cookieHash = cookieHash(cookie);
            update.cookieUpdatedAt = new Date();
        }
        if (body.userId !== undefined) update.userId = body.userId === null ? null : Number(body.userId);
        for (const field of ['displayName', 'customName', 'placeId', 'group', 'notes']) {
            if (body[field] !== undefined) {
                update[field] = body[field] === null ? null : String(body[field]).slice(0, 512);
            }
        }

        const account = await RobloxAccount.findOneAndUpdate(
            { owner: req.user._id, username },
            { $set: update },
            { new: true, upsert: true, setDefaultsOnInsert: true }
        );
        res.status(200).json({ success: true, data: { account: view(account, deviceOf(req).deviceId) } });
    } catch (error) {
        next(error);
    }
};

/**
 * GET /api/v1/accounts/:username/cookie — the secret itself.
 *
 * The one endpoint that hands back a `.ROBLOSECURITY`, and the reason the whole
 * store exists: a second machine signing into the same Omni account has to be
 * able to boot the same Roblox accounts. Owner-scoped by query, so there is no
 * path where a valid token reads someone else's cookie.
 */
export const getAccountCookie = async (req, res, next) => {
    try {
        const { username } = req.params;
        if (badUsername(username)) throw httpError('Invalid account name', 400);
        const account = await RobloxAccount.findOne({ owner: req.user._id, username });
        if (!account) throw httpError('Account not found', 404);
        if (!account.cookie) throw httpError('No cookie stored for this account', 404);

        let cookie;
        try {
            cookie = open(account.cookie);
        } catch {
            // The sealed blob no longer decrypts (key rotated, or the row predates
            // sealing). Say so plainly — silently returning a broken value would
            // surface as a mystery login failure inside a VM minutes later.
            throw httpError('Stored cookie could not be decrypted; re-add this account', 409);
        }
        res.status(200).json({
            success: true,
            data: { username: account.username, userId: account.userId, cookie },
        });
    } catch (error) {
        next(error);
    }
};

/** DELETE /api/v1/accounts/:username */
export const deleteAccount = async (req, res, next) => {
    try {
        const { username } = req.params;
        if (badUsername(username)) throw httpError('Invalid account name', 400);
        const result = await RobloxAccount.deleteOne({ owner: req.user._id, username });
        res.status(200).json({ success: true, data: { deleted: result.deletedCount } });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/v1/accounts/sync — push many accounts at once.
 *
 * This is how a machine that already holds a local accounts.json gets it into
 * the cloud in one call (first login after the upgrade), and how it keeps a
 * batch of edits from turning into N round trips.
 */
export const syncAccounts = async (req, res, next) => {
    try {
        const incoming = Array.isArray(req.body?.accounts) ? req.body.accounts : null;
        if (!incoming) throw httpError('accounts[] is required', 400);
        if (incoming.length > 500) throw httpError('too many accounts in one sync (max 500)', 413);

        const results = [];
        for (const item of incoming) {
            const username = item?.username;
            if (badUsername(username)) {
                results.push({ username: String(username).slice(0, 64), ok: false, error: 'bad_username' });
                continue;
            }
            const update = { owner: req.user._id, username };
            if (typeof item.cookie === 'string' && item.cookie.trim()) {
                const cookie = item.cookie.trim();
                update.cookie = seal(cookie);
                update.cookieHash = cookieHash(cookie);
                update.cookieUpdatedAt = new Date();
            }
            if (item.userId !== undefined && item.userId !== null) update.userId = Number(item.userId);
            for (const field of ['displayName', 'customName', 'placeId', 'group', 'notes']) {
                if (item[field] !== undefined && item[field] !== null) {
                    update[field] = String(item[field]).slice(0, 512);
                }
            }
            await RobloxAccount.updateOne(
                { owner: req.user._id, username },
                { $set: update },
                { upsert: true, setDefaultsOnInsert: true }
            );
            results.push({ username, ok: true });
        }

        const accounts = await RobloxAccount.find({ owner: req.user._id }).sort({ username: 1 });
        res.status(200).json({
            success: true,
            data: {
                results,
                accounts: accounts.map((a) => view(a, deviceOf(req).deviceId)),
            },
        });
    } catch (error) {
        next(error);
    }
};

/**
 * POST /api/v1/accounts/:username/state — presence heartbeat.
 *
 * body: { state: 'running' | 'stopped', mode?, placeId? }
 * A 'running' beat renews the lease and records WHICH machine holds it; only
 * the holder (or a beat from the same device) may clear it, so one machine
 * cannot mark another machine's session stopped.
 */
export const setAccountState = async (req, res, next) => {
    try {
        const { username } = req.params;
        if (badUsername(username)) throw httpError('Invalid account name', 400);
        const state = req.body?.state;
        if (state !== 'running' && state !== 'stopped') {
            throw httpError("state must be 'running' or 'stopped'", 400);
        }

        const account = await RobloxAccount.findOne({ owner: req.user._id, username });
        if (!account) throw httpError('Account not found', 404);

        const device = deviceOf(req);
        if (state === 'running') {
            const now = new Date();
            const sameHolder = account.running?.deviceId && account.running.deviceId === device.deviceId;
            account.running = {
                ...device,
                mode: req.body?.mode ? String(req.body.mode).slice(0, 32) : null,
                placeId: req.body?.placeId ? String(req.body.placeId).slice(0, 32) : null,
                since: sameHolder && account.running?.since ? account.running.since : now,
                heartbeatAt: now,
            };
        } else {
            const holder = account.running?.deviceId ?? null;
            if (holder && device.deviceId && holder !== device.deviceId) {
                throw httpError('That instance is held by another device', 409);
            }
            account.running = {};
        }
        await account.save();

        res.status(200).json({
            success: true,
            data: { username, presence: presenceView(account, device.deviceId) },
        });
    } catch (error) {
        next(error);
    }
};
