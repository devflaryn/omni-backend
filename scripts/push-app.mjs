/*
 * Publish a desktop-app build so installed copies can update themselves.
 *
 * The dist API already serves base images; an app build is the same kind of
 * named blob with `kind: "app"`, which is what keeps it OUT of the first-boot
 * download plan — a machine installing for the first time already has the app
 * it is running, and pulling another 86 MB copy of it would be pure waste.
 *
 *   node scripts/push-app.mjs win 1.1.0 ../omni-executor/dist/omni-exec
 *   node scripts/push-app.mjs mac 1.1.0 ../omni-executor/dist/OmniExecutor.app
 *
 * Zips the build, records size + sha256 in dist/registry.json, and leaves the
 * blob in dist/blobs/ for scripts/push-images.py (or any copy) to upload. The
 * VERSION is what clients compare against, so it must go up: the updater
 * refuses to install a build that is not newer than the one running.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REGISTRY = path.join(REPO, 'dist', 'registry.json');
const BLOBS = path.join(REPO, 'dist', 'blobs');

const [osName, version, buildDir] = process.argv.slice(2);

if (!osName || !version || !buildDir) {
    console.error('usage: node scripts/push-app.mjs <win|mac> <version> <build-dir>');
    process.exit(1);
}
if (osName !== 'win' && osName !== 'mac') {
    console.error(`os must be "win" or "mac", got ${osName}`);
    process.exit(1);
}
if (!/^\d+\.\d+\.\d+/.test(version)) {
    console.error(`version must look like 1.2.3, got ${version}`);
    process.exit(1);
}
if (!fs.existsSync(buildDir)) {
    console.error(`build dir not found: ${buildDir}`);
    process.exit(1);
}

const name = `app-${osName}`;
const file = `omni-exec-${osName}-${version}.zip`;
const zipPath = path.join(BLOBS, file);
fs.mkdirSync(BLOBS, { recursive: true });

// Refuse a version that does not match the build's own APP_VERSION.
//
// This is the guard against the drift that shipped 1.0.25/1.0.26 as builds
// still reporting 1.0.24: updates.py's APP_VERSION is what the running app
// tells the world it is, and if it lags the number published here, every
// client "updates" forever to a build that still claims the old version. The
// build dir is `<omni-executor>/dist-XXXX/omni-exec`, so the source is two
// levels up. If it cannot be read (a build from elsewhere), warn but proceed —
// the check is a safety net, not a new hard dependency on repo layout.
try {
    const srcRoot = path.dirname(path.dirname(path.resolve(buildDir)));
    const updatesPy = fs.readFileSync(path.join(srcRoot, 'updates.py'), 'utf8');
    const m = updatesPy.match(/^APP_VERSION\s*=\s*["']([^"']+)["']/m);
    if (m && m[1] !== version) {
        console.error(
            `version mismatch: publishing ${version} but the build's APP_VERSION `
            + `is ${m[1]} (omni-executor/updates.py).\n`
            + `Bump APP_VERSION to ${version} and REBUILD before publishing, or the `
            + `installed app will report ${m[1]} forever and update in a loop.`);
        process.exit(1);
    }
    if (!m) console.warn('[app-win] note: could not find APP_VERSION in updates.py to cross-check');
} catch {
    console.warn('[app-win] note: updates.py not found next to the build; skipping version cross-check');
}

// Refuse an incomplete build BEFORE it can be published.
//
// A one-dir PyInstaller build whose COLLECT step was disturbed — by an
// omni-exec.exe still running out of the same directory, which is easy to do —
// still produces a launchable-looking tree. One was published at 31 MB with
// ZERO frontend files in it: an app that would start and then show nothing.
// The exe alone proves nothing; the frontend and the bundled engine are what
// make it the product.
const REQUIRED = [
    process.platform === 'win32' ? 'omni-exec.exe' : 'omni-exec',
    path.join('_internal', 'frontend', 'dist', 'index.html'),
];
for (const rel of REQUIRED) {
    if (!fs.existsSync(path.join(buildDir, rel))) {
        console.error(`[${name}] REFUSING to publish: ${rel} is missing from `
            + `${buildDir}. The build is incomplete — rebuild with nothing `
            + `running out of that directory.`);
        process.exit(1);
    }
}
const MIN_MB = 60;
function treeSize(dir) {
    let total = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        total += e.isDirectory() ? treeSize(p) : fs.statSync(p).size;
    }
    return total;
}
const sizeMb = treeSize(buildDir) / 1048576;
if (sizeMb < MIN_MB) {
    console.error(`[${name}] REFUSING to publish: build is ${sizeMb.toFixed(0)} MB, `
        + `expected at least ${MIN_MB} MB. A truncated COLLECT looks like this.`);
    process.exit(1);
}
console.log(`[${name}] build looks complete (${sizeMb.toFixed(0)} MB)`);

console.log(`[${name}] zipping ${buildDir}`);
fs.rmSync(zipPath, { force: true });
// Zip the build directory ITSELF, so the archive has one top-level folder and
// the client can identify what it just unpacked instead of guessing which of N
// loose entries is the app.
const parent = path.dirname(path.resolve(buildDir));
const leaf = path.basename(path.resolve(buildDir));
if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
        `Compress-Archive -Path "${path.join(parent, leaf)}" -DestinationPath "${zipPath}" -Force`],
        { stdio: 'inherit' });
} else {
    execFileSync('zip', ['-qr', zipPath, leaf], { cwd: parent, stdio: 'inherit' });
}

const bytes = fs.statSync(zipPath).size;
const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
console.log(`[${name}] ${(bytes / 1048576).toFixed(0)} MiB  sha256 ${sha256}`);

const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
registry.app = { ...(registry.app || {}), version };
const entry = {
    name,
    os: osName,
    channel: 'stable',
    kind: 'app',
    version,
    dest: 'app',
    unpack: 'zip',
    file,
    bytes,
    sha256,
    root: leaf,
    notes: 'Desktop app build. kind=app keeps it out of the first-boot runtime '
        + 'download plan; the client stages it, swaps it in and relaunches.',
};
const i = registry.artifacts.findIndex((a) => a.name === name);
if (i >= 0) {
    const old = registry.artifacts[i];
    if (old.file !== file) {
        console.log(`[${name}] previous build ${old.file} is now unreferenced — `
            + `delete it from dist/blobs when you are done`);
    }
    registry.artifacts[i] = entry;
} else {
    registry.artifacts.push(entry);
}
fs.writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`[${name}] registry.json updated (app.version = ${version})`);
console.log(`[${name}] now upload it:  python scripts/push-images.py ${name}`);
