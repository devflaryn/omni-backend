#!/usr/bin/env python3
"""Publish the native-omnidroid Omni Executor (1.0.0 onward) to the dist API.

The native app lives on its OWN channel, `native`, beside the QEMU line in
`stable` (see omni-executor/bootstrap.py, NATIVE_CHANNEL). The two never see
each other's artifacts: a 1.0.44 client reading `stable` would otherwise treat
the omnidroid bundle as a base image it must download, and the native app
would be handed multi-gigabyte Bliss bases it cannot boot.

What one publish carries, per OS (`win`, `mac`):

    app-<os>-native     kind=app   the app build, zipped (what the updater fetches)
    omnidroid-<os>      runtime    the omnidroid bundle zip -> <runtime>/omnidroid
    omniexec-apk-<os>   runtime    the executor APK -> <runtime>/apk/OmniExecutor.apk
    setup-<os>          kind=tool  the installer on the download page (tools channel)

    python scripts/push-native.py --os win --version 1.0.0 \\
        --app ../omni-executor/dist-100/omni-exec \\
        --omnidroid ../_work/omnidroid-bundle-win.zip \\
        --apk ../omni-exec-android/OmniExecutor-v0.apk \\
        --setup ../omni-executor/dist-100/OmniExecutorSetup.exe
    python scripts/push-native.py ... --dry-run     # stage and hash, upload nothing

UNLIKE push-images.py, the registry written back is the SERVER's, not this
checkout's: the remote registry.json is fetched, these entries are upserted
into it, and that is what goes back up. A local registry.json that has drifted
from production (it has, more than once) can therefore never overwrite entries
somebody else published.

Every blob goes up as a `.part`, is hashed ON the server, and only then moved
into place -- a dropped upload never becomes the file clients download.
"""
import argparse
import hashlib
import json
import shutil
import sys
import tempfile
import time
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vps  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
BLOBS = REPO / "dist" / "blobs"
REMOTE_ROOT = "/root/omni-backend/dist"
REMOTE_BLOBS = f"{REMOTE_ROOT}/blobs"
REMOTE_REGISTRY = f"{REMOTE_ROOT}/registry.json"
CHANNEL = "native"


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def zip_dir(src, out):
    """Zip a build folder (or a macOS .app) UNDER its own name, as
    push-app.mjs does: the updater (updates._staged_build) looks for the one
    top-level directory in the archive. POSIX modes are kept, so an executable
    stays executable when the client unpacks it."""
    src = Path(src)
    if src.suffix != ".app" and not (src / "_internal" / "base_library.zip").is_file():
        sys.exit(f"REFUSING to publish {src}: _internal/base_library.zip is missing -- "
                 f"an incomplete PyInstaller COLLECT looks like this. Rebuild.")
    base = src.parent
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for p in sorted(src.rglob("*")):
            if p.is_symlink() or not p.is_file():
                continue
            arc = p.relative_to(base)
            info = zipfile.ZipInfo.from_file(p, str(arc).replace("\\", "/"))
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(p, "rb") as f:
                zf.writestr(info, f.read())
    return out


def stage(args, tmp):
    """[(entry, local file)] for everything this publish carries."""
    os_name, ver = args.os, args.version
    out = []
    if args.app:
        app = Path(args.app)
        z = tmp / f"omni-exec-{os_name}-{ver}-native.zip"
        if app.is_dir():
            print(f"[app-{os_name}-native] zipping {app}")
            zip_dir(app, z)
        else:
            shutil.copy2(app, z)
        out.append(({"name": f"app-{os_name}-native", "os": os_name, "channel": CHANNEL,
                     "kind": "app", "version": ver, "dest": "app", "unpack": "zip",
                     "file": z.name,
                     "notes": "Native-omnidroid desktop app build. kind=app keeps it out of "
                              "the first-boot plan; the updater fetches it by version."}, z))
    if args.omnidroid:
        src = Path(args.omnidroid)
        bundle_ver = args.omnidroid_version
        if not bundle_ver:
            try:
                with zipfile.ZipFile(src) as zf:
                    bundle_ver = json.loads(zf.read("BUNDLE.json")).get("version")
            except (KeyError, ValueError, zipfile.BadZipFile):
                bundle_ver = time.strftime("%Y%m%d")
        name = f"omnidroid-{os_name}"
        out.append(({"name": name, "os": os_name, "channel": CHANNEL, "version": bundle_ver,
                     "dest": "omnidroid", "unpack": "zip", "file": f"{name}-{bundle_ver}.zip",
                     "notes": "The native omnidroid bundle (binaries, roblox plugin, Android "
                              "sysroot), unpacked to <runtime>/omnidroid."}, src))
    if args.apk:
        src = Path(args.apk)
        name = f"omniexec-apk-{os_name}"
        out.append(({"name": name, "os": os_name, "channel": CHANNEL,
                     "version": args.apk_version or src.stem, "dest": "apk", "unpack": None,
                     "dest_name": "OmniExecutor.apk", "file": src.name,
                     "notes": "The executor APK every instance runs."}, src))
    if args.setup:
        src = Path(args.setup)
        name = f"setup-{os_name}"
        out.append(({"name": name, "os": os_name, "channel": "tools", "kind": "tool",
                     "version": ver, "dest": "setup", "unpack": None,
                     "file": f"OmniExecutorSetup-{ver}{src.suffix}",
                     "notes": "The installer on the download page. Carries the app build "
                              "(Inno Setup on Windows) -- nothing is downloaded at install."}, src))
    for entry, local in out:
        if not Path(local).is_file():
            sys.exit(f"missing {local}")
        entry["bytes"] = Path(local).stat().st_size
        entry["sha256"] = sha256_of(local)
        print(f"[{entry['name']}] {entry['bytes'] / 1048576:.1f} MiB  sha256 {entry['sha256']}")
    return out


def upsert(registry, entry):
    arts = registry.setdefault("artifacts", [])
    for i, a in enumerate(arts):
        if a.get("name") == entry["name"]:
            arts[i] = {**a, **entry}
            return "replaced"
    arts.append(entry)
    return "added"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--os", required=True, choices=("win", "mac"))
    ap.add_argument("--version", required=True, help="the app version (1.0.0)")
    ap.add_argument("--app", help="the assembled app folder / .app, or a ready zip")
    ap.add_argument("--omnidroid", help="the omnidroid bundle zip")
    ap.add_argument("--omnidroid-version")
    ap.add_argument("--apk", help="the executor APK")
    ap.add_argument("--apk-version")
    ap.add_argument("--setup", help="the installer")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    tmp = Path(tempfile.mkdtemp(prefix="omni-native-"))
    try:
        staged = stage(args, tmp)
        if not staged:
            sys.exit("nothing to publish")
        if args.dry_run:
            print(json.dumps([e for e, _ in staged], indent=2))
            return
        client = vps.connect()
        try:
            sftp = client.open_sftp()
            local_copy = tmp / "registry.remote.json"
            sftp.get(REMOTE_REGISTRY, str(local_copy))
            registry = json.loads(local_copy.read_text(encoding="utf-8"))
            backup = f"{REMOTE_REGISTRY}.bak-pre-native-{time.strftime('%Y%m%d-%H%M%S')}"
            vps.run(client, f"cp {REMOTE_REGISTRY} {backup}")
            print(f"[registry] server copy backed up to {backup}")
            for entry, local in staged:
                remote = f"{REMOTE_BLOBS}/{entry['file']}"
                part = remote + ".part"
                # The same bytes already on the server (the APK is one file for
                # both platforms): nothing to send, at ~0.6 MB/s that matters.
                _, have, _ = vps.run(client, f"[ -f {remote} ] && sha256sum {remote} | cut -d' ' -f1",
                                     check=False, quiet=True)
                if have.strip() == entry["sha256"]:
                    print(f"[{entry['name']}] already on the server; registry entry "
                          f"{upsert(registry, entry)}")
                    continue
                print(f"[{entry['name']}] uploading -> {remote}")
                vps.put(client, Path(local), part)
                _, out, _ = vps.run(client, f"sha256sum {part} | cut -d' ' -f1", quiet=True)
                if out.strip() != entry["sha256"]:
                    vps.run(client, f"rm -f {part}", check=False)
                    sys.exit(f"[{entry['name']}] UPLOAD CORRUPT: server has {out.strip()}")
                vps.run(client, f"mv -f {part} {remote}")
                print(f"[{entry['name']}] verified on the server; registry entry "
                      f"{upsert(registry, entry)}")
            text = json.dumps(registry, indent=2) + "\n"
            local_copy.write_text(text, encoding="utf-8")
            sftp.put(str(local_copy), REMOTE_REGISTRY + ".tmp")
            vps.run(client, f"mv -f {REMOTE_REGISTRY}.tmp {REMOTE_REGISTRY}")
            sftp.close()
            # Keep this checkout's copy in step with what production now serves.
            (REPO / "dist" / "registry.json").write_text(text, encoding="utf-8")
            vps.run(client, "pm2 restart omni-backend --update-env >/dev/null && sleep 3 && "
                            f"curl -s -A OmniPush 'http://127.0.0.1:8080/omni/dist/manifest?os={args.os}&channel={CHANNEL}'")
        finally:
            client.close()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
