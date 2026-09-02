import mongoose from 'mongoose';

import { PURCHASABLE_PLAN_IDS } from '../../../shared/plans.js';

/*
 * A guest purchase. There is deliberately no `user` ref: the whole point of
 * this flow is that nobody needs an account to buy. The email address IS the
 * identity, and it is the only thing we can deliver keys to.
 *
 * Every money field is INTEGER CENTS. Storing a price as a float is how you end
 * up charging 19.990000000000002.
 *
 * The amounts are snapshotted rather than recomputed from shared/plans.js on
 * read: an order is a record of what the buyer was actually charged, and it
 * must survive a later price change unaltered.
 */
const orderSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
    },
    planId: {
        type: String,
        enum: PURCHASABLE_PLAN_IDS,
        required: true,
    },
    quantity: {
        type: Number,
        required: true,
        min: 1,
    },

    unitPriceUsdCents: { type: Number, required: true },
    subtotalUsdCents: { type: Number, required: true },
    // The code as typed, uppercased. Kept even when the promo is later deleted,
    // because "why was this order cheaper?" must stay answerable.
    promoCode: { type: String, default: null },
    percentOff: { type: Number, default: 0 },
    discountUsdCents: { type: Number, default: 0 },
    totalUsdCents: { type: Number, required: true },

    provider: {
        type: String,
        default: 'btcpay',
    },
    // Unique so a replayed webhook can never create a second order, and so
    // findOneAndUpdate on the invoice id is safe to use as the idempotency key.
    invoiceId: {
        type: String,
        default: null,
        unique: true,
        sparse: true,
    },

    /*
     * pending  — invoice created, nothing paid
     * paid     — payment SEEN (BTCPay InvoiceProcessing); keys minted + emailed
     * settled  — payment confirmed on-chain
     * expired  — nobody paid in time
     * failed   — paid but never confirmed; any minted keys have been revoked
     *
     * Keys are issued at `paid`, not `settled`, so the buyer is not left staring
     * at a spinner for an hour. `failed` is the compensating path.
     */
    status: {
        type: String,
        enum: ['pending', 'paid', 'settled', 'expired', 'failed'],
        default: 'pending',
    },

    keys: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'LicenseKey',
    }],

    // Null until the keys email actually went out. Distinguishes "paid but the
    // mail failed" from "paid and delivered", which is the difference between a
    // support ticket and a silent loss of a paying customer.
    emailSentAt: {
        type: Date,
        default: null,
    },
    lastError: {
        type: String,
        default: null,
    },
}, { timestamps: true });

// The status page polls by id; the ops view wants recent orders for an address.
orderSchema.index({ email: 1, createdAt: -1 });

const Order = mongoose.model('Order', orderSchema);

export default Order;
