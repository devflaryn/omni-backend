#!/usr/bin/env python3
"""Publish rebuilt base images to the VPS and update the dist registry.

The distribution artifacts are the one thing not in git — multi-gigabyte
qcow2s that every client downloads once. When a base is rebuilt (see
omnidroid/tools/rebuild_x86_base.py) three things have to happen together, and
getting them out of step is worse than not shipping at all:

  1. the blob is replaced on the server,
  2. registry.json records the new size AND sha256, and
  3. the backend is restarted so it serves the new registry.

A client verifies sha256 after downloading and retries three times before
giving up, so a blob that does not match its registry entry is not a soft
failure — it is a first boot that cannot complete (`qemu-win: sha256 mismatch
after 3 attempts` was exactly that, from a pointer artifact given a hash it
could never satisfy).

Uploads go to a .part file and are moved into place only once the server has
verified the hash itself, so a dropped connection can never leave a truncated
blob being served as the real thing.

    python scripts/push-images.py base-x86 offset-arceus-x86
    python scripts/push-images.py --list
"""
import argparse
import hashlib
import json
import subprocess
import sys
import tarfile
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vps  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
REGISTRY = REPO / "dist" / "registry.json"
REMOTE_BLOBS = "/root/omni-backend/dist/blobs"

# How each artifact is produced from a local images dir. A tar artifact lists
# the exact members the client expects to land in `dest`; a plain one is a
# single file copied under `dest_name`.
RECIPES = {
    "base-x86": {
        "kind": "tar",
        "subdir": "x86",
        "members": ["base_x86.qcow2", "base_x86.kernel", "base_x86.initrd.img",
                    "data-template-8g.qcow2", "base_x86_devkit.qcow2"],
    },
    "offset-arceus-x86": {
        "kind": "file",
        "subdir": "x86",
        # The offset FILE is named after the bake it came from, while the
        # ARTIFACT name is stable ("offset-arceus-x86") because that is what
        # every installed client asks for. They move independently: this
        # pointed at base_x86_data_offset_arceusremote.qcow2 (2.733.988) until
        # the 2.734.917 bake replaced it.
        "member": "base_x86_data_offset_omniexec-2.734.917.qcow2",
    },
    "base-arm": {
        "kind": "tar",
        "subdir": "arm",
        "members": None,          # whole dir minus offsets; arm is built on the Mac
    },
    "offset-arceus-arm": {
        "kind": "file",
        "subdir": "arm",
        # Same split as the x86 entry above: the FILE is named after the bake,
        # the ARTIFACT name is stable because that is what clients ask for.
        # This pointed at base_arm_data_offset_arceusremote.qcow2 (2.732.1043)
        # until the 2.734.917 bake replaced it. The old bake is still on the
        # Mac as a sibling offset, so a rollback is a one-line change here.
        "member": "base_arm_data_offset_arceusremote2734.qcow2",
    },
    # App builds are produced by scripts/push-app.mjs, which already writes the
    # zip into dist/blobs and records its size and sha256. Nothing to assemble
    # here — just upload what is on disk.
    "app-win": {"kind": "prebuilt"},
    "app-mac": {"kind": "prebuilt"},
    "app-linux": {"kind": "prebuilt"},
    # Same deal: scripts/build-qemu-portable.py assembles the zip into
    # dist/blobs and registers its size and sha256. It is not built from
    # images/, so there is nothing for this script to gather.
    "qemu-portable-win": {"kind": "prebuilt"},
    # The user-facing installer, built by build-windows.ps1 -Installer and
    # copied into dist/blobs. A stub, so it does NOT need republishing for
    # each app release -- it fetches whatever app-win currently is.
    "setup-win": {"kind": "prebuilt"},
}


def sha256_of(path, label=""):
    h = hashlib.sha256()
    size = Path(path).stat().st_size
    done = 0
    last = 0.0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
            done += len(chunk)
            now = time.time()
            if now - last > 3:
                last = now
                print(f"  hashing {label}: {100*done/size:.0f}%", flush=True)
    return h.hexdigest()


def build_tar(images, recipe, out_path):
    src = images / recipe["subdir"]
    members = recipe["members"]
    if members is None:
        members = sorted(f.name for f in src.iterdir()
                         if f.is_file() and "offset" not in f.name)
    missing = [m for m in members if not (src / m).exists()]
    if missing:
        sys.exit(f"missing image files in {src}: {', '.join(missing)}")
    print(f"  packing {len(members)} file(s) from {src}")
    # Uncompressed, like the artifact it replaces: qcow2 is already compressed,
    # and gzip would cost minutes of CPU on both ends for ~nothing.
    with tarfile.open(out_path, "w") as tar:
        for m in members:
            print(f"    + {m}")
            tar.add(src / m, arcname=m)
    return out_path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*", help="artifact names from registry.json")
    # argparse runs help strings through %-formatting, so a literal % must be
    # doubled — a bare %LOCALAPPDATA% is a "badly formed help string" at import.
    ap.add_argument("--images", default=None,
                    help="local images dir (default: %%LOCALAPPDATA%%/OmniExec/images)")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--keep-tar", action="store_true",
                    help="keep the staged tar instead of deleting it")
    args = ap.parse_args()

    # encoding is explicit on purpose: registry.json contains en/em dashes in
    # its notes, and Path.read_text() defaults to the ANSI codepage on Windows —
    # which decodes them as a UnicodeDecodeError and stops a publish dead.
    registry = json.loads(REGISTRY.read_text(encoding="utf-8"))
    by_name = {a["name"]: a for a in registry["artifacts"]}

    if args.list or not args.names:
        for a in registry["artifacts"]:
            print(f"{a['name']:<20} {a.get('file') or a.get('redirect')} "
                  f"{a.get('bytes') or '-'}")
        return

    if args.images:
        images = Path(args.images)
    else:
        import os
        images = Path(os.environ.get("LOCALAPPDATA", "")) / "OmniExec" / "images"
    if not images.is_dir():
        sys.exit(f"images dir not found: {images}")

    staged = []
    tmp = Path(tempfile.mkdtemp(prefix="omni-push-"))
    try:
        for name in args.names:
            entry = by_name.get(name)
            recipe = RECIPES.get(name)
            if not entry or not recipe:
                sys.exit(f"unknown artifact {name!r}")
            print(f"[{name}] staging")
            if recipe["kind"] == "prebuilt":
                local = Path(REPO) / "dist" / "blobs" / entry["file"]
                if not local.exists():
                    sys.exit(f"{local} is missing — build and register it first "
                             f"(node scripts/push-app.mjs ...)")
            elif recipe["kind"] == "tar":
                local = build_tar(images, recipe, tmp / entry["file"])
            else:
                local = images / recipe["subdir"] / recipe["member"]
                if not local.exists():
                    sys.exit(f"missing {local}")
            digest = sha256_of(local, name)
            size = Path(local).stat().st_size
            print(f"[{name}] {size/1048576:.0f} MiB  sha256 {digest}")
            staged.append((name, entry, Path(local), size, digest))

        client = vps.connect()
        try:
            for name, entry, local, size, digest in staged:
                remote = f"{REMOTE_BLOBS}/{entry['file']}"
                part = remote + ".part"
                print(f"[{name}] uploading -> {remote}")
                vps.put(client, local, part)
                code, out, _ = vps.run(client, f"sha256sum {part} | cut -d' ' -f1",
                                       quiet=True)
                remote_digest = out.strip()
                if remote_digest != digest:
                    vps.run(client, f"rm -f {part}", check=False)
                    sys.exit(f"[{name}] UPLOAD CORRUPT: server has "
                             f"{remote_digest}, expected {digest}")
                print(f"[{name}] verified on the server")
                vps.run(client, f"mv -f {part} {remote}")
                entry["bytes"] = size
                entry["sha256"] = digest

            REGISTRY.write_text(json.dumps(registry, indent=2) + "\n")
            print("[registry] updated locally")
            sftp = client.open_sftp()
            try:
                sftp.put(str(REGISTRY), "/root/omni-backend/dist/registry.json")
            finally:
                sftp.close()
            vps.run(client, "pm2 restart omni-backend --update-env >/dev/null && "
                            "sleep 3 && curl -s -A OmniPush "
                            "'http://127.0.0.1/omni/dist/manifest?os=win'")
        finally:
            client.close()
    finally:
        if not args.keep_tar:
            import shutil
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
