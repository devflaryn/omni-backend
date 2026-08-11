import mongoose from 'mongoose';

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
            enum: ['1_month', '3_month', 'lifetime', null],
            default: null,
        },
        expiresAt: {
            type: Date,
            default: null,
        },
    },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

export default User;