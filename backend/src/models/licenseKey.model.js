import mongoose from 'mongoose';

const licenseKeySchema = new mongoose.Schema({
    code: {
        type: String,
        required: true,
        unique: true,
    },
    plan: {
        type: String,
        enum: ['1_month', '3_month', 'lifetime'],
        required: true,
    },
    status: {
        type: String,
        enum: ['unused', 'redeemed', 'revoked'],
        default: 'unused',
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
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
