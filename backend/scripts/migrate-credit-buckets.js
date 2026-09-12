/**
 * One-shot: move legacy credits.balanceMicros into the permanent bucket.
 * We cannot tell which legacy credits were gifts vs. paid, and expiring
 * credits people already hold would generate support tickets, so ALL legacy
 * balance becomes permanent. Idempotent: users with no legacy field are skipped.
 *
 * Run: node backend/scripts/migrate-credit-buckets.js
 */
import mongoose from 'mongoose';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';

async function main() {
    await connectToDatabase();
    const cursor = User.find({ 'credits.balanceMicros': { $exists: true } }).cursor();
    let moved = 0;
    for (let u = await cursor.next(); u != null; u = await cursor.next()) {
        const legacy = u.credits?.balanceMicros || 0;
        await User.updateOne(
            { _id: u._id },
            {
                $inc: { 'credits.permanentMicros': legacy },
                $unset: { 'credits.balanceMicros': '' },
                $setOnInsert: {},
            },
        );
        moved += 1;
    }
    console.log(`[migrate] moved legacy balance for ${moved} user(s)`);
    await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
