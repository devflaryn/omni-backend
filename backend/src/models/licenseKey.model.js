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
    // OVERRIDES the plan's default grant when set. This is what makes a gift
    // key possible: a full 30-day plan that carries only  of solving credit.
    // null means 'use the plan default'; an explicit 0 means 'grant nothing',
    // and the two must not be conflated.
    creditsMicros: {
        type: Number,
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

    // ---- guest checkout ----
    // The order this key was sold on. Null for admin- and script-minted keys.
    order: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Order',
        default: null,
    },
    // Who we emailed it to. The buyer has no account, so this address is the
    // only link between a key and the person who paid for it.
    issuedToEmail: {
        type: String,
        default: null,
    },

    // ---- reversal bookkeeping, written at redeem time ----
    // Snapshot of the subscription BEFORE this key was applied. Only used to
    // restore a `lifetime` revocation, which has no duration to subtract.
    subscriptionBefore: {
        plan: { type: String, default: null },
        expiresAt: { type: Date, default: null },
    },
    // The EXACT milliseconds this key added to expiresAt. Recorded rather than
    // recomputed so revocation subtracts precisely what was granted, even when
    // other keys were stacked afterwards.
    grantedMs: {
        type: Number,
        default: null,
    },
    creditsGrantedMicros: {
        type: Number,
        default: null,
    },

    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, default: null },
}, { timestamps: true });

const LicenseKey = mongoose.model('LicenseKey', licenseKeySchema);

export default LicenseKey;
