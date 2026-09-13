# Mining (GPU/Ravencoin beta) — go-live checklist

Everything is built and verified locally. Do these steps, in order, when you
want the Earn tab live for real users. Nothing here is done automatically.

## 1. Publish the XMRig artifact to the `tools` dist channel
The executor downloads the miner on demand from the `tools` channel as
`xmrig-win`. Until it exists, "Download miner & enroll" fails.
- Get the official XMRig Windows release (it supports KawPow): https://github.com/xmrig/xmrig/releases
- Add it to `omni-backend/dist/registry.json` under the `tools` channel as
  `name: "xmrig-win"`, `kind: "tool"`, with its exact `sha256` and byte size,
  served by the existing dist router (`/omni/dist`). Match the shape of the
  existing `qemu-portable-win` / `adb-win` tool entries.
- The download is sha256-verified and atomic-swapped client-side (`miner.py`).

## 2. Backend env on the VPS (`.env.production.local`)
Set (values already staged in this repo's copy):
```
MINING_PROXY_ENABLED=1          # off by default; this turns the proxy on
MINING_STRATUM_HOST=179.198.197.7   # what the executor is told to connect to
MINING_STRATUM_PORT=3333
MINING_PROXY_PORT=3333
RVN_POOL_URL=rvn.herominers.com:1140
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
- Security review confirmed: no credit-forgery path from an untrusted miner;
  DoS vectors bounded. Safe to enable pending a live smoke test against a real
  HeroMiners endpoint (step 3 reachability).

## Still deferred (not blockers, note before scale)
- `flushPayouts` has an in-process re-entrancy guard but no cross-process lock
  (fine for one backend instance).
- XMR/CPU mining is implemented but gated off for the beta.
- `RealUpstream` submit re-serialization preserves param order; re-check if XMR
  (string ids) is ever enabled.
