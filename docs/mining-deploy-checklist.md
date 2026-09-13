# Mining (GPU/Ravencoin beta) — go-live checklist

Everything is built and verified locally. Do these steps, in order, when you
want the Earn tab live for real users. Nothing here is done automatically.

## 1. Publish the XMRig artifact to the `tools` dist channel
The executor downloads the miner on demand from the `tools` channel as
`xmrig-win`. Until it exists, "Download miner & enroll" fails.
- Get the official XMRig Windows release (it supports KawPow): https://github.com/xmrig/xmrig/releases
  (verified working: v6.26.0 `xmrig-6.26.0-windows-x64.zip`).
- **Bundle the CUDA plugin for NVIDIA.** The GPU spawn args are `--cuda --opencl`.
  `--cuda` auto-detects NVIDIA (fastest for KawPow) but needs `xmrig-cuda.dll`
  (+ the CUDA runtime) shipped ALONGSIDE `xmrig.exe`; `--opencl` covers AMD.
  With a plain build (no CUDA plugin) on an NVIDIA box, `--opencl` alone defaults
  to hunting an AMD platform and finds no GPU. So the `xmrig-win` artifact should
  be a zip of `xmrig.exe` + `xmrig-cuda.dll` + CUDA runtime dlls. (Verified: a
  plain OpenCL build only mines NVIDIA with an explicit `--opencl-platform=<idx>`,
  which the shipped args don't set — bundle CUDA instead.)
- Add it to `omni-backend/dist/registry.json` under the `tools` channel as
  `name: "xmrig-win"`, `kind: "tool"`, with its exact `sha256` and byte size,
  served by the existing dist router (`/omni/dist`). Match the shape of the
  existing `qemu-portable-win` / `adb-win` tool entries. (`miner.py` currently
  places a single `xmrig.exe`; for a bundle, it should extract the whole zip into
  the miner dir — small `place`-side tweak, noted here so it isn't missed.)
- The download is sha256-verified and atomic-swapped client-side (`miner.py`).

## 2. Backend env on the VPS (`.env.production.local`)
Set (values already staged in this repo's copy):
```
MINING_PROXY_ENABLED=1          # off by default; this turns the proxy on
MINING_STRATUM_HOST=179.198.197.7   # what the executor is told to connect to
MINING_STRATUM_PORT=3333
MINING_PROXY_PORT=3333
RVN_POOL_URL=ravencoin.herominers.com:1140
RVN_WALLET=RRQSXsXDSnhRcgowRrSwh4BVV3nR5hfF8b
```
Restart the backend (pm2/ecosystem). The proxy + payout loop start with it.

## 3. Open the proxy port on the VPS firewall
TCP 3333 must be reachable by clients. The relay is hardened (per-user hashed
token auth, proxy-side id rewriting so a miner can't forge credits, in-flight
cap, write backpressure, line/queue caps) but it is a raw TCP port — consider a
sensible connection-rate limit at the firewall too.

## 4. Ship the executor with the Earn tab
Build the executor (frontend → PyInstaller → cargo with `--features
custom-protocol`) and distribute it. The Earn tab is GPU-only during beta.

## 5. Tuning (optional)
- `RVN_USD_PER_DIFF` sets how accepted-share difficulty converts to USD (and
  thus credits at the 80% payout rate). Calibrate it against real HeroMiners
  earnings before/after launch so credits granted ≈ 80% of realized value.
- HeroMiners pays your `RVN_WALLET` once its own payout threshold is met;
  per-worker stats show at the pool site by pasting the wallet.

## Verified locally (2026-09-13)
- Full earn→credit path (relay → accepted-share sniff → payout → ledger) drove
  a test user from 0 → 24 credits against a local fake pool; the pool saw the
  wallet, never the token.
- **Real GPU mining confirmed**: XMRig 6.26.0, RTX 4060 via OpenCL (NVIDIA CUDA
  platform, `--opencl-platform=0`), KawPow ~14.4 MH/s against
  `ravencoin.herominers.com:1140`, **2 accepted / 0 rejected** shares to the
  wallet (worker `omnitest01`). This was a DIRECT xmrig→pool run (GPU + pool +
  wallet proven); the proxy→credit half is proven separately by the fake-pool
  run above. The two together cover the whole chain; a single xmrig→proxy→pool
  live run is the last nice-to-have.
- Correct HeroMiners RVN host is `ravencoin.herominers.com` (NOT
  `rvn.herominers.com`, which does not resolve).
- Security review confirmed: no credit-forgery path from an untrusted miner;
  DoS vectors bounded.

## Local end-to-end findings (2026-09-13) — MUST address before go-live

The local build + real-GPU run surfaced these (the point of testing first):

- **[FIXED] `start.js` never started the proxy.** The proxy/payout startup was only
  in `server.js`'s `isMainModule` block, which does not run under pm2 (pm2 runs
  `start.js`). Extracted to `startMiningServices()`, called from both. **Prod was
  deployed before this fix — redeploy before enabling mining.**
- **[FIXED] Relay ignored KawPow difficulty.** HeroMiners sends no
  `mining.set_difficulty`; difficulty is in the job target. Relay now derives it
  (verified: matches xmrig's 1073M). Also needs redeploy. TODO: add a
  notify-target unit test to `mining-proxy.test.js`.
- **[TODO — blocker] Bundled miner must include the CUDA plugin for NVIDIA.** The
  app's GPU args `--cuda --opencl` find NO backend on a plain build on NVIDIA
  (`--cuda` disabled without the plugin; `--opencl` defaults to an AMD platform).
  Symptom: "no active pools, stop mining". Fix = ship `xmrig.exe` + `xmrig-cuda.dll`
  + CUDA runtime in the `xmrig-win` artifact (then `--cuda` auto-detects NVIDIA;
  `--opencl` covers AMD). Verified a plain build only mines NVIDIA with an explicit
  `--opencl-platform=<idx>`, which is machine-specific — bundle CUDA instead.
- **[TODO — robustness] Relay drops the miner when the pool cycles the upstream.**
  HeroMiners closed the upstream ~every 80s; the relay tears down the miner, which
  reconnects fresh (losing progress). Make the relay reconnect the upstream
  transparently (keep the miner connected) so shares accumulate steadily.
- **[TODO — blocker] Calibrate `RVN_USD_PER_DIFF`.** The placeholder `5e-8` values a
  single ~1073M-diff share at ~$50. Real ~14 MH/s earns ~cents/day; the right value
  is ~`1e-14`. Calibrate against realized HeroMiners earnings so granted credits ≈
  80% of real value BEFORE enabling, or users get massively over/under-credited.

Pipeline proven in pieces: relay relays real HeroMiners jobs (subscribe/authorize/
notify, wallet substituted); the RTX 4060 mines KawPow through the proxy (~10–14
MH/s); a direct run landed accepted shares; the credit path credits (smoke test
0→24). A single continuous in-app accepted-share→credit run still needs the CUDA
bundle + the reconnect fix to be reliable.

## Still deferred (not blockers, note before scale)
- `flushPayouts` has an in-process re-entrancy guard but no cross-process lock
  (fine for one backend instance).
- XMR/CPU mining is implemented but gated off for the beta.
- `RealUpstream` submit re-serialization preserves param order; re-check if XMR
  (string ids) is ever enabled.
