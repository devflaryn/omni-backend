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
    // The name the app greets you by ("Good evening, berat"). Stored as typed,
    // because capitalisation is the user's to choose.
    //
    // NOT `required` at the schema level, on purpose. Accounts created before
    // usernames existed have none, and a required field would make every one of
    // them unsaveable — redeeming a key calls user.save(), so the first thing a
    // legacy user did after the deploy would fail validation. signUp requires
    // it instead, so new accounts always have one.
    username: {
        type: String,
        trim: true,
        minLength: [3, "Username must be at least 3 characters"],
        maxLength: [24, "Username must be at most 24 characters"],
        match: [/^[A-Za-z0-9_]+$/, "Username may only contain letters, numbers and underscores"],
    },
    // Uniqueness lives here rather than on `username`, so "Berat" cannot be
    // taken twice by varying the case. A collation index on `username` would
    // also work, but every query would then have to carry the same collation
    // to hit it — one derived field is the harder thing to get wrong.
    //
    // SPARSE, because accounts predating usernames have none: a plain unique
    // index would let exactly one of them exist and reject the rest.
    usernameLower: {
        type: String,
        unique: true,
        sparse: true,
        lowercase: true,
        trim: true,
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

// `usernameLower` is derived, never assigned by a caller: setting it here means
// there is no path — controller, script or shell — that can save a user whose
// uniqueness key disagrees with the name being displayed.
userSchema.pre('validate', function deriveUsernameLower(next) {
    this.usernameLower = this.username ? this.username.toLowerCase() : undefined;
    next();
});

// The password hash must never leave the process. Every controller that answers
// with a user document went through res.json() -> toJSON(), so stripping it here
// closes the whole class of leak at once instead of one .select('-password') at
// a time — sign-up and sign-in were both handing the bcrypt hash to the client.
userSchema.set('toJSON', {
    transform(_doc, ret) {
        delete ret.password;
        delete ret.usernameLower;   // an index key, not something a client renders
        return ret;
    },
});

const User = mongoose.model('User', userSchema);

export default User;
