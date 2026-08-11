import mongoose from 'mongoose';

import connectToDatabase from '../backend/src/database/mongodb.js';
import User from '../backend/src/models/user.model.js';

const email = process.argv[2];

if (!email) {
    console.error('Usage: node scripts/promote-admin.js <email>');
    process.exit(1);
}

await connectToDatabase();

const user = await User.findOneAndUpdate(
    { email: email.trim().toLowerCase() },
    { role: 'admin' },
    { new: true }
);

if (!user) {
    console.error(`No account found for ${email}`);
    process.exit(1);
}

console.log(`✅ ${user.email} is now an admin`);
await mongoose.connection.close();
