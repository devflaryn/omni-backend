#!/usr/bin/env python3
"""Run commands and copy files to the VPS, non-interactively.

The server takes a ROOT PASSWORD, not a key, and every scriptable SSH client
on this box either prompts on a tty (OpenSSH) or is not installed (sshpass).
paramiko is the one that works unattended.

The password is read from omni-backend/.env.*.local (a `# VPS` comment block),
never passed on the command line — an argv password is readable by every
process on the host via ps, and this one is root on a public server.

    python scripts/vps.py run "pm2 restart omni-backend"
    python scripts/vps.py put local.tar /root/dest.tar
    python scripts/vps.py get /root/registry.json ./registry.json

Deploy the app itself with `deploy` (rsync-less: it tars what git tracks,
uploads once, and unpacks server-side), which is the flow the handoff
describes — the VPS deploys by file copy, so there is no merge.
"""
import os
import re
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Remote output is UTF-8 (pm2 draws box-art tables); a Windows console defaults
# to cp1252 and dies on it mid-print, which looks like the SSH call failed when
# it actually succeeded.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass
HOST = os.environ.get("OMNI_VPS_HOST", "72.62.59.232")
USER = os.environ.get("OMNI_VPS_USER", "root")


def password():
    """Root password from the `# VPS` block in an env file, or OMNI_VPS_PASS."""
    env = os.environ.get("OMNI_VPS_PASS")
    if env:
        return env
    for name in (".env.development.local", ".env.production.local"):
        path = REPO / name
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        # The block looks like:   # VPS\n# root <password>
        m = re.search(r"#\s*VPS\s*\n#\s*root\s+(\S.*)$", text, re.MULTILINE)
        if m:
            return m.group(1).strip()
    sys.exit("no VPS password found (set OMNI_VPS_PASS, or add a '# VPS' "
             "block to .env.development.local)")


def connect():
    import paramiko
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(HOST, username=USER, password=password(), timeout=30,
                   look_for_keys=False, allow_agent=False)
    return client


def run(client, command, check=True, quiet=False):
    stdin, stdout, stderr = client.exec_command(command, timeout=None)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    code = stdout.channel.recv_exit_status()
    if not quiet:
        if out.strip():
            print(out.rstrip())
        if err.strip():
            print(err.rstrip(), file=sys.stderr)
    if check and code != 0:
        sys.exit(f"remote command failed ({code}): {command}")
    return code, out, err


def put(client, local, remote):
    """Upload with visible progress — these are multi-gigabyte images and a
    silent 20-minute transfer is indistinguishable from a hang."""
    sftp = client.open_sftp()
    size = Path(local).stat().st_size
    start = time.time()
    state = {"last": 0.0}

    def progress(done, total):
        now = time.time()
        if now - state["last"] < 3 and done != total:
            return
        state["last"] = now
        rate = done / max(now - start, 0.001) / 1048576
        pct = 100.0 * done / max(total, 1)
        print(f"  {Path(local).name}: {done/1048576:.0f}/{total/1048576:.0f} MiB "
              f"({pct:.1f}%) {rate:.1f} MiB/s", flush=True)

    try:
        sftp.put(str(local), remote, callback=progress)
    finally:
        sftp.close()
    print(f"  uploaded {Path(local).name} ({size/1048576:.0f} MiB) in "
          f"{time.time()-start:.0f}s")


def get(client, remote, local):
    sftp = client.open_sftp()
    try:
        sftp.get(remote, str(local))
    finally:
        sftp.close()


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    action = sys.argv[1]
    client = connect()
    try:
        if action == "run":
            code, _, _ = run(client, " ".join(sys.argv[2:]), check=False)
            sys.exit(code)
        elif action == "put":
            put(client, sys.argv[2], sys.argv[3])
        elif action == "get":
            get(client, sys.argv[2], sys.argv[3])
        else:
            sys.exit(f"unknown action {action!r}")
    finally:
        client.close()


if __name__ == "__main__":
    main()
