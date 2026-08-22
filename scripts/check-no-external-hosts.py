#!/usr/bin/env python3
"""Guard: no un-rewritten external host survives in the OMNI-EXEC payload tree.

    python scripts/check-no-external-hosts.py

WHY THIS EXISTS. backend/src/omni-exec/payloads/ is served straight to the
Arceus X NEO executor (see omniExec.middleware.js). The executor's whole load
chain -- arceus.lua, /gist, every by-path script and image -- must resolve to
OUR server (72.62.59.232) so nothing 404s and nothing calls out to github.com,
spdmteam.com, discord, etc. at runtime. A literal external-host string sitting
in a payload file is not automatically a bug though: the middleware rewrites
some payload text at *serve time* (see rewriteLocal()/HOSTS in
omniExec.middleware.js), so those files are expected to contain raw github/
spdm URLs in the SOURCE on disk -- the client never sees them, because the
string gets swapped for LOCAL_BASE before the response leaves the server.

THE RULE THIS SCRIPT ENFORCES (mirrors omniExec.middleware.js exactly, and
re-derives HOSTS/isText from that file so the two can't silently drift):

  A literal external-host string in a payload file is OK  iff  that exact
  file is one the middleware passes through rewriteLocal() when it serves
  it. Per the middleware's current logic that is true for:

    1. payloads/gist_arceus_latest -- always rewriteLocal()'d, but ONLY on
       the fallback path taken when payloads/ui/ is empty AND
       payloads/custom_ui.lua is absent. assembleUi() (payloads/ui/*.lua)
       is tried first, then custom_ui.lua -- and NEITHER of those two goes
       through rewriteLocal(); they only get a plain __OMNI_BASE__ swap.
       So gist_arceus_latest is "ok" as a rule, but it is worth knowing it
       is normally dormant fallback content, not what's actually live.

    2. Any file under payloads/by-path/ WHOSE NAME MATCHES the middleware's
       own `isText` test:
           ends with .lua/.json/.txt/.js/.html/.css, OR
           contains one of: init, adapter, version, freekey, authfile,
                             bannedusers, announcement
       Those are read as text and piped through rewriteLocal() before
       being sent. Anything else under by-path/ (no recognized extension,
       no magic substring -- e.g. a mirrored script GitHub itself served
       with no file extension) is sent as raw bytes with NO rewrite. If a
       file like that contains a literal external-host string, that string
       reaches the client (or gets used as a live fetch target) verbatim --
       a genuine leak, not a false positive.

  Everything else -- payloads/arceus.lua (unused: arceus.lua is actually
  generated in memory, never read from disk), payloads/custom_ui.lua,
  payloads/ui/*.lua, payloads/neo_versions_required -- is served with NO
  host rewrite of any kind. A literal external host there is always a FAIL.

  A URL we have no local mirror for at all (nothing under by-path/ that
  bypathName() would resolve to) is a separate concern from this script --
  see mirror-failures.txt / the mirroring report. This script only answers
  "will an external-host STRING leak out of a payload file we serve",
  which is orthogonal to "does the request 404". A file can legitimately
  reference a host that gets rewritten to LOCAL_BASE even though nothing
  local answers that particular path yet (that shows up as a 404 from OUR
  server, not as traffic to github/spdm -- outside this script's scope).

EXIT STATUS. 0 if no file violates the rule above. 1 and a listing of
every offending file (with the matched host and line number) otherwise.
"""

import pathlib
import re
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
PAYLOADS = ROOT / "backend" / "src" / "omni-exec" / "payloads"
BYPATH = PAYLOADS / "by-path"
MIDDLEWARE = ROOT / "backend" / "src" / "omni-exec" / "omniExec.middleware.js"

# Hosts that must never leak out un-rewritten. Kept as the same filter the
# mirroring inventory used (broader than the middleware's own HOSTS array,
# so this also catches hosts the middleware doesn't yet know to rewrite --
# those are worth surfacing as loudly as ones it does).
EXTERNAL_HOST_MARKERS = [
    "githubusercontent",
    "github.com",
    "gist.github",
    "objects.githubusercontent",
    "spdmteam",
    "cdn.discordapp",
    "discord",
    "projectevo",
    "scriptblox",
]

HOST_RE = re.compile(r"https?://[^\s'\"<>`]*(?:" + "|".join(re.escape(h) for h in EXTERNAL_HOST_MARKERS) + r")[^\s'\"<>`]*", re.IGNORECASE)


def load_middleware_source() -> str:
    try:
        return MIDDLEWARE.read_text(encoding="utf-8")
    except OSError as exc:
        print(f"FATAL: could not read {MIDDLEWARE}: {exc}", file=sys.stderr)
        sys.exit(2)


def extract_is_text_predicate(src: str):
    """Re-derive the middleware's `isText` test so this script can't drift
    from it silently. Falls back to a hardcoded copy (kept identical to
    omniExec.middleware.js as of writing) if the source shape changes."""
    m = re.search(r"isText\s*=\s*/\\\.\(([a-z|]+)\)\$/i", src)
    ext_group = m.group(1) if m else "lua|json|txt|js|html|css"
    m2 = re.search(r"_\(([a-z|]+)\)", src)
    sub_group = m2.group(1) if m2 else "init|adapter|version|freekey|authfile|bannedusers|announcement"
    ext_re = re.compile(r"\.(" + ext_group + r")$", re.IGNORECASE)
    sub_re = re.compile(r"_(" + sub_group + r")", re.IGNORECASE)

    def is_text(filename: str) -> bool:
        return bool(ext_re.search(filename) or sub_re.search(filename))

    return is_text


def find_violations():
    src = load_middleware_source()
    is_text = extract_is_text_predicate(src)

    violations = []  # (path, lineno, matched_host_string)
    ok_files = []

    if not PAYLOADS.is_dir():
        print(f"FATAL: payloads dir not found: {PAYLOADS}", file=sys.stderr)
        sys.exit(2)

    for path in sorted(PAYLOADS.rglob("*")):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue

        matches = list(HOST_RE.finditer(text))
        if not matches:
            continue

        rel = path.relative_to(ROOT).as_posix()
        under_by_path = path.parent == BYPATH

        if path.name == "gist_arceus_latest":
            rewritten = True
        elif under_by_path:
            rewritten = is_text(path.name)
        else:
            rewritten = False

        if rewritten:
            ok_files.append((rel, len(matches)))
            continue

        lineno_of = {}
        for i, line in enumerate(text.split("\n"), start=1):
            if HOST_RE.search(line):
                lineno_of.setdefault(i, line.strip()[:160])
        for lineno, line in lineno_of.items():
            violations.append((rel, lineno, line))

    return violations, ok_files


def main():
    violations, ok_files = find_violations()

    print(f"payloads scanned under: {PAYLOADS.relative_to(ROOT)}")
    print(f"files with external-host text that ARE serve-time rewritten (ok): {len(ok_files)}")
    for rel, n in ok_files:
        print(f"  ok    {rel}  ({n} occurrence(s))")

    if violations:
        print(f"\nFAIL: {len(violations)} un-rewritten external-host reference(s) found:\n")
        for rel, lineno, line in violations:
            print(f"  {rel}:{lineno}: {line}")
        print(
            "\nEach of these is served with NO host rewrite (not gist_arceus_latest, "
            "and not a by-path file matching the middleware's isText test), so the "
            "external host reaches the client / gets fetched directly at runtime."
        )
        sys.exit(1)

    print("\nOK: no un-rewritten external host found in any served payload file.")
    sys.exit(0)


if __name__ == "__main__":
    main()
