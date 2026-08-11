import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import mongoose from 'mongoose';

import connectToDatabase from '../backend/src/database/mongodb.js';
import Artifact from '../backend/src/models/artifact.model.js';
import { DOWNLOADS_ROOT } from '../backend/src/controllers/downloads.controller.js';

const [, , sourcePath, category, platform, archArg] = process.argv;

if (!sourcePath || !category || !platform) {
    console.error('Usage: node scripts/seed-test-artifact.js <source-file> <category> <platform> [arch]');
    process.exit(1);
}

const arch = archArg || null;
const filename = `${category}/${platform}${arch ? `/${arch}` : ''}/${path.basename(sourcePath)}`;
const destination = path.join(DOWNLOADS_ROOT, filename);

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(sourcePath, destination);

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
const sizeBytes = fs.statSync(destination).size;

await connectToDatabase();

const artifact = await Artifact.create({
    category, platform, arch,
    version: `manual-${Date.now()}`,
    filename, sha256, sizeBytes,
});

console.log(`✅ seeded artifact ${artifact._id}: ${filename} (${sizeBytes} bytes, sha256=${sha256})`);
await mongoose.connection.close();
