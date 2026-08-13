import mongoose from 'mongoose';

import { VALID_PLANS } from '../utils/applyLicenseKey.js';

const licenseKeySchema = new mongoose.Schema({
    code: {
        type: String,
        required: true,
        unique: true,
    },
    plan: {
        type: String,
        enum: VALID_PLANS,
        required: true,
    },
    status: {
        type: String,
        enum: ['unused', 'redeemed', 'revoked'],
        default: 'unused',
    },
    // Null for keys minted by scripts/seed-keys.js, which runs before any admin
    // account can exist: sign-up now requires a key, so the very first keys have
    // to come from somewhere other than an admin pressing a button.
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    note: {
        type: String,
        default: null,
    },
    redeemedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    redeemedAt: {
        type: Date,
        default: null,
    },
}, { timestamps: true });

const LicenseKey = mongoose.model('LicenseKey', licenseKeySchema);

export default LicenseKey;
