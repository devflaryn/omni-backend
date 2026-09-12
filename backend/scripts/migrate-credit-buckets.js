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
    // .lean(): 'credits.balanceMicros' is not a schema path (it was retired in
    // favor of permanentMicros/subscriptionMicros), so a hydrated Mongoose
    // document would silently read undefined for it even though the raw
    // driver document still has it.
    const cursor = User.find({ 'credits.balanceMicros': { $exists: true } })
        .select('credits')
        .lean()
        .cursor();
    let moved = 0;
    for (let u = await cursor.next(); u != null; u = await cursor.next()) {
        const legacy = u.credits?.balanceMicros || 0;
        // strict: false — 'credits.balanceMicros' is not in the schema, and
        // Mongoose's default strict casting silently drops unknown paths from
        // an update object, so the $unset would otherwise be a no-op.
        await User.updateOne(
            { _id: u._id },
            {
                $inc: { 'credits.permanentMicros': legacy },
                $unset: { 'credits.balanceMicros': '' },
            },
            { strict: false },
        );
        moved += 1;
    }
    console.log(`[migrate] moved legacy balance into permanentMicros for ${moved} user(s)`);
    await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
