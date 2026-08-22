#!/usr/bin/env python3
"""Syntax-check the assembled in-game UI payload.

    python scripts/check-ui-syntax.py            # assemble from payloads/ui/
    python scripts/check-ui-syntax.py FILE.lua   # check an already-dumped chunk

WHY THIS EXISTS. payloads/ui/*.lua is concatenated into one chunk and shipped
to a Roblox executor, where the only symptom of a syntax error is that the menu
never appears -- no HTTP error, no server log, nothing this repo's test suite
can observe. A parse failure in one module takes out the whole UI, and the
line number in the executor's console points into a 2000-line chunk that exists
nowhere on disk.

WHAT THIS DOES AND DOES NOT PROVE. It compiles the chunk with `load()` under
whatever Lua `lupa` provides. That is a real check of the grammar the payload
is written in -- the modules deliberately stick to the Lua subset Luau shares,
so a chunk that will not parse here will not parse there either.

It is NOT a Luau type-check and it is NOT a runtime check. `task.spawn`,
`Instance.new`, `getgenv` and every Roblox global are absent, so nothing here
executes; only the parse is exercised. Correct BEHAVIOUR is still established by
loading the payload in a live instance.

Exits 0 on success, 1 on a parse failure, and 77 when lupa is not installed --
a distinct code so a caller can tell "the check did not run" from "the check
failed", which is the difference between a skip and a broken build.
"""

import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
UI = ROOT / "backend" / "src" / "omni-exec" / "payloads" / "ui"

EXIT_UNAVAILABLE = 77


def assemble_via_middleware():
    """Ask the middleware itself for the payload.

    Deliberately NOT a reimplementation of the concatenation in Python. The
    whole point is to check what is actually served, and a second copy of the
    assembly rule would drift from the first exactly when it mattered.
    """
    script = (
        "import('./backend/src/omni-exec/omniExec.middleware.js').then(m=>{"
        "const res={status(){return res},set(){return res},"
        "end(b){process.stdout.write(b)}};"
        "m.default({url:'/gist'},res,()=>{});});"
    )
    out = subprocess.run(
        ["node", "-e", script], cwd=ROOT, capture_output=True, check=True,
    )
    return out.stdout.decode("utf-8", "replace")


def main(argv):
    try:
        import lupa
    except ImportError:
        print("lupa is not installed — skipping the Luau syntax check "
              "(pip install lupa)", file=sys.stderr)
        return EXIT_UNAVAILABLE

    if len(argv) > 1:
        source = pathlib.Path(argv[1]).read_text(encoding="utf-8")
        origin = argv[1]
    else:
        source = assemble_via_middleware()
        origin = f"{UI} (assembled)"

    runtime = lupa.LuaRuntime(unpack_returned_tuples=True)
    compile_chunk = runtime.eval(
        'function(s) local f, e = load(s, "omni-exec-ui"); return f ~= nil, e end'
    )
    ok, error = compile_chunk(source)

    lines = source.count("\n") + 1
    if ok:
        print(f"OK  {origin}: {lines} lines parse cleanly "
              f"(Lua {'.'.join(str(v) for v in runtime.lua_version)})")
        return 0

    print(f"FAIL {origin}: {error}", file=sys.stderr)
    # Name the module the failing line falls in. The chunk is assembled, so a
    # bare line number is not actionable on its own.
    try:
        line_no = int(str(error).split(":")[1])
        current = "?"
        for index, text in enumerate(source.splitlines(), start=1):
            if text.startswith("--[[ file: "):
                current = text[len("--[[ file: "):].split(" ]]")[0]
            if index == line_no:
                print(f"     line {line_no} is in {current}", file=sys.stderr)
                break
    except (IndexError, ValueError):
        pass
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
