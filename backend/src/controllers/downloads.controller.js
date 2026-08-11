import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import Artifact from '../models/artifact.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/src/controllers -> backend/src -> backend -> omni-backend (root) -> storage/downloads
export const DOWNLOADS_ROOT = path.resolve(__dirname, '../../../storage/downloads');

const CATEGORIES = ['qemu', 'base_image', 'executor'];
const PLATFORMS = ['windows', 'macos', 'linux'];

async function latestArtifacts() {
    const all = await Artifact.find().sort({ createdAt: -1 }).lean();
    const latest = new Map();
    for (const artifact of all) {
        const key = `${artifact.category}:${artifact.platform}:${artifact.arch ?? ''}`;
        if (!latest.has(key)) {
            latest.set(key, artifact);
        }
    }
    return [...latest.values()];
}

export const getManifest = async (req, res, next) => {
    try {
        const artifacts = await latestArtifacts();
        const data = artifacts.map((a) => ({
            category: a.category,
            platform: a.platform,
            arch: a.arch,
            version: a.version,
            sha256: a.sha256,
            sizeBytes: a.sizeBytes,
            url: `/api/v1/downloads/file/${a.category}/${a.platform}${a.arch ? `?arch=${a.arch}` : ''}`,
        }));
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const downloadFile = async (req, res, next) => {
    try {
        const { category, platform } = req.params;
        const arch = typeof req.query.arch === 'string' ? req.query.arch : null;

        if (!CATEGORIES.includes(category) || !PLATFORMS.includes(platform)) {
            const error = new Error('Unknown category or platform');
            error.statusCode = 404;
            throw error;
        }

        const artifact = await Artifact.findOne({ category, platform, arch }).sort({ createdAt: -1 });
        if (!artifact) {
            const error = new Error('No artifact published for that category/platform/arch');
            error.statusCode = 404;
            throw error;
        }

        const resolved = path.resolve(DOWNLOADS_ROOT, artifact.filename);
        if (!resolved.startsWith(DOWNLOADS_ROOT + path.sep)) {
            const error = new Error('Invalid artifact path');
            error.statusCode = 500;
            throw error;
        }
        if (!fs.existsSync(resolved)) {
            const error = new Error('Artifact is published but its file is missing on disk');
            error.statusCode = 404;
            throw error;
        }

        res.sendFile(resolved);
    } catch (error) {
        next(error);
    }
};
