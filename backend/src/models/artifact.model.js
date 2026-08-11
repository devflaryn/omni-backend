import mongoose from 'mongoose';

const artifactSchema = new mongoose.Schema({
    category: {
        type: String,
        enum: ['qemu', 'base_image', 'executor'],
        required: true,
    },
    platform: {
        type: String,
        enum: ['windows', 'macos', 'linux'],
        required: true,
    },
    arch: {
        type: String,
        enum: ['x86', 'arm', null],
        default: null,
    },
    version: {
        type: String,
        required: true,
    },
    filename: {
        type: String,
        required: true,
    },
    sha256: {
        type: String,
        required: true,
    },
    sizeBytes: {
        type: Number,
        required: true,
    },
}, { timestamps: true });

const Artifact = mongoose.model('Artifact', artifactSchema);

export default Artifact;
