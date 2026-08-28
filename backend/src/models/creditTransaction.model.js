import mongoose from 'mongoose';

/**
 * One row per credit movement — the audit trail behind `User.credits`.
 *
 * The balance on the user document is what gets READ; this collection is what
 * gets TRUSTED when someone disputes it. Each row stores the balance it
 * produced, so a disagreement can be walked back to the movement that caused it
 * rather than argued about.
 */
const creditTransactionSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    // Positive adds, negative removes. Integer micro-dollars.
    deltaMicros: {
        type: Number,
        required: true,
    },
    kind: {
        type: String,
        enum: ['grant', 'spend', 'admin', 'refund'],
        required: true,
    },
    // Free text for a human reading the ledger later. Admin adjustments require
    // one, so no row is a mystery a month afterwards.
    reason: {
        type: String,
        default: null,
    },
    balanceAfterMicros: {
        type: Number,
        required: true,
    },
    // Which admin performed an adjustment. Null for machine movements, so
    // "who took my credits away" always has an answer.
    actor: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    // Whatever the movement was about: the solve id, the model used, what the
    // upstream call actually cost, or the key that was redeemed.
    meta: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
    },
}, { timestamps: true });

// The ledger is almost always read as "this user's history, newest first".
creditTransactionSchema.index({ user: 1, createdAt: -1 });

const CreditTransaction = mongoose.model('CreditTransaction', creditTransactionSchema);

export default CreditTransaction;
