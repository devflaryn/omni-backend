import mongoose from 'mongoose';
import crypto from 'crypto';

/** A per-user miner credential. The raw token is shown ONCE at enroll and never
 *  stored; only its SHA-256 lives here, so a DB leak cannot mine as anyone. */
const minerSessionSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    lastSeenAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
}, { timestamps: true });

export function hashToken(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

minerSessionSchema.statics.resolveToken = async function resolveToken(raw) {
    if (!raw) return null;
    const doc = await this.findOne({ tokenHash: hashToken(raw), revokedAt: null }).lean();
    return doc ? String(doc.user) : null;
};

const MinerSession = mongoose.model('MinerSession', minerSessionSchema);
export default MinerSession;
