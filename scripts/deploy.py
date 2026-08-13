#!/usr/bin/env python3
"""Deploy the backend to the VPS: upload the tracked tree, install, restart.

Deliberately NOT a git pull on the server. The repo is private, the server has
no deploy key, and the thing that must go live is the working tree that was
just tested here — not whatever a remote branch happens to hold.

What it does NOT touch: dist/blobs (multi-gigabyte images, uploaded separately
by scripts/push-images.py), .env.*.local (the server's own secrets), and
node_modules (installed server-side against the server's node).

    python scripts/deploy.py [--no-restart] [--dry-run]
"""
import argparse
import io
import subprocess
import sys
import tarfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import vps  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
REMOTE = "/root/omni-backend"

# Files git tracks, minus the ones the server owns or that are far too big.
SKIP_PREFIXES = ("dist/blobs/", "node_modules/", ".env")


def tracked_files():
    out = subprocess.run(["git", "ls-files"], cwd=REPO, capture_output=True,
                         text=True, check=True).stdout
    files = []
    for line in out.splitlines():
        rel = line.strip()
        if not rel or rel.startswith(SKIP_PREFIXES):
            continue
        if (REPO / rel).is_file():
            files.append(rel)
    return files


def make_tar(files):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for rel in files:
            tar.add(REPO / rel, arcname=rel)
    buf.seek(0)
    return buf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-restart", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    files = tracked_files()
    print(f"[deploy] {len(files)} tracked file(s)")
    if args.dry_run:
        for rel in files[:40]:
            print("   ", rel)
        return

    blob = make_tar(files)
    size = len(blob.getvalue())
    print(f"[deploy] bundle {size/1024:.0f} KiB")

    client = vps.connect()
    try:
        stamp = str(int(time.time()))
        remote_tar = f"/tmp/omni-backend-{stamp}.tar.gz"
        sftp = client.open_sftp()
        try:
            sftp.putfo(blob, remote_tar)
        finally:
            sftp.close()
        print(f"[deploy] uploaded -> {remote_tar}")

        vps.run(client, f"mkdir -p {REMOTE} && tar -xzf {remote_tar} -C {REMOTE} "
                        f"&& rm -f {remote_tar}")
        print("[deploy] unpacked")

        # --omit=dev: the server runs it, it does not test or lint it.
        vps.run(client, f"cd {REMOTE} && npm install --omit=dev --no-audit "
                        f"--no-fund 2>&1 | tail -5")

        if not args.no_restart:
            vps.run(client, "pm2 restart omni-backend --update-env && sleep 3 && "
                            "pm2 describe omni-backend | grep -E 'status|restarts' "
                            "| head -4")
            # Prove it actually came back rather than crash-looping quietly.
            code, out, _ = vps.run(
                client,
                "curl -s -o /dev/null -w '%{http_code}' -A OmniDeploy "
                "http://127.0.0.1/omni/dist/health", check=False)
            print(f"[deploy] health check HTTP {out.strip()}")
            if out.strip() != "200":
                vps.run(client, "pm2 logs omni-backend --lines 30 --nostream",
                        check=False)
                sys.exit("[deploy] the server did not come back healthy")
        print("[deploy] done")
    finally:
        client.close()


if __name__ == "__main__":
    main()
