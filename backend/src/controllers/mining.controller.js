import crypto from 'crypto';
import MinerSession, { hashToken } from '../models/minerSession.model.js';
import { miningConfig } from '../config/mining.js';
import { getUserMiningStatus } from '../services/mining/accounting.js';

export const enroll = async (req, res, next) => {
    try {
        const raw = crypto.randomBytes(24).toString('hex');
        // One active session per user: rotate by revoking old ones.
        await MinerSession.updateMany({ user: req.user._id, revokedAt: null },
            { $set: { revokedAt: new Date() } });
        await MinerSession.create({ user: req.user._id, tokenHash: hashToken(raw) });
        const cfg = miningConfig();
        res.status(200).json({
            success: true,
            data: {
                minerToken: raw,
                stratumHost: cfg.stratumHost,
                stratumPort: cfg.stratumPort,
                algos: { cpu: 'rx/0', gpu: 'kawpow' },
            },
        });
    } catch (error) { next(error); }
};

export const status = async (req, res, next) => {
    try {
        res.status(200).json({ success: true, data: await getUserMiningStatus(req.user._id) });
    } catch (error) { next(error); }
};
