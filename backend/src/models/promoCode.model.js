import mongoose from 'mongoose';

/*
 * An admin-created percentage discount.
 *
 * `redemptions` counts SUCCESSFUL PAYMENTS only. Quoting a code, or creating an
 * invoice that is never paid, must not burn a redemption — otherwise a handful
 * of window-shoppers can exhaust a 100-use launch code before anyone buys.
 */
const promoCodeSchema = new mongoose.Schema({
    // Stored uppercase; lookups uppercase the input. "omni20" and "OMNI20" are
    // the same code to a customer, so they must be the same code to us.
    code: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        uppercase: true,
    },
    percentOff: {
        type: Number,
        required: true,
        min: 1,
        // Capped at 99, not 100: a 100% discount means a zero total, and
        // BTCPay refuses zero-amount invoices - the order would fail at
        // payment instead of issuing free keys. Comp keys need their own
        // no-invoice path, not a 100% code.
        max: 99,
    },
    // null = never expires.
    expiresAt: {
        type: Date,
        default: null,
    },
    // null = unlimited.
    maxRedemptions: {
        type: Number,
        default: null,
    },
    redemptions: {
        type: Number,
        default: 0,
    },
    // A kill switch that does not destroy the audit trail, unlike deleting.
    active: {
        type: Boolean,
        default: true,
    },
    note: {
        type: String,
        default: null,
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
}, { timestamps: true });

/**
 * Is this code usable right now? Pure, so it can be unit-tested without a DB
 * and reused by both the quote endpoint and the checkout endpoint — the two
 * must never disagree about whether a code is valid.
 */
promoCodeSchema.methods.isUsable = function isUsable(now = new Date()) {
    if (!this.active) return false;
    if (this.expiresAt && this.expiresAt <= now) return false;
    if (this.maxRedemptions !== null && this.redemptions >= this.maxRedemptions) return false;
    return true;
};

const PromoCode = mongoose.model('PromoCode', promoCodeSchema);

export default PromoCode;
