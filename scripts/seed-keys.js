/*
 * Mint license keys straight into the database.
 *
 * Sign-up now requires a key, so the very first keys cannot come from the admin
 * endpoint (there is no admin yet, and there cannot be one until somebody signs
 * up). This script is that bootstrap, and doubles as the way to cut a batch
 * without going through HTTP.
 *
 *   node scripts/seed-keys.js                      # 2 of each plan
 *   node scripts/seed-keys.js 30_day 5             # 5 x 30-day
 *   node scripts/seed-keys.js lifetime 1 "for me"  # 1 lifetime, with a note
 *
 * Codes are printed once, here. Nothing else ever prints them.
 */
import mongoose from 'mongoose';

import connectToDatabase from '../backend/src/database/mongodb.js';
import LicenseKey from '../backend/src/models/licenseKey.model.js';
import { generateKeyCode } from '../backend/src/utils/generateKeyCode.js';
import { VALID_PLANS, PLAN_LABELS } from '../backend/src/utils/applyLicenseKey.js';

const [planArg, countArg, noteArg] = process.argv.slice(2);

const plans = planArg
    ? [[planArg, Number(countArg) || 1]]
    : [['30_day', 2], ['90_day', 2], ['lifetime', 2]];

for (const [plan] of plans) {
    if (!VALID_PLANS.includes(plan)) {
        console.error(`Unknown plan "${plan}". Valid: ${VALID_PLANS.join(', ')}`);
        process.exit(1);
    }
}

await connectToDatabase();

for (const [plan, count] of plans) {
    for (let i = 0; i < count; i++) {
        // Retry on the (astronomically unlikely) unique-index collision rather
        // than dying halfway through a batch.
        let key = null;
        for (let attempt = 0; attempt < 5 && !key; attempt++) {
            try {
                key = await LicenseKey.create({
                    code: generateKeyCode(),
                    plan,
                    note: noteArg || 'seeded',
                });
            } catch (error) {
                if (error.code !== 11000) throw error;
            }
        }
        if (!key) throw new Error('could not mint a unique key code after 5 attempts');
        console.log(`${key.code}   ${PLAN_LABELS[plan] ?? plan}`);
    }
}

await mongoose.connection.close();
