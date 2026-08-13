import mongoose from 'mongoose';

import { VALID_PLANS } from '../utils/applyLicenseKey.js';

const userSchema = new mongoose.Schema({
    email: {
        type: String,
        required: [true, "Email is required"],
        unique: true,
        trim: true,
        lowercase: true,
        match: [/\S+@\S+\.\S+/, "Please fill a valid email address"],
    },
    password: {
        type: String,
        required: [true, "Password is required"],
        minLength: 6
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user',
    },
    subscription: {
        plan: {
            type: String,
            enum: [...VALID_PLANS, null],
            default: null,
        },
        expiresAt: {
            type: Date,
            default: null,
        },
    },
}, { timestamps: true });

// The password hash must never leave the process. Every controller that answers
// with a user document went through res.json() -> toJSON(), so stripping it here
// closes the whole class of leak at once instead of one .select('-password') at
// a time — sign-up and sign-in were both handing the bcrypt hash to the client.
userSchema.set('toJSON', {
    transform(_doc, ret) {
        delete ret.password;
        return ret;
    },
});

const User = mongoose.model('User', userSchema);

export default User;
