// Talks to the OMNI-EXEC distribution API on this same origin (server.js mounts
// it at /omni/dist). We read the published app version from the manifest and
// probe each platform's installer blob so the download page reflects what is
// actually available right now — publish a setup-mac / setup-linux artifact and
// its card lights up on its own, no frontend change needed.

const BLOB = (name) => `/omni/dist/blob/${name}`;

export const PLATFORMS = [
    { id: "win",   name: "Windows",  os: "win",   ext: ".exe",      filename: "OmniExecutorSetup.exe",
      meta: "Windows 10 / 11 · 64-bit", note: "Per-user install. No administrator needed." },
    { id: "mac",   name: "macOS",    os: "mac",   ext: ".dmg",      filename: "OmniExecutor.dmg",
      meta: "macOS 12+ · Apple silicon", note: "Signed app bundle." },
    { id: "linux", name: "Linux",    os: "linux", ext: ".AppImage", filename: "OmniExecutor.AppImage",
      meta: "x86-64 · glibc 2.31+",       note: "Portable AppImage." },
];

export async function fetchVersion() {
    try {
        const r = await fetch(`/omni/dist/manifest?os=win`, { cache: "no-store" });
        if (!r.ok) return null;
        const j = await r.json();
        return j?.app?.version ?? null;
    } catch { return null; }
}

// A HEAD to the installer blob: 200 → downloadable now, anything else → not yet.
export async function probeInstaller(os) {
    try {
        const r = await fetch(BLOB(`setup-${os}`), { method: "HEAD", cache: "no-store" });
        return r.ok ? { available: true, url: BLOB(`setup-${os}`) } : { available: false };
    } catch { return { available: false }; }
}

export function detectOS() {
    const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toLowerCase();
    if (p.includes("win")) return "win";
    if (p.includes("mac") || p.includes("iphone") || p.includes("ipad")) return "mac";
    if (p.includes("linux") || p.includes("x11") || p.includes("android")) return "linux";
    return "win";
}
