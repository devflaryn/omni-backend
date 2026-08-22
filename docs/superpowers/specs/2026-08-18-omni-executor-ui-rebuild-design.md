# Omni Executor in-game UI — rebuild

**Date:** 2026-08-18
**Scope:** the Luau payload served from `/gist`, the middleware that assembles it,
and the one Omnidroid boot step that makes host detection possible.
**Not in scope:** farming-mode resource work. That is a separate project.

## Why

The in-game menu today (`payloads/custom_ui.lua`, 308 lines) is a proof that the
chain works, not a product. It announces itself with a purple `OE` circle, its
window holds a click-counter and a clipboard test, and it presents the same way
whether it is running on a customer's phone or inside an unattended Omnidroid
farming instance — where a permanent floating button is the one thing that
should never be on screen.

Three things change:

1. **An intro.** A soft ambient glow sweeps in from every screen edge, drifts
   through a palette, and disappears — the Gemini/Chrome "ambient glow" shape.
   It is the product's first frame and it replaces "a purple circle appeared".
2. **The entry point becomes host-aware.** A generic Android device or emulator
   gets the floating toggle. An Omnidroid guest gets a top-centre pill saying
   the executor connected, which dismisses itself and leaves the client clean.
3. **The menu becomes real.** A script editor, player/utility toggles, and a
   session status panel, behind a left icon rail.

## Host detection

The payload asks `isfile("omni_host.data")`. Omnidroid writes that marker into
the executor's workspace during boot; nothing else does.

`isfile` / `writefile` are confirmed present on this executor — the stock Arceus
gist uses them, relative-path style (`isfile("warning.data")`), which also fixes
the calling convention: paths resolve against the executor's own workspace, not
against `/`.

**The workspace's location on disk is not yet established.** Arceus X NEO *is*
the patched `com.roblox.client`, so it is somewhere under that package's storage,
but nothing in the Omnidroid tree names it. Two consequences, both deliberate:

* `omnidroid/execmark.py` writes the marker into **every plausible workspace
  root**, creating each. The file is 20 bytes and the write is idempotent, so
  the cost of being wrong about seven of eight candidates is nothing.
* `omnidroid exec-mark <name> [--probe]` resolves it **as fact** against a live
  instance: it writes, then reads back which roots a process can actually see.
  Whatever it reports belongs at the TOP of `CANDIDATE_ROOTS` rather than
  replacing the list — a future APK can move its workspace again.

**Revised 2026-08-22 — none of this existed.** The spec described `execmark.py`
and `exec-probe`; neither was ever written, so `isfile("omni_host.data")`
answered false on every guest that has ever run this payload and the Omnidroid
branch of the menu had never once executed. It is now built, and wired into
`_ensure_booted` immediately after `apply_consent` (that ordering is a
dependency: the marker's fallback roots are on the sdcard, which is the half
full-disk-access unlocks). Kill switch `OMNI_NO_EXECMARK=1`, which is also how
the phone/emulator branch gets exercised without a phone.

The marker carries `omnidroid:<mode>`, and **ownership is the part that fails
silently**: adb is uid 0, the executor runs as the app's uid, and a root-owned
file inside a root-created directory answers `isfile` with false while sitting
exactly where it belongs. So each created path is chowned to whoever owns the
package directory, left world-readable, and `restorecon`ed — an app-data file
created by root otherwise carries the shell's SELinux label and SEAndroid
denies the read even when the Unix mode allows it.

**Detection fails open.** No marker means "generic device", which is the branch
that always leaves a visible way into the menu. A missed detection therefore
costs one unwanted button on a farming instance; the inverse default would cost
a customer their only route into the product.

## Assembly

The payload is authored as `payloads/ui/*.lua` and concatenated by
`omniExec.middleware.js` in filename order into one chunk, wrapped in one
`pcall`, with `__OMNI_BASE__` substituted over the result. `custom_ui.lua`
remains the fallback when `ui/` is absent.

| file | holds |
|---|---|
| `00_prelude.lua` | watchdog stubs, services, host detection, the `OMNI` state table |
| `10_theme.lua` | palette and instance helpers |
| `20_glow.lua` | the intro animation |
| `30_entry.lua` | toggle · connected popup · top-edge reveal |
| `40_window.lua` | window shell, icon rail, tab switching |
| `50_script.lua` | script editor page |
| `60_toggles.lua` | player/utility page |
| `70_status.lua` | session status page |
| `80_bridge.lua` | remote-exec bridge (moved, not rewritten) |
| `90_boot.lua` | the sequence |

Concatenation is a *file* split, not a *scope* split: every module lands in one
Luau chunk, so a `local` in the prelude is visible to all of them. Luau caps a
function at 200 locals and the chunk is a function, so anything not needed by
name lives on `OMNI` instead of becoming another top-level local.

A `--[[ file: 20_glow.lua ]]` banner precedes each module so a syntax error
names the file it came from.

## The glow

**Revised 2026-08-22 — the sweep is Google's, and it is directed.** The
original drifted a pale periwinkle/mint/lime palette as a LOOP. A loop has no
beginning and no end: it arrives on whatever hue the clock landed on and wraps
back through everything between. The sweep now travels once, `#F7A858` orange →
`#68C384` green → `#6C9CF2` blue, and stops there — which is what makes it read
as one gesture rather than as a rainbow.

Two mechanical consequences, both in `20_glow.lua`:

* `sampleGlow` **clamps** instead of wrapping, so `t <= 0` is the first stop and
  `t >= 1` is the last;
* each edge carries a **lag** rather than a phase offset, and the lag is
  rescaled onto the edge's own `0..1` so a late panel still ARRIVES at blue.
  Without the rescale the four edges settle on four different colours.

Mid-animation the bottom already reads blue while the top is still green (the
frame the reference is recognisable by); at rest all four agree. Envelope
lengthened to 0.60 s in, 1.30 s hold, 0.85 s out.

Four edge `Frame`s (bottom and top at full strength, left and right at ~55%),
each carrying a `UIGradient` whose `Transparency` ramps from invisible at the
screen's centre to visible at its edge. Corners build up where panels overlap.

`NumberSequence` and `ColorSequence` are **not tweenable**, which decides the
whole implementation:

* the falloff ramp is set once — it is the shape, not the animation;
* the animation is the frame's own `BackgroundTransparency`, which composes
  with the ramp;
* the hue is driven by a single `NumberValue` tweened `0 → 1`, with all four
  gradients recolouring off its `Changed` signal. Each panel carries a phase
  offset, so mid-animation the top reads green while the bottom is still blue —
  which is what the reference does.

No `RenderStepped` loop anywhere. Envelope is 0.55 s in, 0.9 s hold, 0.75 s out,
then `Destroy()`.

**Cost is bounded because this payload runs in every farming instance.** The
sparkle field (small `✦` labels over the glow) is `SPARKLE_COUNT = 60` on a
generic device and **0 on Omnidroid** — nobody is watching those frames. The
whole tree is destroyed when the envelope closes; nothing persists.

## Entry affordances

**Toggle** — 56 px neutral **rounded square** (16 px radius) with a `✦`
glyph, not `OE` lettering and not a circle: a 56 px circle with a glyph in it is
the shape every other Roblox executor still ships. Draggable (the existing
`dragTap` correctly separates drag from tap and is kept), snaps to the nearer
screen edge on release. Enters with scale-from-0 as the glow's last frame
clears.

*Revised 2026-08-22:* it rests at the **right** edge at 38 % height. The
original sat at the left edge at exactly half height, which on a phone is on
top of the movement thumbstick — the one place on a Roblox screen guaranteed to
be under a thumb. The right side at 38 % clears the stick and the jump button
both.

**Connected card** (Omnidroid only) — rounded card, top-centre, slides down
over 0.42 s. Glyph tile, **`Omnidroid connected`**, **`Click here to view the
screen`**. Auto-dismisses at 5.5 s; a 20 px upward swipe dismisses immediately;
a tap opens the menu *and* promotes the toggle permanently.

*Revised 2026-08-22:* the green tick is gone. It was the only hue in the panel
and it was decorating rather than informing — "connected" was already the
headline. The live bridge state has a dot in the window's own header, which is
where a state that CHANGES belongs.

**Top-edge handle** (Omnidroid, after dismissal) — a full-width hit strip over
the top 8 % of the screen, with a **40x4 hairline bar drawn at the very top
edge**. Hover **or** tap slides a `Show UI` pill down; it retracts 2.5 s after
the pointer leaves. Tapping it opens the menu and promotes the toggle.

*Revised 2026-08-22:* the strip used to be entirely invisible, and that made it
folklore rather than a control — a thing whose whole affordance is that you
already know it is there. The bar is the smallest mark that says *reach here*.
The rule it has to respect is "leave the client clean", which is about not
obscuring the game and not appearing in a capture as something pressable; 160
square pixels of dim grey on the bezel edge does neither.

It listens for hover *and* touch because the guest's input device is not known
from here — farming boots with `usb: True`, so a pointer may or may not be
present, and a reveal that only understood one of the two would be unreachable
on the other.

## The window

Left icon rail, 56 px, three stacked buttons.

*Revised 2026-08-22 — the active item is the item.* The active tab used to be a
2x16 bar floating in the gutter beside the icon: two pixels wide, the same
colour as the text, on a panel that may be rendered at 480x270 and then scaled
by a viewer. What marks it now is a **filled rounded tile behind the glyph**
(Material's navigation rail), which survives any scale because it is 40 px of
contrast rather than 2. Same reasoning drives the switch knob GROWING when it
is on: a knob that only moves is two indistinguishable grey states in a
thumbnail.

**Palette is fully neutral** — body `#1E1F20`, rail `#131314`, raised
`#282A2C`, hover `#35373A`, hairline `#444746`, text `#E3E3E3`, muted
`#C4C7C5`, dim `#9AA0A6`. No hue anywhere in the panel.

*Revised 2026-08-22:* these are Google's dark surfaces rather than an invented
ramp. The point of a neutral palette is that it looks deliberate, and a
hand-mixed grey almost never does — it comes out tinted, and over a saturated
game the tint is the first thing the eye finds. Radii are tokens
(`OMNI.radius`), not literals: containers softly rounded, controls fully round.
Hover/press are one shared `OMNI.stateLayer` helper rather than
`AutoButtonColor`, which multiplies the button's colour and on a near-black
surface is a change of about four RGB steps — invisible, and absent entirely on
touch. The only colour left in the menu is the bridge-state dot and a failed
run's output.

The window **sizes to the viewport** rather than to a constant. Farming boots a
480×270 panel (`lean.FARMING_DISPLAY`), and the old fixed 500×392 window does not
fit on it.

It is **built lazily on first open**, so an instance that never opens the menu
never allocates it.

* **Script** — multiline `TextBox` (`ClearTextOnFocus = false`), Execute /
  Clear / Copy, and an output pane carrying the result or the error.
* **Toggles** — Speed, Jump, Noclip, Fly, Anti-AFK. Each keeps its own teardown
  so switching off actually reverses the effect, and each re-applies on
  `CharacterAdded` — a respawn otherwise silently drops every setting while the
  switches still read as on.
* **Status** — account, bridge phase, last poll age, uptime, last job, place and
  GameId. Read-only. No new backend endpoints.

## Testing

* `backend/tests/omniExecUi.test.js` — the assembly: modules concatenate in
  filename order, banners are present, `__OMNI_BASE__` is substituted with no
  occurrences left, the `pcall` wrapper is balanced, and `custom_ui.lua` still
  serves when `ui/` is absent.
* `omnidroid/tests/test_execmark.py` — the marker step (21 tests): every
  candidate root is written, the command survives `adb shell`'s argv-joining
  (the `shlex.quote` property `farming.sh` documents), a missing root is created
  and a failing one skipped rather than aborting the boot, and the ownership
  handoff is present. The MARKER NAME is asserted on both sides — here and in
  `omniExecUi.test.js` against the assembled payload — because the two halves
  never see each other at runtime.

* `scripts/check-ui-syntax.py` — compiles the assembled chunk with `lupa`. The
  modules stay inside the Lua subset Luau shares, so a chunk that will not parse
  there will not parse in the executor either. It reports the *module* a failing
  line falls in, because the line number alone points into a 2000-line chunk
  that exists nowhere on disk. Exits 77 (not 1) when `lupa` is absent, so a
  caller can tell "did not run" from "failed".

Syntax and assembly are covered. Correct *behaviour* — the animation, the
gesture handling, and above all which candidate workspace the executor really
uses — is only established by loading the payload in a live instance.
