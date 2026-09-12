# Earn tab: crypto mining for credits — design

Date: 2026-09-13
Status: approved for planning
Repos: `omni-backend` (credits, mining subsystem, stratum proxy) and
`omni-executor` (miner download, Earn tab, day-purchase UI)

## Goal

Let users earn spendable credits by donating their own CPU/GPU to mining, so
that people who cannot buy a subscription (or who want more credits) have a
non-cash path to credit. Miners are **not** shipped in the installer — Windows
Defender flags them — so the miner is downloaded on demand, only after the user
reads a warning and enrolls.

Credits earned this way land in the same balance the app already uses for
captcha solving, and can also buy subscription time: **1 day of subscription for
80 credits**.

## Money model (units)

Credits are displayed to users; micro-dollars (`micros`) are the stored unit.

- `$1 = 1,000,000 micros` (unchanged, `MICROS_PER_DOLLAR`).
- **`$1 = 100 credits`**, therefore **`1 credit = 10,000 micros`**. New constant
  `CREDITS_PER_DOLLAR = 100`; helpers `creditsToMicros` / `microsToCredits`.
- **Mining payout rate = 80%.** When the pool value of a user's accepted shares
  reaches `$1`, the user receives `80 credits` (= `$0.80` = `800,000 micros`).
  Constant `MINING_PAYOUT_RATE = 0.80`.
- **Day price = 80 credits** = `800,000 micros`. Constant
  `DAY_PRICE_MICROS = 800_000`. (Numerically equal to the 80% rate but an
  independent knob.)

## Part 1 — Credit buckets (omni-backend)

### Why

Today `user.credits.balanceMicros` is a single scalar. The product now needs
credits with **three sources and two lifetimes**:

- **top-up** (future) and **mining** → permanent, never expire.
- **subscription gift** (credits handed over when a key is redeemed) → expire
  when that subscription expires.

Spend order is **subscription bucket first, then permanent**, so the expiring
credits are used before the ones that last.

### Data model (`models/user.model.js`)

Replace the single field with two buckets:

```
credits: {
    permanentMicros:            Number, default 0,   // top-up + mining + admin
    subscriptionMicros:         Number, default 0,   // gifted with a plan
    subscriptionCreditsExpireAt: Date,  default null // = subscription.expiresAt
}
```

`balanceMicros` is removed as a stored field. A **schema virtual**
`credits.effectiveMicros` (or a plain helper — see below) computes the live
balance so old read sites have a single place to move to.

### Arithmetic (`utils/credits.js`, no database)

- `CREDITS_PER_DOLLAR`, `creditsToMicros`, `microsToCredits`, `formatCredits`.
- `effectiveBalanceMicros(credits, now)` =
  `permanentMicros + (subscriptionCreditsExpireAt && subscriptionCreditsExpireAt > now ? subscriptionMicros : 0)`.
- `splitSpend(credits, amountMicros, now)` — pure function returning how much
  comes from each bucket, used by tests and by the update builder. Subscription
  first (only if unexpired), remainder from permanent; the last authorized step
  may drive **permanent** negative (unchanged overdraw rule).
- Keep `chargeForUpstream`, `canAffordStep` but feed them the effective balance.
- `displayBalanceMicros` clamps effective to ≥ 0 (unchanged intent).

### Movements (`services/credits.service.js`)

The one rule stays: **never read-then-write.** Two-bucket spends use a single
`findOneAndUpdate` with an **aggregation-pipeline update** (`$set` + `$cond`),
which is atomic and lock-free — no transaction, so captcha solving stays fast.
The pipeline also zeroes an expired subscription bucket as it goes (lazy
expiry).

- `grantCredits(userId, amountMicros, { bucket = 'permanent', kind, reason, actor, meta })`
  - `bucket: 'permanent'` → `$inc permanentMicros` (mining, admin, top-up).
  - `bucket: 'subscription'` → `$inc subscriptionMicros` **and** set
    `subscriptionCreditsExpireAt` to the user's `subscription.expiresAt`
    (passed in by the caller that just extended the subscription).
- `spendCredits(userId, amountMicros, { kind, reason, meta })` — **new**,
  generic. Pipeline update: take from subscription (if unexpired) first, then
  permanent; overdraft on permanent. Returns `{ chargedMicros, balanceMicros }`
  where `balanceMicros` is the new *effective* balance. Used by both
  `chargeForSolve` and the day-purchase.
- `chargeForSolve` reworked to call the shared spend path.
- `authorizeStep`, `adminAdjust` (defaults to permanent), `listTransactions`
  unchanged in signature; internals updated for buckets.

### Ledger (`models/creditTransaction.model.js`)

- Add `bucket` field (`'permanent' | 'subscription' | null`) recording where the
  delta landed (for a split spend, one row per bucket touched, or a single row
  with a `meta.split`; **decision: one row per bucket touched**, so
  `balanceAfterMicros` stays meaningful).
- Extend `kind` enum with `'mining'` and `'subscription_purchase'`.
- `balanceAfterMicros` records the **effective** balance after the movement.

### Key redemption & revocation

- `keys.controller.js` redeem: the gifted credits (`creditsForKey`) now go to
  the **subscription** bucket via `grantCredits(..., { bucket: 'subscription' })`
  **after** the subscription is extended, so the expiry is the freshly computed
  `subscription.expiresAt`. Stacking a second key extends both the time and the
  gift-credit expiry together.
- `revokeKey.js`: reverse `creditsGrantedMicros` from the **subscription**
  bucket (may go negative, unchanged policy). Lifetime keys clear the expiry
  (bucket becomes effectively permanent while the lifetime plan is active — a
  lifetime plan never lapses, so `subscriptionCreditsExpireAt = null` and the
  effective-balance rule treats `null` as "no expiry / do not count"?).
  - **Resolve the `null` ambiguity:** `subscriptionCreditsExpireAt === null`
    means **not counted** (safe default). For **lifetime**, gift credits are
    instead placed in the **permanent** bucket (a lifetime gift never expires),
    so the `null`-means-not-counted rule needs no exception.

### Migration (`backend/scripts/`)

One-shot script: for every user, move the existing `balanceMicros` into
`permanentMicros` (decision confirmed with the user — do **not** retroactively
expire credits people already hold), set `subscriptionMicros = 0`,
`subscriptionCreditsExpireAt = null`, and unset the old field. Idempotent (skip
users already migrated). Runs before deploy.

## Part 2 — Mining subsystem (omni-backend)

### Enrollment

- `POST /api/v1/mining/enroll` (`authorize`) → creates/rotates a per-user miner
  token, returns `{ minerToken, stratumHost, stratumPort, algos }`.
- Token stored **hashed** on a small `MinerSession` model
  (`{ user, tokenHash, createdAt, lastSeenAt, revokedAt }`), so a leaked token
  is scoped to mining and revocable without touching the JWT.

### Stratum proxy (`backend/src/mining/`)

A standalone TCP listener (its own port; started from `server.js` or a sibling
process in `ecosystem.config.cjs`). Responsibilities:

1. **Auth on stratum login.** The miner sends the `minerToken` as the login
   username (both XMR/RandomX `login` and RVN/KawPow `mining.authorize`). The
   proxy resolves it to a `userId` via `MinerSession`; unknown tokens are
   dropped.
2. **Upstream forwarding.** Opens a connection to the real pool
   (**env config, left unset for now** — see "Pool deferred") and rewrites the
   login to **your** wallet + a worker name derived from the user. All job /
   submit traffic is proxied verbatim otherwise.
3. **Accepted-share accounting.** Only shares the **upstream pool accepts** are
   counted, at the share's difficulty (read from the job the proxy handed out).
   Per-user accepted difficulty accumulates in memory + periodic flush to a
   `MiningLedger`/aggregate doc.
4. **Coin routing.** CPU connections speak RandomX (Monero); GPU connections
   speak KawPow (Ravencoin). Two upstream endpoints, one proxy.

### Valuation → payout job

Periodic job converts accumulated accepted difficulty per coin into USD, using
per-coin params (network difficulty, block reward, coin price) from
config/env, then credits `microsToGrant = usd * MICROS_PER_DOLLAR * 0.80` via
`grantCredits(userId, microsToGrant, { bucket: 'permanent', kind: 'mining' })`.
Rounds down to whole credits, carries the sub-credit remainder forward.

### Status

- `GET /api/v1/mining/status` (`authorize`) → `{ enrolled, hashrate,
  creditedMicros, sessionMicros, lastShareAt }` for the tab.

### Pool deferred (honoring "skip pool steps")

Upstream pool + wallet are pure config:
`XMR_POOL_URL/XMR_WALLET`, `RVN_POOL_URL/RVN_WALLET`. Left unset for now. The
proxy, accounting, valuation and payout are built and **tested against a fake
in-process upstream pool** that accepts shares at a fixed difficulty, so the end
-to-end credit path is verifiable without joining any real pool. Turning it on
later is setting env vars.

### Auth/rate-limit notes

- Mining routes use the same JWT `authorize` as the rest of the API.
- Arcjet already whitelists `User-Agent: OmniExecutor/*` + device header for bot
  detection; the stratum port is outside Express and unaffected.

## Part 3 — Miner download + run (omni-executor Python)

### Download (`miner.py`, reusing `bootstrap.py` machinery)

- New `miner.py` uses `bootstrap.download_blob` (sha256-required, resumable,
  1 MiB chunks) + atomic `.new`/`.old` swap (the `_install_qemu_portable`
  pattern) to fetch one XMRig build.
- Artifact is served from the dist server under the **`tools` channel** and
  recorded as **`kind: "tool"`** so it never gates first-boot readiness
  (`plan_downloads` skips tools) and never runs at setup.
- Installs to `runtime_dir()/miner` (`%LOCALAPPDATA%\OmniExec\miner`). Receipt in
  `installed.json` under `tools`.

### API methods (`class Api`, `main.py`)

All follow the guard-flag + daemon-thread + `_push` pattern
(`bootstrap_start` is the reference):

- `mining_status()` → merges local miner state with backend
  `GET /mining/status` (via `cloud.request`).
- `mining_enroll()` → `POST /mining/enroll` through `cloud.py`, stores the
  returned token in `%APPDATA%\omni-executor` (mode 0600, like `auth.json`),
  then downloads the miner. Emits `mining-progress`.
- `mining_start(mode, intensity)` → launches xmrig subprocess pointed at the
  omni proxy with the token; `mode ∈ {cpu, gpu, both}` selects backends and coin
  (CPU=RandomX/XMR, GPU=KawPow/RVN). Parses stdout for hashrate / accepted
  shares → `mining-progress` events.
- `mining_stop()` → terminates the subprocess (never leaves it orphaned; reuse
  the adb/QEMU child-management care from existing code).
- `mining_add_defender_exclusion()` → runs
  `Add-MpPreference -ExclusionPath <runtime>/miner` **elevated** (a UAC prompt,
  `Start-Process -Verb RunAs`). Scoped to the miner folder only; returns whether
  the user accepted. Optional — skipping it still lets mining run (Defender may
  quarantine, in which case the tab shows manual steps).

### Auth to backend

Reuse `cloud.py` (`request`, `_headers` Bearer + device headers,
`api_base()`). No new transport.

## Part 4 — Earn tab (omni-executor frontend)

### Wiring

- `App.jsx`: import `EarnView`, add a `NAV` entry (gets `Ctrl+8`), render
  `<EarnView active auth showToast />`, add a `ContextBar` branch.
- `components/icons.jsx`: an `EarnDuoIcon`.
- New `components/EarnView.jsx`, modeled on `StatTrackView.jsx` (gated panel +
  console split, polling while `active`, `api()` + `showToast`).
- `devMock.js`: stub `mining_*` methods for `?mock` browser preview.

### States

1. **Not enrolled** — explains earning and the `100 credits = $1` rate; a clear
   **Windows Defender notice** (why the download is separate, what the user will
   see, that it is opt-in); primary button **"Download miner & enroll"**.
2. **Downloading** — progress bar fed by `mining-progress`.
3. **Ready** — device selector **CPU / GPU / Both**, intensity control,
   **Start / Stop**, live hashrate, session earnings, last accepted share.
4. **Balance & spend** — effective balance shown as credits (with a note when
   part is subscription credit that expires on <date>); button
   **"Buy 1 day of subscription — 80 credits"** (disabled if balance < 80).

### Optional

GIF/telemetry not needed. Uses existing `ui.jsx` primitives (`Panel`,
`Button`, `Toggle`, `Notice`, `Lamp`).

## Part 5 — Buy a subscription day with credits (omni-backend)

- `POST /api/v1/subscription/redeem-credits` (`authorize`):
  1. `spendCredits(userId, DAY_PRICE_MICROS, { kind: 'subscription_purchase',
     reason: '1 day via credits' })` — fails with 402 if the effective balance
     is below 80 credits (checked inside the atomic pipeline; if the guarded
     decrement matches nothing, no charge, return "insufficient").
  2. Extend the subscription by **1 day** via the existing
     `computeSubscriptionAfterRedeem` (or a thin `addDays` wrapper for the
     day-plan case).
  3. A credit-bought day grants **no** new subscription credits (prevents a
     mine→day→credits loop).
  - Ordered spend-then-extend; if extend fails, refund the spend (compensating
    `grantCredits` to permanent). Both steps in a Mongo transaction where a
    replica set is available (already required by key redemption).
- Returns the new `subscriptionView` + effective balance.

## Testing

**omni-backend** (`node --test`, `node:assert`, `supertest`; pure-logic files
need no DB — model `credits.test.js` after):

- `utils/credits.js`: `effectiveBalanceMicros`, `splitSpend` (subscription-first,
  expiry, overdraw), `creditsToMicros`/`microsToCredits`, `DAY_PRICE_MICROS`.
- `services/credits.service.js`: grant to each bucket; spend crossing the bucket
  boundary; expired subscription bucket ignored + zeroed; ledger rows per bucket.
- Mining: fake upstream pool → proxy authorizes a token, forwards, counts an
  accepted share; valuation job pays 80% into the permanent bucket with a
  `mining` ledger row; `enroll`/`status` routes.
- Day purchase: success extends 1 day + spends 80 credits + `subscription_purchase`
  row; insufficient balance → 402, no charge; no subscription credits granted.
- Migration script: old `balanceMicros` → `permanentMicros`, idempotent.

Note: the omni-backend HTTP suite is genuinely flaky (Arcjet 429s / Mongo);
baseline by stashing and re-running, never treat one red run as a regression.
On Windows the single-quoted test glob does not expand — run tests via the
package script / a Node glob.

**omni-executor** (`pytest`, `tests/`):

- `miner.py`: download path uses bootstrap's verified/atomic swap; refuses an
  artifact with no sha256; installs under `runtime_dir()/miner`; receipt as a
  tool.
- `Api.mining_*`: enroll stores the token 0600; start/stop manages the child;
  events emitted; `mining_add_defender_exclusion` builds the right elevated
  command (mock the elevation).
- New tests need `git add -f` if under a gitignored path; conftest conventions
  as per the existing suite.

## Out of scope

- Buying **permanent** credits with money (BTCPay top-up) — later.
- Joining / configuring a real mining pool — env config, deferred.
- Spending credits on anything besides subscription days.
- macOS/Linux miner builds (Windows first; the download path is cross-platform
  but only a Windows XMRig artifact ships initially).

## Build/ship notes (from prior art)

- Executor is a Tauri shell + frozen Python backend; the frontend must be built
  before cargo, and release builds need `--features custom-protocol` or the
  window loads a dead localhost page.
- A new hashed artifact in the `stable` channel makes installed clients report
  un-ready — ship the miner under `tools`, not `stable`.
- The install dir cannot be renamed; the miner lives in `runtime_dir()`, not the
  install tree, so the file-by-file updater is unaffected.
