#!/usr/bin/env python3
"""Build the `qemu-portable-win` artifact from an installed Windows QEMU.

Why this exists: the vendor's NSIS installer is manifested
requireAdministrator, so installing QEMU costs the user a UAC prompt (see
HANDOFF-WINDOWS §0). A zip we host needs no elevation at all — the client
extracts it into %LOCALAPPDATA%\\OmniExec\\qemu, which is user-writable — and
it is sha256-verified like any other artifact, which the 302-redirect
installer can never be.

    python scripts/build-qemu-portable.py [--source "C:\\Program Files\\qemu"]
                                          [--out dist/blobs/qemu-portable-win.zip]

PRUNING IS A DENY-LIST, DELIBERATELY. An allow-list of "the firmware an x86
guest needs" is the kind of guess that boots fine here and fails on a customer
machine six weeks later, because QEMU loads option ROMs lazily and by name
(efi-virtio.rom for a virtio NIC, vgabios-*.bin per display model, kvmvapic.bin,
linuxboot_dma.bin, ...). So everything in share/ is kept EXCEPT things that
cannot possibly apply: documentation, desktop-integration icons, and the UEFI
firmware images for other architectures. That is where the size is anyway --
the arm/aarch64/riscv/loongarch edk2 blobs alone are 288 MB of the 346 MB
share/ tree.

Only the three binaries omnidroid actually invokes are shipped
(qemu-system-x86_64, qemu-img, qemu-io -- grep qemu_bin( in
omnidroid/engine.py); the other ~55 system emulators are ~600 MB of
architectures this product never boots.
"""
import argparse
import hashlib
import json
import shutil
import sys
import zipfile
from pathlib import Path

# Exactly what the engine shells out to. bootstrap._QEMU_TOOLS is the client
# side of this same list, and _looks_like_qemu_dir() refuses an install that is
# missing any of them.
BINARIES = ("qemu-system-x86_64.exe", "qemu-img.exe", "qemu-io.exe")

# share/ subdirectories with no bearing on running a VM headlessly.
DROP_SHARE_DIRS = ("doc", "icons", "man", "applications", "locale")

# UEFI firmware for architectures qemu-system-x86_64 cannot execute. These
# seven files are 288 MB -- the entire reason this artifact is worth building.
# The x86/i386 edk2 images are KEPT (14 MB) even though the Bliss base boots
# with -kernel/-initrd and no UEFI: cheap insurance against a future base.
DROP_SHARE_FILES = (
    "edk2-arm-code.fd", "edk2-arm-vars.fd", "edk2-aarch64-code.fd",
    "edk2-riscv-code.fd", "edk2-riscv-vars.fd",
    "edk2-loongarch64-code.fd", "edk2-loongarch64-vars.fd",
)


def human(n):
    return f"{n / 2**20:,.1f} MB"


def build(source: Path, out: Path) -> dict:
    if not (source / BINARIES[0]).exists():
        sys.exit(f"error: {source} does not look like a QEMU install "
                 f"({BINARIES[0]} is not there)")
    staging = out.parent / "_qemu-portable-staging"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True, exist_ok=True)

    for name in BINARIES:
        src = source / name
        if not src.exists():
            sys.exit(f"error: {source} is missing {name}. The client refuses "
                     f"an incomplete QEMU, so shipping one would only move "
                     f"the failure to first launch.")
        shutil.copy2(src, staging / name)

    dlls = sorted(source.glob("*.dll"))
    if not dlls:
        sys.exit(f"error: no DLLs beside {BINARIES[0]} — this looks like a "
                 f"non-standard layout, and a QEMU without its DLLs will not "
                 f"start.")
    for dll in dlls:
        shutil.copy2(dll, staging / dll.name)

    share_src, share_dst = source / "share", staging / "share"
    share_dst.mkdir(parents=True, exist_ok=True)
    dropped = 0
    for item in share_src.iterdir():
        if item.is_dir():
            if item.name in DROP_SHARE_DIRS:
                dropped += sum(f.stat().st_size
                               for f in item.rglob("*") if f.is_file())
                continue
            shutil.copytree(item, share_dst / item.name)
        else:
            if item.name in DROP_SHARE_FILES:
                dropped += item.stat().st_size
                continue
            shutil.copy2(item, share_dst / item.name)

    raw = sum(f.stat().st_size for f in staging.rglob("*") if f.is_file())
    print(f"  binaries : {len(BINARIES)}")
    print(f"  dlls     : {len(dlls)}")
    print(f"  pruned   : {human(dropped)}")
    print(f"  staged   : {human(raw)}")

    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.unlink()
    print(f"  zipping  -> {out}")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for f in sorted(staging.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(staging))
    shutil.rmtree(staging, ignore_errors=True)

    h = hashlib.sha256()
    with open(out, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    info = {"bytes": out.stat().st_size, "sha256": h.hexdigest()}
    print(f"  zipped   : {human(info['bytes'])}")
    print(f"  sha256   : {info['sha256']}")
    return info


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--source", default=r"C:\Program Files\qemu",
                    help="an installed Windows QEMU to build from")
    ap.add_argument("--out", default=None,
                    help="output zip (default dist/blobs/qemu-portable-win.zip)")
    ap.add_argument("--register", action="store_true",
                    help="also write the artifact into dist/registry.json")
    ap.add_argument("--version-label", default=None,
                    help="override the registry version string. The client "
                         "upgrades on a sha256 receipt mismatch, NOT on this "
                         "(see bootstrap.qemu_install_plan), so this is "
                         "human-facing only -- but a patched build and the "
                         "vendor build both report the same upstream version, "
                         "and a registry an operator cannot read is how the "
                         "wrong one gets shipped twice.")
    args = ap.parse_args()

    repo = Path(__file__).resolve().parent.parent
    out = Path(args.out) if args.out else \
        repo / "dist" / "blobs" / "qemu-portable-win.zip"
    print(f"[qemu-portable] from {args.source}")
    info = build(Path(args.source), out)

    if args.register:
        reg_path = repo / "dist" / "registry.json"
        reg = json.loads(reg_path.read_text(encoding="utf-8"))
        entry = {
            "name": "qemu-portable-win",
            "os": "win",
            # NOT "stable". This is a sha256'd artifact with a dest, so to any
            # client older than the kind="tool" rule it is indistinguishable
            # from a base image: it would enter the first-boot download plan
            # and make every already-installed machine report un-ready forever
            # (readiness == "the plan is empty"). Its own channel means those
            # clients never see it. See bootstrap._TOOLS_CHANNEL.
            "channel": "tools",
            # kind=tool keeps it out of the first-boot runtime download plan,
            # exactly like kind=app. ensure_tools() owns it and installs it
            # only when the machine has no QEMU; leaving it in the plan would
            # both double-download it and make every machine that already had
            # QEMU look permanently un-ready (readiness == "the plan is
            # empty"). See bootstrap.plan_downloads.
            "kind": "tool",
            "version": args.version_label or _qemu_version(Path(args.source)),
            "dest": "qemu",
            "unpack": "zip",
            "file": out.name,
            "bytes": info["bytes"],
            "sha256": info["sha256"],
            "notes": ("Pruned portable QEMU (x86_64 only: the three binaries "
                      "omnidroid invokes, all DLLs, and share/ minus docs, "
                      "icons and the non-x86 UEFI firmware). Exists so a "
                      "fresh install needs NO administrator prompt -- the "
                      "vendor NSIS installer is requireAdministrator, this "
                      "is a zip into %LOCALAPPDATA%. The client prefers it "
                      "over qemu-win whenever it is present."),
        }
        arts = [a for a in reg["artifacts"] if a["name"] != "qemu-portable-win"]
        # Ahead of qemu-win, so a human reading the registry sees the
        # preferred route first.
        idx = next((i for i, a in enumerate(arts) if a["name"] == "qemu-win"),
                   len(arts))
        arts.insert(idx, entry)
        reg["artifacts"] = arts
        reg_path.write_text(json.dumps(reg, indent=2) + "\n", encoding="utf-8")
        print(f"[qemu-portable] registry.json updated")
        print(f"[qemu-portable] now upload it:  python scripts/push-images.py "
              f"qemu-portable-win")


def _qemu_version(source: Path) -> str:
    import subprocess
    try:
        out = subprocess.run([str(source / "qemu-system-x86_64.exe"),
                              "--version"], capture_output=True, text=True,
                             timeout=60).stdout
        for tok in out.split():
            if tok[:1].isdigit() and "." in tok:
                return tok
    except (OSError, subprocess.SubprocessError):
        pass
    return "unknown"


if __name__ == "__main__":
    main()
