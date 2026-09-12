# Earn Tab (Mining for Credits) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users earn spendable credits by mining with their own CPU/GPU, downloaded on demand outside setup, and spend credits on subscription days.

**Architecture:** Split the single `credits.balanceMicros` into a permanent bucket (top-up/mining/admin) and an expiring subscription bucket (spent first). A standalone stratum proxy on the VPS authenticates miners by a per-user token, forwards to an upstream pool (env config, deferred), counts pool-accepted shares, and pays 80% of their USD value into the permanent bucket. The executor downloads XMRig on demand (reusing the verified/atomic bootstrap download machinery) and exposes an Earn tab.

**Tech Stack:** Node/Express + Mongoose + `node --test`/supertest (omni-backend); Python 3 + `pytest` + Tauri/React/Vite/Tailwind v4 (omni-executor).

**Spec:** `omni-backend/docs/superpowers/specs/2026-09-13-mining-earn-credits-design.md`

## Global Constraints

- **Units:** `MICROS_PER_DOLLAR = 1_000_000`; `CREDITS_PER_DOLLAR = 100`; therefore `1 credit = 10_000 micros`. `DAY_PRICE_MICROS = 800_000` (80 credits). `MINING_PAYOUT_RATE = 0.80`.
- **Never read-then-write a balance** for the high-frequency spend path (captcha): use a single atomic `findOneAndUpdate` with an aggregation-pipeline update. Transactions are allowed only for low-frequency multi-document ops (day purchase, key redeem, mining payout batch).
- **Spend order:** expiring subscription bucket first (only if unexpired), then permanent. The last authorized step may overdraw **permanent** (existing overdraft rule).
- **Lazy expiry:** an expired subscription bucket (`subscriptionCreditsExpireAt <= now`) counts as 0 and is zeroed opportunistically on the next spend. `subscriptionCreditsExpireAt === null` means "not counted".
- **Executor:** miner ships under the **`tools`** dist channel and is recorded as **`kind: "tool"`** so it never gates first-boot readiness (`plan_downloads` skips tools) and never downloads at setup.
- **Two omni-backend suite realities:** the HTTP suite is genuinely flaky (Arcjet 429 / Mongo) — baseline by stashing and re-running before calling a red run a regression; and the single-quoted test glob does not expand on Windows — run tests via `npm test` / a Node glob (see Task 0).
- **omni-executor tests** live under `tests/` (pytest); if a new test file lands under a gitignored path use `git add -f`.
- **Commit attribution** (every commit in this plan):
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_011wqJj3f7Jc6WDoTdgecEhc
  ```

## File Structure

**omni-backend (`backend/src/`)**
- `utils/credits.js` — MODIFY: bucket constants + pure arithmetic (`effectiveBalanceMicros`, `splitSpend`, credit conversions, `DAY_PRICE_MICROS`).
- `models/user.model.js` — MODIFY: replace `credits.balanceMicros` with `permanentMicros` + `subscriptionMicros` + `subscriptionCreditsExpireAt`.
- `models/creditTransaction.model.js` — MODIFY: add `bucket` field, extend `kind` enum.
- `services/credits.service.js` — MODIFY: bucket-aware grant/spend (pipeline update), new `spendCredits`.
- `controllers/credits.controller.js` — MODIFY: `balanceView` from effective balance.
- `controllers/keys.controller.js` — MODIFY: gift → subscription bucket (or permanent for lifetime).
- `services/revokeKey.js` — MODIFY: reverse from the right bucket.
- `services/subscriptionCredits.service.js` — CREATE: `redeemDayWithCredits`.
- `controllers/subscription.controller.js` — CREATE: `redeemCreditsForDay`.
- `routes/subscription.routes.js` — CREATE.
- `models/minerSession.model.js` — CREATE: per-user hashed miner token.
- `services/mining/valuation.js` — CREATE: pure share-difficulty → micros.
- `services/mining/accounting.js` — CREATE: per-user accepted-difficulty accumulator + payout flush.
- `services/mining/stratumProxy.js` — CREATE: TCP proxy (pluggable upstream, fake for tests).
- `services/mining/upstream.js` — CREATE: upstream pool connector + `FakeUpstream` for tests.
- `controllers/mining.controller.js` — CREATE: `enroll`, `status`.
- `routes/mining.routes.js` — CREATE.
- `server.js` — MODIFY: mount subscription + mining routers; start the proxy.
- `scripts/migrate-credit-buckets.js` — CREATE: one-shot balance migration.
- `backend/tests/*.test.js` — CREATE per task.

**omni-executor**
- `miner.py` — CREATE: XMRig download + install + run helpers.
- `main.py` — MODIFY: `Api.mining_*` methods.
- `cloud.py` — MODIFY: `mining_enroll` / `mining_status` request helpers.
- `frontend/src/components/EarnView.jsx` — CREATE.
- `frontend/src/components/icons.jsx` — MODIFY: `EarnDuoIcon`.
- `frontend/src/App.jsx` — MODIFY: NAV entry, view render, ContextBar branch.
- `frontend/src/api.js` — MODIFY: mining helpers.
- `frontend/src/devMock.js` — MODIFY: mining stubs.
- `tests/test_miner.py` — CREATE.

---

## Phase A — Credit buckets (omni-backend)

### Task 0: Establish a reliable test command

**Files:**
- Modify: `omni-backend/package.json`

**Interfaces:**
- Produces: `npm run test:unit` runs pure-logic tests without Mongo; `npm test` runs all.

- [ ] **Step 1: Inspect the current scripts**

Run: `node -e "console.log(require('./package.json').scripts)"` in `omni-backend/`.
Expected: see the existing `test` script (a single-quoted glob that yields `tests 0` on Windows).

- [ ] **Step 2: Add a Windows-safe unit script**

In `package.json` `scripts`, add (keep the existing `test`):
```json
"test:unit": "node --test backend/tests/credits.test.js backend/tests/mining-valuation.test.js"
```
(Explicit file list — no glob — so it runs identically on Windows and Linux. Add files here as later tasks create them.)

- [ ] **Step 3: Verify it runs (no tests yet is fine)**

Run: `npm run test:unit`
Expected: node reports the files are missing OR `tests 0` — either way the command itself works. It will pass once Task 1 lands.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "test: add windows-safe unit test script for credit/mining logic"
```

---

### Task 1: Credit bucket arithmetic (pure, no DB)

**Files:**
- Modify: `backend/src/utils/credits.js`
- Test: `backend/tests/credits.test.js`

**Interfaces:**
- Consumes: existing `MICROS_PER_DOLLAR` (=1_000_000).
- Produces:
  - `CREDITS_PER_DOLLAR = 100`, `MINING_PAYOUT_RATE = 0.80`, `DAY_PRICE_MICROS = 800_000`
  - `creditsToMicros(credits) -> micros`, `microsToCredits(micros) -> number`
  - `formatCredits(micros) -> string` e.g. `"80 credits"`
  - `effectiveBalanceMicros(credits, now = new Date()) -> micros`
  - `splitSpend(credits, amountMicros, now = new Date()) -> { fromSubMicros, fromPermanentMicros, next: { permanentMicros, subscriptionMicros, subscriptionCreditsExpireAt }, effectiveAfterMicros }`
  - `credits` shape everywhere: `{ permanentMicros, subscriptionMicros, subscriptionCreditsExpireAt }`.

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/credits.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CREDITS_PER_DOLLAR, DAY_PRICE_MICROS, MINING_PAYOUT_RATE,
    creditsToMicros, microsToCredits, formatCredits,
    effectiveBalanceMicros, splitSpend,
} from '../src/utils/credits.js';

const future = new Date(Date.now() + 86_400_000);
const past = new Date(Date.now() - 86_400_000);

test('unit constants', () => {
    assert.equal(CREDITS_PER_DOLLAR, 100);
    assert.equal(DAY_PRICE_MICROS, 800_000);
    assert.equal(MINING_PAYOUT_RATE, 0.8);
    assert.equal(creditsToMicros(80), 800_000);
    assert.equal(microsToCredits(800_000), 80);
    assert.equal(formatCredits(800_000), '80 credits');
    assert.equal(formatCredits(10_000), '1 credit');
});

test('effective balance ignores an expired subscription bucket', () => {
    const c = { permanentMicros: 500_000, subscriptionMicros: 300_000, subscriptionCreditsExpireAt: past };
    assert.equal(effectiveBalanceMicros(c), 500_000);
});

test('effective balance counts an unexpired subscription bucket', () => {
    const c = { permanentMicros: 500_000, subscriptionMicros: 300_000, subscriptionCreditsExpireAt: future };
    assert.equal(effectiveBalanceMicros(c), 800_000);
});

test('splitSpend takes from subscription first, then permanent', () => {
    const c = { permanentMicros: 500_000, subscriptionMicros: 300_000, subscriptionCreditsExpireAt: future };
    const r = splitSpend(c, 400_000);
    assert.equal(r.fromSubMicros, 300_000);
    assert.equal(r.fromPermanentMicros, 100_000);
    assert.equal(r.next.subscriptionMicros, 0);
    assert.equal(r.next.permanentMicros, 400_000);
    assert.equal(r.effectiveAfterMicros, 400_000);
});

test('splitSpend ignores + clears an expired subscription bucket', () => {
    const c = { permanentMicros: 500_000, subscriptionMicros: 300_000, subscriptionCreditsExpireAt: past };
    const r = splitSpend(c, 100_000);
    assert.equal(r.fromSubMicros, 0);
    assert.equal(r.fromPermanentMicros, 100_000);
    assert.equal(r.next.subscriptionMicros, 0);
    assert.equal(r.next.subscriptionCreditsExpireAt, null);
    assert.equal(r.next.permanentMicros, 400_000);
});

test('splitSpend overdraws permanent on the last step', () => {
    const c = { permanentMicros: 5_000, subscriptionMicros: 0, subscriptionCreditsExpireAt: null };
    const r = splitSpend(c, 30_000);
    assert.equal(r.next.permanentMicros, -25_000);
    assert.equal(r.effectiveAfterMicros, 0); // clamped view
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test backend/tests/credits.test.js`
Expected: FAIL — imports `CREDITS_PER_DOLLAR`, `splitSpend`, etc. are undefined.

- [ ] **Step 3: Implement in `utils/credits.js`**

Add below the existing exports (keep everything already there):
```js
export const CREDITS_PER_DOLLAR = 100;
export const MICROS_PER_CREDIT = MICROS_PER_DOLLAR / CREDITS_PER_DOLLAR; // 10_000
export const MINING_PAYOUT_RATE = 0.8;
export const DAY_PRICE_MICROS = 80 * MICROS_PER_CREDIT; // 800_000

export function creditsToMicros(credits) {
    const n = Number(credits);
    return Number.isFinite(n) ? Math.round(n * MICROS_PER_CREDIT) : 0;
}

export function microsToCredits(micros) {
    return (Number(micros) || 0) / MICROS_PER_CREDIT;
}

/** "80 credits" / "1 credit". Clamped to >= 0 for display. */
export function formatCredits(micros) {
    const n = Math.max(0, Math.round(microsToCredits(micros)));
    return `${n} credit${n === 1 ? '' : 's'}`;
}

function subActiveMicros(credits, now) {
    const exp = credits?.subscriptionCreditsExpireAt
        ? new Date(credits.subscriptionCreditsExpireAt) : null;
    if (!exp || exp <= now) return 0;
    return Number(credits?.subscriptionMicros) || 0;
}

/** Live balance: permanent + unexpired subscription. */
export function effectiveBalanceMicros(credits, now = new Date()) {
    return (Number(credits?.permanentMicros) || 0) + subActiveMicros(credits, now);
}

/**
 * Pure spend planner. Subscription bucket first (only if unexpired), remainder
 * from permanent; permanent may go negative (the last authorized step). An
 * expired subscription bucket is treated as 0 AND cleared in `next`.
 */
export function splitSpend(credits, amountMicros, now = new Date()) {
    const amount = Math.max(0, Math.round(Number(amountMicros) || 0));
    const permanent = Number(credits?.permanentMicros) || 0;
    const subActive = subActiveMicros(credits, now);
    const expired = (Number(credits?.subscriptionMicros) || 0) > 0 && subActive === 0;

    const fromSubMicros = Math.min(subActive, amount);
    const fromPermanentMicros = amount - fromSubMicros;

    const nextSub = subActive - fromSubMicros; // 0 when it was expired
    const next = {
        permanentMicros: permanent - fromPermanentMicros,
        subscriptionMicros: expired ? 0 : nextSub,
        subscriptionCreditsExpireAt:
            (expired || nextSub === 0) ? null : credits.subscriptionCreditsExpireAt,
    };
    return {
        fromSubMicros, fromPermanentMicros, next,
        effectiveAfterMicros: Math.max(0, next.permanentMicros + (expired ? 0 : nextSub)),
    };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test backend/tests/credits.test.js`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/credits.js backend/tests/credits.test.js
git commit -m "feat(credits): bucket-aware pure arithmetic (permanent + expiring subscription)"
```

---

### Task 2: User model buckets + ledger fields

**Files:**
- Modify: `backend/src/models/user.model.js:58-63` (the `credits` block)
- Modify: `backend/src/models/creditTransaction.model.js:23-27,47-50`

**Interfaces:**
- Produces: `user.credits.{permanentMicros, subscriptionMicros, subscriptionCreditsExpireAt}`; `CreditTransaction.bucket`; `kind` enum includes `mining`, `subscription_purchase`.

- [ ] **Step 1: Replace the `credits` subdocument in `user.model.js`**

Replace lines 53-63 (the comment + `credits` block) with:
```js
    // Credits in integer MICRO-dollars ($1 = 1e6). Two buckets:
    //  - permanentMicros: top-ups, mining, admin grants. Never expire.
    //  - subscriptionMicros: gifted when a key is redeemed; expire with the
    //    plan (subscriptionCreditsExpireAt). Spent BEFORE permanent.
    // CreditTransaction is the trusted audit trail. Permanent may go slightly
    // negative (the last affordable solve overdraws); every surface clamps to 0.
    credits: {
        permanentMicros: { type: Number, default: 0 },
        subscriptionMicros: { type: Number, default: 0 },
        subscriptionCreditsExpireAt: { type: Date, default: null },
    },
```

- [ ] **Step 2: Extend the ledger schema**

In `creditTransaction.model.js`, change the `kind` enum (line 25) to:
```js
        enum: ['grant', 'spend', 'admin', 'refund', 'revocation', 'mining', 'subscription_purchase'],
```
And add, after the `balanceAfterMicros` block (after line 37):
```js
    // Which bucket this movement touched: 'permanent' | 'subscription'. A spend
    // that crosses the boundary is written as one row per bucket.
    bucket: {
        type: String,
        enum: ['permanent', 'subscription', null],
        default: null,
    },
```

- [ ] **Step 3: Sanity-check the models import**

Run: `node -e "import('./backend/src/models/user.model.js').then(()=>import('./backend/src/models/creditTransaction.model.js')).then(()=>console.log('ok')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `ok` (schemas compile). Mongoose may warn about no connection — that is fine.

- [ ] **Step 4: Commit**

```bash
git add backend/src/models/user.model.js backend/src/models/creditTransaction.model.js
git commit -m "feat(credits): split user credit buckets, add ledger bucket + kinds"
```

---

### Task 3: Bucket-aware credit service (grant/spend)

**Files:**
- Modify: `backend/src/services/credits.service.js`
- Test: `backend/tests/credits-service.test.js` (needs Mongo — see harness note)

**Interfaces:**
- Consumes: `splitSpend`, `effectiveBalanceMicros`, `chargeForUpstream`, `canAffordStep` from `utils/credits.js`; `User`, `CreditTransaction`.
- Produces:
  - `grantCredits(userId, amountMicros, { bucket = 'permanent', kind = 'grant', reason, actor, meta, expiresAt }) -> effectiveBalanceMicros`
  - `spendCredits(userId, amountMicros, { kind = 'spend', reason, meta }) -> { chargedMicros, balanceMicros }` (balance = effective)
  - `authorizeStep(userId) -> { allowed, balanceMicros }` (effective)
  - `chargeForSolve(userId, upstreamCostMicros, meta) -> { chargedMicros, balanceMicros }`
  - `adminAdjust(userId, deltaMicros, { reason, actor }) -> { balanceMicros, user }` (permanent bucket)
  - `listTransactions(userId, limit)` (unchanged)

- [ ] **Step 1: Write the failing test**

Create `backend/tests/credits-service.test.js` (guarded so it skips cleanly with no DB):
```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';
import CreditTransaction from '../src/models/creditTransaction.model.js';
import { grantCredits, spendCredits } from '../src/services/credits.service.js';

let dbOk = false;
before(async () => {
    try { await connectToDatabase(); dbOk = true; } catch { dbOk = false; }
});
after(async () => { if (dbOk) await mongoose.disconnect(); });

async function mkUser() {
    return User.create({
        email: `t${Date.now()}${Math.random()}@x.io`,
        username: `u${Date.now()}${Math.floor(Math.random() * 1e6)}`,
        password: 'x'.repeat(20),
    });
}

test('grant to permanent, spend crosses buckets subscription-first', { skip: !dbOk }, async () => {
    if (!dbOk) return;
    const u = await mkUser();
    await grantCredits(u._id, 500_000, { bucket: 'permanent', kind: 'mining', reason: 'm' });
    const exp = new Date(Date.now() + 86_400_000);
    await grantCredits(u._id, 300_000, { bucket: 'subscription', kind: 'grant', reason: 'g', expiresAt: exp });

    const { chargedMicros, balanceMicros } = await spendCredits(u._id, 400_000, { kind: 'spend', reason: 's' });
    assert.equal(chargedMicros, 400_000);
    assert.equal(balanceMicros, 400_000);

    const after = await User.findById(u._id).select('credits');
    assert.equal(after.credits.subscriptionMicros, 0);
    assert.equal(after.credits.permanentMicros, 400_000);

    const rows = await CreditTransaction.find({ user: u._id }).lean();
    // 2 grants + 2 spend rows (one per bucket touched)
    assert.equal(rows.filter(r => r.kind === 'spend').length, 2);
    await User.deleteOne({ _id: u._id });
    await CreditTransaction.deleteMany({ user: u._id });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test backend/tests/credits-service.test.js`
Expected: FAIL — `spendCredits` is not exported (or, with no DB, the test is skipped; if skipped, still complete steps 3-4 — the pipeline is exercised by Task 7's route test against Mongo).

- [ ] **Step 3: Rewrite `credits.service.js`**

Keep `CreditsError` and `record()` as-is. Replace `grantCredits`, `authorizeStep`, `chargeForSolve`, `adminAdjust` and add `spendCredits`:
```js
import User from '../models/user.model.js';
import CreditTransaction from '../models/creditTransaction.model.js';
import {
    chargeForUpstream, canAffordStep, effectiveBalanceMicros,
} from '../utils/credits.js';

// ... CreditsError and record() unchanged ...

/** Add credit to one bucket. Subscription grants also set the expiry. */
export async function grantCredits(userId, amountMicros, {
    bucket = 'permanent', kind = 'grant', reason = null, actor = null,
    meta = null, expiresAt = null,
} = {}) {
    const amount = Math.round(Number(amountMicros) || 0);
    if (amount === 0) {
        const u = await User.findById(userId).select('credits');
        return effectiveBalanceMicros(u?.credits);
    }
    const field = bucket === 'subscription' ? 'credits.subscriptionMicros' : 'credits.permanentMicros';
    const set = {};
    if (bucket === 'subscription' && expiresAt) set['credits.subscriptionCreditsExpireAt'] = expiresAt;
    const updated = await User.findOneAndUpdate(
        { _id: userId },
        { $inc: { [field]: amount }, ...(Object.keys(set).length ? { $set: set } : {}) },
        { new: true },
    ).select('credits');
    if (!updated) throw new CreditsError('User not found', 404);

    const balance = effectiveBalanceMicros(updated.credits);
    await record({ user: userId, deltaMicros: amount, kind, reason,
                   balanceAfterMicros: balance, actor, meta, bucket });
    return balance;
}

/**
 * Spend, subscription-bucket first then permanent, in ONE atomic
 * aggregation-pipeline update (no read-then-write, no transaction). Lazily
 * clears an expired subscription bucket as it goes. Permanent may go negative.
 */
export async function spendCredits(userId, amountMicros, { kind = 'spend', reason = null, meta = null } = {}) {
    const amount = Math.round(Number(amountMicros) || 0);
    if (amount <= 0) {
        const u = await User.findById(userId).select('credits');
        return { chargedMicros: 0, balanceMicros: effectiveBalanceMicros(u?.credits) };
    }
    const now = new Date();
    const before = await User.findById(userId).select('credits');
    if (!before) throw new CreditsError('User not found', 404);

    const updated = await User.findOneAndUpdate(
        { _id: userId },
        [
            { $set: { __subActive: {
                $cond: [
                    { $and: [
                        { $ne: ['$credits.subscriptionCreditsExpireAt', null] },
                        { $gt: ['$credits.subscriptionCreditsExpireAt', now] },
                    ] },
                    { $ifNull: ['$credits.subscriptionMicros', 0] }, 0,
                ] } } },
            { $set: { __fromSub: { $min: ['$__subActive', amount] } } },
            { $set: {
                'credits.subscriptionMicros': { $subtract: ['$__subActive', '$__fromSub'] },
                'credits.subscriptionCreditsExpireAt': {
                    $cond: [{ $gt: [{ $subtract: ['$__subActive', '$__fromSub'] }, 0] },
                        '$credits.subscriptionCreditsExpireAt', null] },
                'credits.permanentMicros': {
                    $subtract: [{ $ifNull: ['$credits.permanentMicros', 0] },
                        { $subtract: [amount, '$__fromSub'] }] },
            } },
            { $unset: ['__subActive', '__fromSub'] },
        ],
        { new: true },
    ).select('credits');

    // Reconstruct the per-bucket split for the ledger (same rule the pipeline used).
    const now2 = now;
    const subActiveBefore =
        before.credits?.subscriptionCreditsExpireAt && new Date(before.credits.subscriptionCreditsExpireAt) > now2
            ? (before.credits.subscriptionMicros || 0) : 0;
    const fromSub = Math.min(subActiveBefore, amount);
    const fromPerm = amount - fromSub;
    const balance = effectiveBalanceMicros(updated.credits);

    if (fromSub > 0) {
        await record({ user: userId, deltaMicros: -fromSub, kind, reason,
            balanceAfterMicros: balance, meta, bucket: 'subscription' });
    }
    if (fromPerm > 0 || fromSub === 0) {
        await record({ user: userId, deltaMicros: -fromPerm, kind, reason,
            balanceAfterMicros: balance, meta, bucket: 'permanent' });
    }
    return { chargedMicros: amount, balanceMicros: balance };
}

export async function authorizeStep(userId) {
    const user = await User.findById(userId).select('credits');
    if (!user) throw new CreditsError('User not found', 404);
    const balance = effectiveBalanceMicros(user.credits);
    return { allowed: canAffordStep(balance), balanceMicros: balance };
}

export async function chargeForSolve(userId, upstreamCostMicros, meta = null) {
    const amount = chargeForUpstream(upstreamCostMicros);
    if (amount <= 0) {
        const u = await User.findById(userId).select('credits');
        return { chargedMicros: 0, balanceMicros: effectiveBalanceMicros(u?.credits) };
    }
    return spendCredits(userId, amount, {
        kind: 'spend', reason: 'captcha solve step',
        meta: { ...(meta || {}), upstreamCostMicros },
    });
}

export async function adminAdjust(userId, deltaMicros, { reason, actor }) {
    const amount = Math.round(Number(deltaMicros) || 0);
    if (!Number.isFinite(amount) || amount === 0) {
        throw new CreditsError('Adjustment must be a non-zero number of micros');
    }
    if (!reason || !String(reason).trim()) {
        throw new CreditsError('A reason is required for a manual adjustment');
    }
    const balance = await grantCredits(userId, amount, {
        bucket: 'permanent', kind: 'admin', reason: String(reason).trim(), actor,
    });
    const user = await User.findById(userId).select('credits email username');
    return { balanceMicros: balance, user };
}

export async function listTransactions(userId, limit = 50) {
    return CreditTransaction.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(Math.min(Number(limit) || 50, 200))
        .lean();
}
```

> Note: `adminAdjust` with a negative delta still `$inc`s permanent (can go negative), matching the documented policy; it no longer spends subscription-first, because an admin adjustment is a bookkeeping correction to the permanent pool, not a user spend.

- [ ] **Step 4: Run tests**

Run: `node --test backend/tests/credits-service.test.js`
Expected: PASS (or SKIP if no DB is configured locally — acceptable; Task 7 covers the pipeline against Mongo).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/credits.service.js backend/tests/credits-service.test.js
git commit -m "feat(credits): bucket-aware grant/spend with atomic pipeline spend"
```

---

### Task 4: Move all balance READ sites onto effective balance

**Files:**
- Modify: `backend/src/controllers/credits.controller.js:43-46,136` (`balanceView`, admin list)
- Modify: `backend/src/controllers/auth.controller.js:26-37` (`subscriptionView` — add credits)

**Interfaces:**
- Consumes: `effectiveBalanceMicros`, `displayBalanceMicros`, `microsToCredits`.
- Produces: `subscriptionView(user)` now also returns `credits: { balanceMicros, credits }`.

- [ ] **Step 1: Update `balanceView` in `credits.controller.js`**

Change imports (line 13) to add `effectiveBalanceMicros`:
```js
import { displayBalanceMicros, microsToDollars, effectiveBalanceMicros, microsToCredits } from '../utils/credits.js';
```
Replace `balanceView` (lines 43-46) — it now takes the whole `credits` subdoc:
```js
function balanceView(credits) {
    const shown = displayBalanceMicros(effectiveBalanceMicros(credits));
    return { balanceMicros: shown, balance: microsToDollars(shown), credits: microsToCredits(shown) };
}
```
Update the three call sites in this file that passed `user?.credits?.balanceMicros` to pass `user?.credits` instead:
- `getMyCredits` (line 53): `balanceView(user?.credits)`
- `internalAuthorize`: it receives `balanceMicros` from `authorizeStep`; wrap as `{ balanceMicros: displayBalanceMicros(balanceMicros), balance: microsToDollars(displayBalanceMicros(balanceMicros)), credits: microsToCredits(displayBalanceMicros(balanceMicros)) }` — extract a tiny `balanceViewFromMicros(m)` helper and use it in both `internalAuthorize` and `internalCharge`.
- `adminListUsers` (line 136): replace `balanceMicros: u.credits?.balanceMicros ?? 0` with `balanceMicros: effectiveBalanceMicros(u.credits)`.

Add the helper near `balanceView`:
```js
function balanceViewFromMicros(micros) {
    const shown = displayBalanceMicros(micros);
    return { balanceMicros: shown, balance: microsToDollars(shown), credits: microsToCredits(shown) };
}
```

- [ ] **Step 2: Expose credits in `subscriptionView`**

In `auth.controller.js`, import at top:
```js
import { effectiveBalanceMicros, displayBalanceMicros, microsToCredits } from '../utils/credits.js';
```
In `subscriptionView` return object (line 29-36), add:
```js
        credits: {
            balanceMicros: displayBalanceMicros(effectiveBalanceMicros(user?.credits)),
            credits: microsToCredits(displayBalanceMicros(effectiveBalanceMicros(user?.credits))),
        },
```

- [ ] **Step 3: Grep for any remaining `balanceMicros` field access**

Run: `git grep -n "credits?.balanceMicros\|credits.balanceMicros" backend/src`
Expected: only `keys.controller.js` and `services/revokeKey.js` remain (fixed in Task 5). If any other read site remains, switch it to `effectiveBalanceMicros(credits)`.

- [ ] **Step 4: Smoke-test the module loads**

Run: `node -e "import('./backend/src/controllers/credits.controller.js').then(()=>import('./backend/src/controllers/auth.controller.js')).then(()=>console.log('ok'))"`
Expected: `ok`.

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/credits.controller.js backend/src/controllers/auth.controller.js
git commit -m "feat(credits): read effective balance everywhere; expose credits in subscriptionView"
```

---

### Task 5: Key redeem & revoke use the right bucket

**Files:**
- Modify: `backend/src/controllers/keys.controller.js:129-148,168-171`
- Modify: `backend/src/services/revokeKey.js:102-124`

**Interfaces:**
- Consumes: `grantCredits` semantics (bucket + expiresAt), `splitSpend` (revoke), `effectiveBalanceMicros`.
- Produces: gift credits land in the subscription bucket (expiry = new `subscription.expiresAt`); lifetime gift lands in permanent; revoke reverses from the subscription bucket (permanent for lifetime).

- [ ] **Step 1: Update redeem in `keys.controller.js`**

Replace lines 129-148 (from the `// Credits ride along` comment through the ledger `create`) with:
```js
        // Credits ride along inside the SAME transaction as the subscription.
        // A gift with a time-boxed plan goes into the EXPIRING subscription
        // bucket (expiry = the freshly extended subscription.expiresAt, so
        // stacking a second key extends time and gift-credit expiry together).
        // A lifetime plan never lapses, so its gift goes to the permanent
        // bucket and needs no expiry.
        const granted = creditsForKey(key);
        if (!user.credits) user.credits = {};
        const isLifetime = user.subscription?.plan === 'lifetime';
        const bucket = isLifetime ? 'permanent' : 'subscription';
        if (granted > 0) {
            if (bucket === 'subscription') {
                user.credits.subscriptionMicros = (user.credits.subscriptionMicros || 0) + granted;
                user.credits.subscriptionCreditsExpireAt = user.subscription?.expiresAt ?? null;
            } else {
                user.credits.permanentMicros = (user.credits.permanentMicros || 0) + granted;
            }
        }
        await user.save({ session });

        if (granted > 0) {
            await CreditTransaction.create([{
                user: user._id,
                deltaMicros: granted,
                kind: 'grant',
                reason: `redeemed ${key.plan} key`,
                balanceAfterMicros: effectiveBalanceMicros(user.credits),
                bucket,
                meta: { licenseKey: key.code, plan: key.plan },
            }], { session });
        }
```
Add `effectiveBalanceMicros` to the credits import (line 7):
```js
import { creditsForKey, displayBalanceMicros, effectiveBalanceMicros, MICROS_PER_DOLLAR } from '../utils/credits.js';
```
And the response `credits` block (lines 168-171) becomes:
```js
                credits: {
                    grantedMicros: granted,
                    balanceMicros: displayBalanceMicros(effectiveBalanceMicros(user.credits)),
                },
```

- [ ] **Step 2: Update revoke in `revokeKey.js`**

Replace the credits block (lines 102-124) with a bucket-aware reversal. Reverse from the subscription bucket for a time-boxed key, permanent for lifetime; either may go negative:
```js
                // --- credits ---
                // Reverse from the bucket the grant landed in. Time-boxed gifts
                // went to the expiring subscription bucket; a lifetime gift went
                // to permanent. Either may go negative (documented policy).
                creditsReversedMicros = Number(key.creditsGrantedMicros) || 0;
                if (creditsReversedMicros > 0) {
                    if (!user.credits) user.credits = {};
                    const toPermanent = key.plan === 'lifetime';
                    if (toPermanent) {
                        user.credits.permanentMicros =
                            (user.credits.permanentMicros || 0) - creditsReversedMicros;
                    } else {
                        user.credits.subscriptionMicros =
                            (user.credits.subscriptionMicros || 0) - creditsReversedMicros;
                    }
                }

                await user.save({ session });

                if (creditsReversedMicros > 0) {
                    await CreditTransaction.create([{
                        user: user._id,
                        deltaMicros: -creditsReversedMicros,
                        kind: 'revocation',
                        reason: reason || `Key ${key.code} revoked`,
                        balanceAfterMicros: effectiveBalanceMicros(user.credits),
                        bucket: key.plan === 'lifetime' ? 'permanent' : 'subscription',
                    }], { session });
                }
```
Add the import at the top of `revokeKey.js`:
```js
import { effectiveBalanceMicros } from '../utils/credits.js';
```
(Note: the original revoke ledger row had no `balanceAfterMicros`; the schema requires it, so this also fixes a latent bug. Verify the field is now always set.)

- [ ] **Step 3: Load-check**

Run: `node -e "import('./backend/src/controllers/keys.controller.js').then(()=>import('./backend/src/services/revokeKey.js')).then(()=>console.log('ok'))"`
Expected: `ok`.

- [ ] **Step 4: Run any existing keys tests for a baseline**

Run: `node --test backend/tests/keys.controller.test.js` (if present).
Expected: same pass/fail set as before your change (stash + re-run if a failure looks new — the suite is flaky).

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/keys.controller.js backend/src/services/revokeKey.js
git commit -m "feat(credits): key gift -> subscription bucket (permanent for lifetime); revoke matches"
```

---

### Task 6: Migration script (existing balances → permanent)

**Files:**
- Create: `backend/scripts/migrate-credit-buckets.js`

**Interfaces:**
- Consumes: `User`, `connectToDatabase`.
- Produces: a one-shot idempotent migration moving legacy `credits.balanceMicros` into `credits.permanentMicros`.

- [ ] **Step 1: Write the script**

Create `backend/scripts/migrate-credit-buckets.js`:
```js
/**
 * One-shot: move legacy credits.balanceMicros into the permanent bucket.
 * We cannot tell which legacy credits were gifts vs. paid, and expiring
 * credits people already hold would generate support tickets, so ALL legacy
 * balance becomes permanent. Idempotent: users with no legacy field are skipped.
 *
 * Run: node backend/scripts/migrate-credit-buckets.js
 */
import mongoose from 'mongoose';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';

async function main() {
    await connectToDatabase();
    const cursor = User.find({ 'credits.balanceMicros': { $exists: true } }).cursor();
    let moved = 0;
    for (let u = await cursor.next(); u != null; u = await cursor.next()) {
        const legacy = u.credits?.balanceMicros || 0;
        await User.updateOne(
            { _id: u._id },
            {
                $inc: { 'credits.permanentMicros': legacy },
                $unset: { 'credits.balanceMicros': '' },
                $setOnInsert: {},
            },
        );
        moved += 1;
    }
    console.log(`[migrate] moved legacy balance for ${moved} user(s)`);
    await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 2: Dry-run check (no DB write) — verify it parses**

Run: `node --check backend/scripts/migrate-credit-buckets.js`
Expected: no output (syntax OK). Do NOT run against production here; it runs at deploy.

- [ ] **Step 3: Commit**

```bash
git add backend/scripts/migrate-credit-buckets.js
git commit -m "chore(credits): idempotent migration of legacy balance to permanent bucket"
```

---

## Phase B — Buy a subscription day with credits (omni-backend)

### Task 7: Redeem credits for a subscription day

**Files:**
- Create: `backend/src/services/subscriptionCredits.service.js`
- Create: `backend/src/controllers/subscription.controller.js`
- Create: `backend/src/routes/subscription.routes.js`
- Modify: `backend/src/server.js:19,66` (import + mount)
- Test: `backend/tests/subscription-credits.test.js`

**Interfaces:**
- Consumes: `DAY_PRICE_MICROS`, `splitSpend`, `effectiveBalanceMicros` (utils/credits.js); `computeSubscriptionAfterRedeem` (utils/applyLicenseKey.js); `subscriptionView` (auth.controller.js); `authorize` middleware.
- Produces:
  - `redeemDayWithCredits(userId) -> { subscription, credits }` (throws `CreditsError` 402 when short)
  - `POST /api/v1/subscription/redeem-credits` (authorize).

- [ ] **Step 1: Write the service**

Create `backend/src/services/subscriptionCredits.service.js`:
```js
import mongoose from 'mongoose';
import User from '../models/user.model.js';
import CreditTransaction from '../models/creditTransaction.model.js';
import { CreditsError } from './credits.service.js';
import { DAY_PRICE_MICROS, splitSpend, effectiveBalanceMicros } from '../utils/credits.js';
import { computeSubscriptionAfterRedeem } from '../utils/applyLicenseKey.js';

/**
 * Spend 80 credits and add exactly one day of subscription, atomically.
 * A credit-bought day grants NO new subscription credits (no mine->day->credits
 * loop). Uses the '30_day' arithmetic for a single day via a 1-day stack.
 */
export async function redeemDayWithCredits(userId) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const user = await User.findById(userId).session(session);
        if (!user) throw new CreditsError('User not found', 404);

        const now = new Date();
        const effective = effectiveBalanceMicros(user.credits, now);
        if (effective < DAY_PRICE_MICROS) {
            throw new CreditsError('Not enough credits for a subscription day', 402);
        }

        // Spend, subscription bucket first.
        const plan = splitSpend(user.credits, DAY_PRICE_MICROS, now);
        if (!user.credits) user.credits = {};
        user.credits.permanentMicros = plan.next.permanentMicros;
        user.credits.subscriptionMicros = plan.next.subscriptionMicros;
        user.credits.subscriptionCreditsExpireAt = plan.next.subscriptionCreditsExpireAt;

        // Extend by one day. computeSubscriptionAfterRedeem handles '30_day'
        // (30 days) — for a single day we add 1 day onto the stacking base.
        const base = (user.subscription?.expiresAt && new Date(user.subscription.expiresAt) > now)
            ? new Date(user.subscription.expiresAt) : now;
        const oneDay = new Date(base.getTime() + 24 * 60 * 60 * 1000);
        if (user.subscription?.plan === 'lifetime') {
            throw new CreditsError('Account already has a lifetime plan', 409);
        }
        user.subscription = { plan: user.subscription?.plan || '30_day', expiresAt: oneDay };

        await user.save({ session });

        const balanceAfter = effectiveBalanceMicros(user.credits, now);
        const rows = [];
        if (plan.fromSubMicros > 0) rows.push({
            user: user._id, deltaMicros: -plan.fromSubMicros, kind: 'subscription_purchase',
            reason: '1 day of subscription via credits', balanceAfterMicros: balanceAfter,
            bucket: 'subscription',
        });
        if (plan.fromPermanentMicros > 0) rows.push({
            user: user._id, deltaMicros: -plan.fromPermanentMicros, kind: 'subscription_purchase',
            reason: '1 day of subscription via credits', balanceAfterMicros: balanceAfter,
            bucket: 'permanent',
        });
        if (rows.length) await CreditTransaction.create(rows, { session });

        await session.commitTransaction();
        session.endSession();
        return { user };
    } catch (err) {
        await session.abortTransaction();
        session.endSession();
        throw err;
    }
}
```

- [ ] **Step 2: Write the controller**

Create `backend/src/controllers/subscription.controller.js`:
```js
import { redeemDayWithCredits } from '../services/subscriptionCredits.service.js';
import { CreditsError } from '../services/credits.service.js';
import { subscriptionView } from './auth.controller.js';
import { displayBalanceMicros, effectiveBalanceMicros, microsToCredits } from '../utils/credits.js';

export const redeemCreditsForDay = async (req, res, next) => {
    try {
        const { user } = await redeemDayWithCredits(req.user._id);
        const shown = displayBalanceMicros(effectiveBalanceMicros(user.credits));
        res.status(200).json({
            success: true,
            data: {
                subscription: subscriptionView(user),
                credits: { balanceMicros: shown, credits: microsToCredits(shown) },
            },
        });
    } catch (error) {
        if (error instanceof CreditsError) {
            return res.status(error.statusCode).json({ success: false, message: error.message });
        }
        next(error);
    }
};
```

- [ ] **Step 3: Write the route + mount it**

Create `backend/src/routes/subscription.routes.js`:
```js
import { Router } from 'express';
import authorize from '../middlewares/auth.middleware.js';
import { redeemCreditsForDay } from '../controllers/subscription.controller.js';

const subscriptionRouter = Router();
// Path: /api/v1/subscription/...
subscriptionRouter.post('/redeem-credits', authorize, redeemCreditsForDay);
export default subscriptionRouter;
```
In `server.js`, add the import next to the others (after line 19):
```js
import subscriptionRouter from "./backend/src/routes/subscription.routes.js";
```
And mount it after the credits router (after line 65):
```js
app.use('/api/v1/subscription', subscriptionRouter);
```

- [ ] **Step 4: Write the HTTP test**

Create `backend/tests/subscription-credits.test.js`:
```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';
import { registerUser } from './helpers/signup.js';

let dbOk = false;
before(async () => { try { await connectToDatabase(); dbOk = true; } catch { dbOk = false; } });
after(async () => { if (dbOk) await mongoose.disconnect(); });

test('80 credits buys one day; short balance is 402', { skip: !dbOk }, async () => {
    if (!dbOk) return;
    const { token, userId } = await registerUser(app); // helper returns a fresh user + JWT
    // Fund 80 credits into the permanent bucket directly.
    await User.updateOne({ _id: userId }, { $set: { 'credits.permanentMicros': 800_000 } });

    const ok = await request(app).post('/api/v1/subscription/redeem-credits')
        .set('Authorization', `Bearer ${token}`).send({});
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.subscription.active, true);
    assert.equal(ok.body.data.credits.credits, 0);

    const short = await request(app).post('/api/v1/subscription/redeem-credits')
        .set('Authorization', `Bearer ${token}`).send({});
    assert.equal(short.status, 402);

    await User.deleteOne({ _id: userId });
});
```
Check `backend/tests/helpers/signup.js` for the exact export shape; if `registerUser` returns a different shape, adapt the destructure (the helper exists per the codebase). Add this file to `test:unit`? No — it needs Mongo; run it with `npm test`.

- [ ] **Step 5: Run the test**

Run: `node --test backend/tests/subscription-credits.test.js`
Expected: PASS (or SKIP with no DB). If it fails on Arcjet 429, re-run — the suite is flaky.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/subscriptionCredits.service.js backend/src/controllers/subscription.controller.js backend/src/routes/subscription.routes.js backend/src/server.js backend/tests/subscription-credits.test.js
git commit -m "feat(subscription): buy one day for 80 credits (spend subscription bucket first)"
```

---

## Phase C — Mining subsystem (omni-backend)

### Task 8: Miner session model + enroll/status routes

**Files:**
- Create: `backend/src/models/minerSession.model.js`
- Create: `backend/src/controllers/mining.controller.js`
- Create: `backend/src/routes/mining.routes.js`
- Modify: `backend/src/server.js` (import + mount)
- Test: `backend/tests/mining-enroll.test.js`

**Interfaces:**
- Consumes: `authorize`; `crypto` (token hashing); mining config (env).
- Produces:
  - `MinerSession { user, tokenHash, createdAt, lastSeenAt, revokedAt }`, static `MinerSession.resolveToken(rawToken) -> userId | null`.
  - `POST /api/v1/mining/enroll` → `{ minerToken, stratumHost, stratumPort, algos }`
  - `GET /api/v1/mining/status` → `{ enrolled, hashrate, creditedMicros, sessionMicros, lastShareAt }`
  - `miningConfig()` from `config/mining.js` (Task 9 also uses it).

- [ ] **Step 1: Write the model**

Create `backend/src/models/minerSession.model.js`:
```js
import mongoose from 'mongoose';
import crypto from 'crypto';

/** A per-user miner credential. The raw token is shown ONCE at enroll and never
 *  stored; only its SHA-256 lives here, so a DB leak cannot mine as anyone. */
const minerSessionSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    lastSeenAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
}, { timestamps: true });

export function hashToken(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

minerSessionSchema.statics.resolveToken = async function resolveToken(raw) {
    if (!raw) return null;
    const doc = await this.findOne({ tokenHash: hashToken(raw), revokedAt: null }).lean();
    return doc ? String(doc.user) : null;
};

const MinerSession = mongoose.model('MinerSession', minerSessionSchema);
export default MinerSession;
```

- [ ] **Step 2: Write the config module**

Create `backend/src/config/mining.js`:
```js
/** Mining is pure config. The real upstream pool + wallet stay unset for now;
 *  the proxy runs against a fake upstream in tests (see services/mining/upstream.js). */
export function miningConfig() {
    return {
        stratumHost: process.env.MINING_STRATUM_HOST || '179.198.197.7',
        stratumPort: Number(process.env.MINING_STRATUM_PORT || 3333),
        proxyBindPort: Number(process.env.MINING_PROXY_PORT || 3333),
        xmr: { poolUrl: process.env.XMR_POOL_URL || '', wallet: process.env.XMR_WALLET || '' },
        rvn: { poolUrl: process.env.RVN_POOL_URL || '', wallet: process.env.RVN_WALLET || '' },
        // Per-coin valuation inputs (env-tunable; sane placeholders for tests).
        valuation: {
            xmr: { usdPerDiff: Number(process.env.XMR_USD_PER_DIFF || 0.0000001) },
            rvn: { usdPerDiff: Number(process.env.RVN_USD_PER_DIFF || 0.00000005) },
        },
    };
}
```

- [ ] **Step 3: Write the controller**

Create `backend/src/controllers/mining.controller.js`:
```js
import crypto from 'crypto';
import MinerSession, { hashToken } from '../models/minerSession.model.js';
import { miningConfig } from '../config/mining.js';
import { getUserMiningStatus } from '../services/mining/accounting.js';

export const enroll = async (req, res, next) => {
    try {
        const raw = crypto.randomBytes(24).toString('hex');
        // One active session per user: rotate by revoking old ones.
        await MinerSession.updateMany({ user: req.user._id, revokedAt: null },
            { $set: { revokedAt: new Date() } });
        await MinerSession.create({ user: req.user._id, tokenHash: hashToken(raw) });
        const cfg = miningConfig();
        res.status(200).json({
            success: true,
            data: {
                minerToken: raw,
                stratumHost: cfg.stratumHost,
                stratumPort: cfg.stratumPort,
                algos: { cpu: 'rx/0', gpu: 'kawpow' },
            },
        });
    } catch (error) { next(error); }
};

export const status = async (req, res, next) => {
    try {
        res.status(200).json({ success: true, data: await getUserMiningStatus(req.user._id) });
    } catch (error) { next(error); }
};
```

- [ ] **Step 4: Write the route + mount**

Create `backend/src/routes/mining.routes.js`:
```js
import { Router } from 'express';
import authorize from '../middlewares/auth.middleware.js';
import { enroll, status } from '../controllers/mining.controller.js';

const miningRouter = Router();
// Path: /api/v1/mining/...
miningRouter.post('/enroll', authorize, enroll);
miningRouter.get('/status', authorize, status);
export default miningRouter;
```
In `server.js`: import `miningRouter` and mount `app.use('/api/v1/mining', miningRouter);` after the subscription router.

- [ ] **Step 5: Stub `getUserMiningStatus` so the module loads**

Create `backend/src/services/mining/accounting.js` (expanded in Task 10) with at least:
```js
// In-memory per-user accrual, keyed by userId string. Flushed to credits by
// the payout loop (Task 10). Replaced/extended there — keep the export name.
const accrual = new Map(); // userId -> { diffByCoin: {xmr,rvn}, hashrate, lastShareAt, sessionMicros }

export function recordAcceptedShare(userId, coin, difficulty) {
    const a = accrual.get(userId) || { diffByCoin: { xmr: 0, rvn: 0 }, hashrate: 0, lastShareAt: null, sessionMicros: 0 };
    a.diffByCoin[coin] = (a.diffByCoin[coin] || 0) + Number(difficulty || 0);
    a.lastShareAt = new Date();
    accrual.set(userId, a);
}

export function _getAccrual() { return accrual; }

export async function getUserMiningStatus(userId) {
    const a = accrual.get(String(userId));
    return {
        enrolled: true,
        hashrate: a?.hashrate || 0,
        creditedMicros: 0, // filled from the ledger in Task 10
        sessionMicros: a?.sessionMicros || 0,
        lastShareAt: a?.lastShareAt || null,
    };
}
```

- [ ] **Step 6: Write the enroll test**

Create `backend/tests/mining-enroll.test.js`:
```js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import MinerSession from '../src/models/minerSession.model.js';
import { registerUser } from './helpers/signup.js';

let dbOk = false;
before(async () => { try { await connectToDatabase(); dbOk = true; } catch { dbOk = false; } });
after(async () => { if (dbOk) await mongoose.disconnect(); });

test('enroll issues a token that resolves to the user', { skip: !dbOk }, async () => {
    if (!dbOk) return;
    const { token, userId } = await registerUser(app);
    const res = await request(app).post('/api/v1/mining/enroll')
        .set('Authorization', `Bearer ${token}`).send({});
    assert.equal(res.status, 200);
    assert.ok(res.body.data.minerToken.length >= 32);
    const resolved = await MinerSession.resolveToken(res.body.data.minerToken);
    assert.equal(resolved, String(userId));
    await MinerSession.deleteMany({ user: userId });
});
```

- [ ] **Step 7: Run the test**

Run: `node --test backend/tests/mining-enroll.test.js`
Expected: PASS (or SKIP without DB).

- [ ] **Step 8: Commit**

```bash
git add backend/src/models/minerSession.model.js backend/src/config/mining.js backend/src/controllers/mining.controller.js backend/src/routes/mining.routes.js backend/src/services/mining/accounting.js backend/src/server.js backend/tests/mining-enroll.test.js
git commit -m "feat(mining): miner session model + enroll/status routes"
```

---

### Task 9: Share valuation (pure) + stratum proxy with a fake upstream

**Files:**
- Create: `backend/src/services/mining/valuation.js`
- Create: `backend/src/services/mining/upstream.js`
- Create: `backend/src/services/mining/stratumProxy.js`
- Test: `backend/tests/mining-valuation.test.js`
- Test: `backend/tests/mining-proxy.test.js`

**Interfaces:**
- Consumes: `miningConfig`, `MinerSession.resolveToken`, `recordAcceptedShare` (accounting.js).
- Produces:
  - `shareValueMicros(coin, difficulty, cfg = miningConfig()) -> micros` (gross, before payout rate)
  - `FakeUpstream` — an in-process pool that accepts every share at a fixed difficulty.
  - `startStratumProxy({ port, upstreamFactory, resolveToken }) -> server` and `stopStratumProxy(server)`.

- [ ] **Step 1: Write the valuation test (pure, add to `test:unit`)**

Create `backend/tests/mining-valuation.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareValueMicros } from '../src/services/mining/valuation.js';

const cfg = { valuation: { xmr: { usdPerDiff: 0.0000001 }, rvn: { usdPerDiff: 0.00000005 } } };

test('gross share value scales with difficulty and coin rate', () => {
    // 1e6 diff * 1e-7 usd/diff = $0.10 => 100_000 micros
    assert.equal(shareValueMicros('xmr', 1_000_000, cfg), 100_000);
    assert.equal(shareValueMicros('rvn', 1_000_000, cfg), 50_000);
    assert.equal(shareValueMicros('xmr', 0, cfg), 0);
    assert.equal(shareValueMicros('doge', 1, cfg), 0); // unknown coin
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test backend/tests/mining-valuation.test.js`
Expected: FAIL (module missing).

- [ ] **Step 3: Write valuation**

Create `backend/src/services/mining/valuation.js`:
```js
import { MICROS_PER_DOLLAR } from '../../utils/credits.js';
import { miningConfig } from '../../config/mining.js';

/** GROSS USD value of one accepted share, in micros. Payout rate is applied
 *  later, in the payout loop, so this stays a pure price function. */
export function shareValueMicros(coin, difficulty, cfg = miningConfig()) {
    const rate = cfg?.valuation?.[coin]?.usdPerDiff;
    if (!rate) return 0;
    const usd = (Number(difficulty) || 0) * rate;
    return Math.max(0, Math.round(usd * MICROS_PER_DOLLAR));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node --test backend/tests/mining-valuation.test.js`
Expected: PASS.

- [ ] **Step 5: Write the upstream connector + fake**

Create `backend/src/services/mining/upstream.js`:
```js
import net from 'net';
import { EventEmitter } from 'events';

/**
 * Minimal stratum-ish upstream contract the proxy talks to. Real pools speak
 * JSON-RPC over TCP; this wraps that. The upstream is DEFERRED (no wallet/pool
 * configured yet), so production plugs a real connector in here later.
 */
export class RealUpstream extends EventEmitter {
    constructor({ host, port, wallet, worker }) {
        super();
        Object.assign(this, { host, port, wallet, worker });
    }
    connect() {
        this.sock = net.connect(this.port, this.host);
        this.sock.on('data', (b) => this.emit('data', b));
        this.sock.on('error', (e) => this.emit('error', e));
        this.sock.on('close', () => this.emit('close'));
    }
    send(line) { this.sock?.write(line.endsWith('\n') ? line : line + '\n'); }
    destroy() { this.sock?.destroy(); }
}

/** Test upstream: accepts every submit at a fixed difficulty and reports it. */
export class FakeUpstream extends EventEmitter {
    constructor({ difficulty = 1000 } = {}) { super(); this.difficulty = difficulty; }
    connect() { setImmediate(() => this.emit('ready')); }
    send() {} // ignore login/subscribe
    submit() { setImmediate(() => this.emit('accepted', { difficulty: this.difficulty })); }
    destroy() {}
}
```

- [ ] **Step 6: Write the proxy**

Create `backend/src/services/mining/stratumProxy.js`:
```js
import net from 'net';
import { RealUpstream } from './upstream.js';
import { miningConfig } from '../../config/mining.js';
import MinerSession from '../../models/minerSession.model.js';
import { recordAcceptedShare } from './accounting.js';

/**
 * A TCP stratum proxy. A miner logs in with its minerToken as the username;
 * the proxy resolves it to a userId, opens an upstream connection (real pool or
 * a fake), forwards traffic, and counts ONLY upstream-accepted shares.
 *
 * Injectable deps make it testable without a real pool:
 *  - upstreamFactory({ coin, cfg, worker }) -> upstream emitting 'accepted'
 *  - resolveToken(raw) -> userId (defaults to MinerSession.resolveToken)
 */
export function startStratumProxy({
    port = miningConfig().proxyBindPort,
    upstreamFactory = ({ coin, cfg, worker }) => new RealUpstream({
        host: coin === 'rvn' ? undefined : undefined, // real pool host from cfg[coin].poolUrl (deferred)
        port, wallet: cfg[coin]?.wallet, worker,
    }),
    resolveToken = (raw) => MinerSession.resolveToken(raw),
    cfg = miningConfig(),
} = {}) {
    const server = net.createServer((sock) => {
        let userId = null;
        let coin = 'xmr';
        let upstream = null;
        let buf = '';

        sock.on('data', async (chunk) => {
            buf += chunk.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let msg;
                try { msg = JSON.parse(line); } catch { continue; }

                // Login: {"method":"login","params":{"login":"<token>.<coin>"}}
                if (msg.method === 'login' || msg.method === 'mining.authorize') {
                    const login = msg.params?.login || msg.params?.[0] || '';
                    const [rawToken, coinTag] = String(login).split('.');
                    coin = coinTag === 'rvn' ? 'rvn' : 'xmr';
                    userId = await resolveToken(rawToken);
                    if (!userId) { sock.destroy(); return; }
                    upstream = upstreamFactory({ coin, cfg, worker: userId });
                    upstream.on('accepted', ({ difficulty }) => {
                        recordAcceptedShare(String(userId), coin, difficulty);
                    });
                    upstream.on('error', () => sock.destroy());
                    upstream.on('close', () => sock.destroy());
                    upstream.connect();
                    sock.write(JSON.stringify({ id: msg.id, result: { status: 'OK' }, error: null }) + '\n');
                    continue;
                }
                // Share submit → forward to upstream.
                if (msg.method === 'submit' || msg.method === 'mining.submit') {
                    if (userId && upstream) {
                        upstream.submit(msg.params);
                        sock.write(JSON.stringify({ id: msg.id, result: true, error: null }) + '\n');
                    }
                    continue;
                }
            }
        });
        sock.on('error', () => { upstream?.destroy?.(); });
        sock.on('close', () => { upstream?.destroy?.(); });
    });
    server.listen(port);
    return server;
}

export function stopStratumProxy(server) {
    return new Promise((resolve) => (server ? server.close(resolve) : resolve()));
}
```

- [ ] **Step 7: Write the proxy integration test (fake upstream, in-memory resolve)**

Create `backend/tests/mining-proxy.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'net';
import { startStratumProxy, stopStratumProxy } from '../src/services/mining/stratumProxy.js';
import { FakeUpstream } from '../src/services/mining/upstream.js';
import { _getAccrual } from '../src/services/mining/accounting.js';

test('proxy authorizes a token and counts an accepted share', async () => {
    const PORT = 39333;
    const server = startStratumProxy({
        port: PORT,
        upstreamFactory: () => new FakeUpstream({ difficulty: 1000 }),
        resolveToken: async () => 'user-abc',
    });
    try {
        await new Promise((resolve, reject) => {
            const c = net.connect(PORT, '127.0.0.1', () => {
                c.write(JSON.stringify({ id: 1, method: 'login', params: { login: 'tok.xmr' } }) + '\n');
                setTimeout(() => {
                    c.write(JSON.stringify({ id: 2, method: 'submit', params: {} }) + '\n');
                }, 50);
            });
            let seen = 0;
            c.on('data', () => { seen += 1; if (seen >= 2) { c.end(); resolve(); } });
            c.on('error', reject);
            setTimeout(() => reject(new Error('timeout')), 2000);
        });
        await new Promise((r) => setTimeout(r, 50));
        const a = _getAccrual().get('user-abc');
        assert.ok(a && a.diffByCoin.xmr === 1000, 'accepted share difficulty accrued');
    } finally {
        await stopStratumProxy(server);
    }
});
```

- [ ] **Step 8: Run both mining tests**

Run: `node --test backend/tests/mining-valuation.test.js backend/tests/mining-proxy.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add backend/src/services/mining/valuation.js backend/src/services/mining/upstream.js backend/src/services/mining/stratumProxy.js backend/tests/mining-valuation.test.js backend/tests/mining-proxy.test.js
git commit -m "feat(mining): share valuation + stratum proxy (fake upstream, accepted-share accounting)"
```

---

### Task 10: Payout loop (accrual → credits) + wire proxy into the server

**Files:**
- Modify: `backend/src/services/mining/accounting.js` (add payout flush)
- Modify: `backend/src/server.js` (start proxy + payout loop under `isMainModule`)
- Test: `backend/tests/mining-payout.test.js`

**Interfaces:**
- Consumes: `shareValueMicros`, `MINING_PAYOUT_RATE`, `grantCredits`, `CreditTransaction`.
- Produces:
  - `flushPayouts({ cfg, grant }) -> [{ userId, grantedMicros }]` (drains accrual, pays 80%)
  - `startPayoutLoop({ intervalMs }) -> stop()`
  - `getUserMiningStatus` now reads `creditedMicros` from the ledger.

- [ ] **Step 1: Write the payout test**

Create `backend/tests/mining-payout.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordAcceptedShare, flushPayouts, _getAccrual } from '../src/services/mining/accounting.js';

test('flush pays 80% of gross accepted-share value and drains accrual', async () => {
    _getAccrual().clear();
    recordAcceptedShare('u1', 'xmr', 1_000_000); // gross $0.10 = 100_000 micros
    const grants = [];
    const cfg = { valuation: { xmr: { usdPerDiff: 0.0000001 }, rvn: { usdPerDiff: 0 } } };
    const out = await flushPayouts({ cfg, grant: async (userId, micros) => { grants.push([userId, micros]); return micros; } });
    assert.equal(grants.length, 1);
    assert.equal(grants[0][0], 'u1');
    assert.equal(grants[0][1], 80_000); // 80% of 100_000
    assert.equal(out[0].grantedMicros, 80_000);
    assert.equal(_getAccrual().size, 0); // drained
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test backend/tests/mining-payout.test.js`
Expected: FAIL — `flushPayouts` missing.

- [ ] **Step 3: Extend `accounting.js`**

Append to `backend/src/services/mining/accounting.js`:
```js
import { shareValueMicros } from './valuation.js';
import { MINING_PAYOUT_RATE } from '../../utils/credits.js';
import { grantCredits as defaultGrant } from '../credits.service.js';
import { miningConfig } from '../../config/mining.js';
import CreditTransaction from '../../models/creditTransaction.model.js';

/**
 * Convert accrued accepted-share difficulty into credits at MINING_PAYOUT_RATE,
 * grant to the PERMANENT bucket, and drain the accrual. Sub-credit remainders
 * are carried forward (kept in the accrual as leftover micros).
 */
export async function flushPayouts({ cfg = miningConfig(), grant = defaultGrant } = {}) {
    const results = [];
    for (const [userId, a] of accrual.entries()) {
        let grossMicros = a.leftoverMicros || 0;
        for (const coin of ['xmr', 'rvn']) {
            grossMicros += shareValueMicros(coin, a.diffByCoin[coin] || 0, cfg);
        }
        const payMicros = Math.floor(grossMicros * MINING_PAYOUT_RATE);
        if (payMicros <= 0) { continue; }
        try {
            await grant(userId, payMicros, {
                bucket: 'permanent', kind: 'mining', reason: 'mining payout',
                meta: { xmrDiff: a.diffByCoin.xmr || 0, rvnDiff: a.diffByCoin.rvn || 0 },
            });
            results.push({ userId, grantedMicros: payMicros });
        } catch (e) {
            console.error('[mining] payout failed', userId, e?.message);
            continue; // keep the accrual so a failed grant is retried next flush
        }
        accrual.delete(userId);
    }
    return results;
}

export function startPayoutLoop({ intervalMs = 60_000 } = {}) {
    const t = setInterval(() => { flushPayouts().catch((e) => console.error('[mining] flush', e?.message)); }, intervalMs);
    t.unref?.();
    return () => clearInterval(t);
}
```
Then upgrade `getUserMiningStatus` to read lifetime credited from the ledger:
```js
export async function getUserMiningStatus(userId) {
    const a = accrual.get(String(userId));
    let creditedMicros = 0;
    try {
        const rows = await CreditTransaction.aggregate([
            { $match: { user: (await import('mongoose')).default.Types.ObjectId.createFromHexString(String(userId)), kind: 'mining' } },
            { $group: { _id: null, total: { $sum: '$deltaMicros' } } },
        ]);
        creditedMicros = rows[0]?.total || 0;
    } catch { /* no DB in a unit context */ }
    return {
        enrolled: true,
        hashrate: a?.hashrate || 0,
        creditedMicros,
        sessionMicros: a?.sessionMicros || 0,
        lastShareAt: a?.lastShareAt || null,
    };
}
```
(Remove the earlier stub version of `getUserMiningStatus` from Task 8 so only this one remains.)

- [ ] **Step 4: Run the payout test**

Run: `node --test backend/tests/mining-payout.test.js`
Expected: PASS.

- [ ] **Step 5: Start proxy + payout loop in `server.js`**

Inside the `if (isMainModule)` block, after `app.listen(...)`, add:
```js
    // Mining: the stratum proxy + payout loop run with the main server only.
    import('./backend/src/services/mining/stratumProxy.js').then(({ startStratumProxy }) => {
        startStratumProxy();
        console.log('✅ Stratum proxy listening');
    });
    import('./backend/src/services/mining/accounting.js').then(({ startPayoutLoop }) => {
        startPayoutLoop({ intervalMs: 60_000 });
    });
```
Also add a line to `ecosystem.config.cjs` env if the proxy port needs to be opened on the VPS firewall — note it in the commit body (deployment step, not code).

- [ ] **Step 6: Add mining tests to `test:unit`**

Update `package.json` `test:unit` to include `backend/tests/mining-payout.test.js` and `backend/tests/mining-proxy.test.js`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/mining/accounting.js backend/src/server.js backend/tests/mining-payout.test.js package.json
git commit -m "feat(mining): payout loop pays 80% of accepted-share value into permanent bucket"
```

---

## Phase D — Executor: miner download + run (omni-executor Python)

> Switch repos: `cd ../omni-executor`. Create a matching branch: `git checkout -b feature/mining-earn-credits`.

### Task 11: `miner.py` — download & install XMRig on demand

**Files:**
- Create: `omni-executor/miner.py`
- Test: `omni-executor/tests/test_miner.py`

**Interfaces:**
- Consumes: `bootstrap.runtime_dir`, `bootstrap.download_blob`, `bootstrap.dist_base`, `bootstrap.read_manifest`, `bootstrap._hash_file`.
- Produces:
  - `miner_dir() -> Path` (`runtime_dir()/miner`)
  - `is_installed() -> bool`
  - `install(progress=None) -> dict` (downloads from the `tools` channel, atomic swap)
  - `binary_path() -> Path` (`miner_dir()/xmrig(.exe)`)

- [ ] **Step 1: Write the failing test**

Create `omni-executor/tests/test_miner.py`:
```python
import os
import hashlib
from pathlib import Path
import pytest
import miner


def test_miner_dir_under_runtime(tmp_path, monkeypatch):
    monkeypatch.setenv("OMNIEXEC_RUNTIME_DIR", str(tmp_path))
    d = miner.miner_dir()
    assert d == Path(tmp_path) / "miner"


def test_install_verifies_and_places(tmp_path, monkeypatch):
    monkeypatch.setenv("OMNIEXEC_RUNTIME_DIR", str(tmp_path))
    payload = b"fake-xmrig-binary"
    sha = hashlib.sha256(payload).hexdigest()
    artifact = {"name": "xmrig-win", "url": "/omni/dist/blob/xmrig", "bytes": len(payload), "sha256": sha, "kind": "tool", "dest": "miner", "exe": "xmrig.exe"}

    monkeypatch.setattr(miner.bootstrap, "read_manifest",
                        lambda *a, **k: {"ok": True, "artifacts": [artifact]})
    monkeypatch.setattr(miner.bootstrap, "dist_base", lambda: "http://x")

    def fake_download(base, art, tmp, progress=None):
        tmp.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_bytes(payload)
        if progress:
            progress({"phase": "download", "artifact": art["name"], "received": len(payload), "total": len(payload), "percent": 100})
    monkeypatch.setattr(miner.bootstrap, "download_blob", fake_download)

    seen = []
    res = miner.install(progress=lambda p: seen.append(p))
    assert res["ok"] is True
    assert miner.is_installed() is True
    assert miner.binary_path().read_bytes() == payload
    assert any(p.get("percent") == 100 for p in seen)
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ../omni-executor && python -m pytest tests/test_miner.py -v`
Expected: FAIL — `miner` module not found.

- [ ] **Step 3: Implement `miner.py`**

Create `omni-executor/miner.py`:
```python
"""On-demand XMRig download + install.

Miners trip Windows Defender, so the binary is NOT in the installer. It is
fetched only after the user enrolls, from the `tools` dist channel, and
recorded as kind:"tool" so it never gates first-boot readiness. Reuses
bootstrap's sha256-verified, resumable download and atomic swap so a running
miner is never overwritten half-way.
"""
import shutil
import sys
from pathlib import Path

import bootstrap

MINER_CHANNEL = "tools"
_ARTIFACT_NAME = "xmrig-win" if sys.platform == "win32" else "xmrig-linux"


def miner_dir() -> Path:
    d = bootstrap.runtime_dir() / "miner"
    d.mkdir(parents=True, exist_ok=True)
    return d


def binary_path() -> Path:
    exe = "xmrig.exe" if sys.platform == "win32" else "xmrig"
    return miner_dir() / exe


def is_installed() -> bool:
    return binary_path().exists()


def _find_artifact(manifest: dict) -> dict:
    for art in manifest.get("artifacts", []):
        if art.get("name") == _ARTIFACT_NAME:
            return art
    raise bootstrap.BootstrapError(f"{_ARTIFACT_NAME} not in the {MINER_CHANNEL} manifest")


def install(progress=None) -> dict:
    """Download + place the miner. Idempotent: a good existing binary is kept."""
    base = bootstrap.dist_base()
    manifest = bootstrap.read_manifest(base, channel=MINER_CHANNEL)
    art = _find_artifact(manifest)

    staging = miner_dir() / f"_part_{(art.get('sha256') or 'nohash')[:12]}"
    bootstrap.download_blob(base, art, staging, progress=progress)

    # Atomic-ish swap: write to <exe>.new, then replace, so a running miner is
    # not clobbered mid-write (mirrors bootstrap._install_qemu_portable).
    exe = binary_path()
    new = exe.with_suffix(exe.suffix + ".new")
    if new.exists():
        new.unlink()
    shutil.move(str(staging), str(new))
    if sys.platform != "win32":
        new.chmod(0o755)
    if exe.exists():
        old = exe.with_suffix(exe.suffix + ".old")
        if old.exists():
            old.unlink()
        exe.replace(old)
    new.replace(exe)
    return {"ok": True, "path": str(exe), "name": art["name"]}
```

- [ ] **Step 4: Run to verify it passes**

Run: `python -m pytest tests/test_miner.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add miner.py tests/test_miner.py
git commit -m "feat(miner): on-demand verified XMRig download (tools channel, atomic swap)"
```

---

### Task 12: `Api.mining_*` methods + Defender exclusion + cloud helpers

**Files:**
- Modify: `omni-executor/cloud.py` (add `mining_enroll`, `mining_status`)
- Modify: `omni-executor/main.py` (add `Api.mining_*`, subprocess mgmt)
- Test: `omni-executor/tests/test_mining_api.py`

**Interfaces:**
- Consumes: `cloud.request`, `miner.install/binary_path/is_installed`, `self._push`.
- Produces:
  - `cloud.mining_enroll() -> dict`, `cloud.mining_status() -> dict`, `cloud.redeem_credits_for_day() -> dict`
  - `Api.mining_status()`, `Api.mining_enroll()`, `Api.mining_start(mode, intensity)`, `Api.mining_stop()`, `Api.mining_add_defender_exclusion()`, `Api.buy_day_with_credits()`
  - push events: `mining-progress`, `mining-stat`, `mining-done`, `mining-error`

- [ ] **Step 1: Add cloud helpers**

In `cloud.py`, after `register`/auth flows, add:
```python
def mining_enroll():
    """Enroll for mining; returns {minerToken, stratumHost, stratumPort, algos}."""
    res = request("POST", "/api/v1/mining/enroll", {})
    return res.get("data", res)


def mining_status():
    res = request("GET", "/api/v1/mining/status")
    return res.get("data", res)


def redeem_credits_for_day():
    res = request("POST", "/api/v1/subscription/redeem-credits", {})
    return res.get("data", res)
```

- [ ] **Step 2: Write the API test (mock cloud + subprocess)**

Create `omni-executor/tests/test_mining_api.py`:
```python
import types
import pytest
import main


class FakeBridge:
    def __init__(self): self.events = []
    def push(self, event, payload=None): self.events.append((event, payload))


@pytest.fixture
def api(monkeypatch):
    a = main.Api.__new__(main.Api)   # bypass heavy __init__
    a._bridge = FakeBridge()
    a._mining = None
    a._mining_proc = None
    return a


def test_enroll_downloads_and_stores(api, monkeypatch):
    monkeypatch.setattr(main.cloud, "mining_enroll",
                        lambda: {"minerToken": "T", "stratumHost": "h", "stratumPort": 3333,
                                 "algos": {"cpu": "rx/0", "gpu": "kawpow"}})
    called = {}
    monkeypatch.setattr(main.miner, "install", lambda progress=None: called.setdefault("install", True) or {"ok": True})
    res = api.mining_enroll()
    assert res["ok"] is True
    assert called.get("install") is True
    # token cached on the instance for mining_start
    assert api._mining and api._mining.get("minerToken") == "T"


def test_start_requires_enroll(api):
    res = api.mining_start("cpu", 50)
    assert res["ok"] is False
    assert res["error"] == "not_enrolled"


def test_defender_exclusion_builds_elevated_command(api, monkeypatch):
    captured = {}
    monkeypatch.setattr(main, "_run_elevated", lambda args: captured.setdefault("args", args) or {"ok": True})
    monkeypatch.setattr(main.miner, "miner_dir", lambda: __import__("pathlib").Path(r"C:\x\miner"))
    res = api.mining_add_defender_exclusion()
    assert res["ok"] is True
    assert any("Add-MpPreference" in str(x) for x in captured["args"])
```

- [ ] **Step 3: Run to verify it fails**

Run: `python -m pytest tests/test_mining_api.py -v`
Expected: FAIL — methods and `_run_elevated`/`import miner`/`import cloud` wiring missing.

- [ ] **Step 4: Implement in `main.py`**

At the top of `main.py`, ensure `import cloud`, `import miner`, `import subprocess`, `import threading` are present (add any missing). Add a module-level helper near the other Windows helpers:
```python
def _run_elevated(args):
    """Run a PowerShell command elevated (one UAC prompt). Windows only."""
    if sys.platform != "win32":
        return {"ok": False, "error": "not_windows"}
    import subprocess
    joined = "; ".join(args) if isinstance(args, (list, tuple)) else str(args)
    ps = ("Start-Process powershell -Verb RunAs -WindowStyle Hidden "
          f"-ArgumentList '-NoProfile','-Command','{joined}'")
    try:
        subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True, timeout=120)
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": "elevation_failed", "message": str(e)}
```
In `Api.__init__`, initialise state (near the other flags):
```python
        self._mining = None          # {minerToken, stratumHost, stratumPort, algos}
        self._mining_proc = None     # the running xmrig Popen
```
Add the methods to `class Api`:
```python
    # ---- mining / earn ----

    def mining_status(self):
        local = {"installed": miner.is_installed(), "running": self._mining_proc is not None}
        try:
            remote = cloud.mining_status()
        except cloud.CloudError as e:
            return {"ok": True, **local, "remote_error": str(e)}
        return {"ok": True, **local, **remote}

    def mining_enroll(self):
        try:
            info = cloud.mining_enroll()
        except cloud.CloudError as e:
            return {"ok": False, "error": e.error or "enroll_failed", "message": str(e)}
        self._mining = info
        try:
            miner.install(progress=lambda p: self._push("mining-progress", p))
        except Exception as e:  # noqa: BLE001
            self._push("mining-error", {"error": str(e)})
            return {"ok": False, "error": "download_failed", "message": str(e)}
        self._push("mining-done", {"phase": "install"})
        return {"ok": True, **info}

    def mining_start(self, mode="both", intensity=50):
        if not self._mining:
            return {"ok": False, "error": "not_enrolled"}
        if not miner.is_installed():
            return {"ok": False, "error": "not_installed"}
        if self._mining_proc is not None:
            return {"ok": False, "error": "already_running"}
        token = self._mining["minerToken"]
        host = self._mining["stratumHost"]
        port = self._mining["stratumPort"]
        args = [str(miner.binary_path()), "--url", f"{host}:{port}", "--user", f"{token}.xmr",
                "--pass", "x", "--donate-level", "0"]
        if mode == "cpu":
            args += ["--no-cuda", "--no-opencl"]
        elif mode == "gpu":
            args += ["--cuda", "--opencl", "--no-cpu", "--user", f"{token}.rvn", "--algo", "kawpow"]
        # 'both' leaves CPU on and GPU backends on.
        import subprocess
        try:
            self._mining_proc = subprocess.Popen(
                args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "spawn_failed", "message": str(e)}
        threading.Thread(target=self._mining_reader, daemon=True).start()
        return {"ok": True, "started": True, "mode": mode}

    def _mining_reader(self):
        proc = self._mining_proc
        if not proc or not proc.stdout:
            return
        for line in proc.stdout:
            line = line.rstrip()
            self._push("mining-stat", {"line": line})
        code = proc.wait()
        self._mining_proc = None
        self._push("mining-done", {"phase": "run", "code": code})

    def mining_stop(self):
        proc = self._mining_proc
        if not proc:
            return {"ok": True, "stopped": False}
        try:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
        finally:
            self._mining_proc = None
        return {"ok": True, "stopped": True}

    def mining_add_defender_exclusion(self):
        path = str(miner.miner_dir())
        return _run_elevated([f"Add-MpPreference -ExclusionPath '{path}'"])

    def buy_day_with_credits(self):
        try:
            data = cloud.redeem_credits_for_day()
        except cloud.CloudError as e:
            return {"ok": False, "error": e.error or "purchase_failed", "message": str(e)}
        return {"ok": True, **data}
```

- [ ] **Step 5: Run tests**

Run: `python -m pytest tests/test_mining_api.py -v`
Expected: PASS. Also run the whole executor suite for a baseline: `python -m pytest -q` (green baseline is a non-zero known-failing count — compare names, not just the count).

- [ ] **Step 6: Commit**

```bash
git add cloud.py main.py tests/test_mining_api.py
git commit -m "feat(executor): mining Api methods (enroll/start/stop), defender exclusion, day purchase"
```

---

## Phase E — Executor: Earn tab (frontend)

### Task 13: Earn tab UI + wiring + dev mock

**Files:**
- Create: `omni-executor/frontend/src/components/EarnView.jsx`
- Modify: `frontend/src/components/icons.jsx` (add `EarnDuoIcon`)
- Modify: `frontend/src/App.jsx` (import, NAV entry, render, ContextBar branch)
- Modify: `frontend/src/api.js` (mining helpers)
- Modify: `frontend/src/devMock.js` (mining stubs)

**Interfaces:**
- Consumes: `api`, `onEngineEvent` (api.js); `Panel`, `PanelHead`, `Button`, `Toggle`, `Notice`, `Lamp` (ui.jsx); `auth` prop (carries `subscription.credits`).
- Produces: an `EarnView` rendered from `App.jsx` NAV id `"earn"`.

- [ ] **Step 1: Add api helpers**

In `frontend/src/api.js`, append:
```js
// ---- earn / mining ----
export const miningStatus = () => api("mining_status");
export const miningEnroll = () => api("mining_enroll");
export const miningStart = (mode, intensity) => api("mining_start", mode, intensity);
export const miningStop = () => api("mining_stop");
export const miningAddDefenderExclusion = () => api("mining_add_defender_exclusion");
export const buyDayWithCredits = () => api("buy_day_with_credits");
```

- [ ] **Step 2: Add the icon**

In `frontend/src/components/icons.jsx`, add an `EarnDuoIcon` following the existing duotone pattern (a coin/spark). Match the signature of the other `*DuoIcon` exports (they take `{ className }` / size props — copy `ChartDuoIcon`'s wrapper exactly, swapping the paths):
```jsx
export function EarnDuoIcon(props) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <circle cx="12" cy="12" r="8" className="opacity-30" fill="currentColor" />
      <path d="M12 7v10M9.5 9.5c0-1 1-1.5 2.5-1.5s2.5.5 2.5 1.5-1 1.5-2.5 1.5-2.5.5-2.5 1.5 1 1.5 2.5 1.5 2.5-.5 2.5-1.5"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
```

- [ ] **Step 3: Write `EarnView.jsx`**

Create `frontend/src/components/EarnView.jsx` (modeled on `StatTrackView.jsx`: hides itself with `hidden` when not `active`, polls while active):
```jsx
import { useCallback, useEffect, useRef, useState } from "react";
import {
  miningStatus, miningEnroll, miningStart, miningStop,
  miningAddDefenderExclusion, buyDayWithCredits, onEngineEvent,
} from "../api.js";
import { Panel, PanelHead, Button, Notice, Lamp } from "./ui.jsx";

const POLL_MS = 5000;
const DAY_PRICE_CREDITS = 80;

export default function EarnView({ active, auth, showToast }) {
  const [status, setStatus] = useState(null);
  const [phase, setPhase] = useState("idle"); // idle | enrolling | running
  const [progress, setProgress] = useState(null);
  const [mode, setMode] = useState("both");
  const [lines, setLines] = useState([]);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);

  const credits = auth?.subscription?.credits?.credits ?? status?.creditedMicros != null
    ? Math.round((auth?.subscription?.credits?.credits ?? 0)) : 0;

  const refresh = useCallback(async () => {
    const s = await miningStatus();
    if (s && !s.error) setStatus(s);
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer.current);
  }, [active, refresh]);

  useEffect(() => {
    return onEngineEvent((event, payload) => {
      if (event === "mining-progress") setProgress(payload);
      if (event === "mining-stat") setLines((l) => [...l.slice(-200), payload?.line]);
      if (event === "mining-done" && payload?.phase === "install") { setProgress(null); refresh(); }
      if (event === "mining-error") { setProgress(null); showToast?.(payload?.error || "Mining error", "danger"); }
    });
  }, [refresh, showToast]);

  const enroll = async () => {
    setBusy(true); setPhase("enrolling");
    const res = await miningEnroll();
    setBusy(false);
    if (!res?.ok) { setPhase("idle"); showToast?.(res?.message || "Enroll failed", "danger"); return; }
    showToast?.("Miner downloaded", "ok");
    refresh();
  };

  const start = async () => {
    const res = await miningStart(mode, 50);
    if (res?.ok) { setPhase("running"); showToast?.("Mining started", "ok"); }
    else showToast?.(res?.message || "Could not start", "danger");
  };

  const stop = async () => {
    await miningStop(); setPhase("idle"); showToast?.("Mining stopped", "ok");
  };

  const addExclusion = async () => {
    const res = await miningAddDefenderExclusion();
    showToast?.(res?.ok ? "Defender exclusion added" : "Exclusion skipped", res?.ok ? "ok" : "warn");
  };

  const buyDay = async () => {
    setBusy(true);
    const res = await buyDayWithCredits();
    setBusy(false);
    if (res?.ok) showToast?.("Added 1 day of subscription", "ok");
    else showToast?.(res?.message || "Not enough credits", "danger");
  };

  const installed = status?.installed;
  const running = status?.running || phase === "running";

  return (
    <div className={active ? "" : "hidden"}>
      <Panel>
        <PanelHead title="Earn credits" subtitle="Mine with your CPU/GPU — 100 credits = $1" />
        {!installed ? (
          <div className="space-y-4 p-4">
            <Notice tone="warn">
              The miner is extra content that is downloaded separately. Windows
              Defender flags mining software as a threat — this is expected for
              all miners. Enrolling downloads the miner into your OmniExec folder;
              you can optionally add a Defender exclusion for that folder.
            </Notice>
            <Button onClick={enroll} disabled={busy}>
              {phase === "enrolling" ? "Downloading…" : "Download miner & enroll"}
            </Button>
            {progress ? (
              <div className="text-sm text-ink-2">
                {Math.round(progress.percent || 0)}% — {progress.artifact}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4 p-4">
            <div className="flex items-center gap-3">
              <Lamp on={running} />
              <span>{running ? "Mining" : "Idle"}</span>
              <span className="ml-auto text-ink-2">Hashrate: {status?.hashrate ?? 0} H/s</span>
            </div>
            <div className="flex gap-2">
              {["cpu", "gpu", "both"].map((m) => (
                <Button key={m} tone={mode === m ? "accent" : "ghost"} onClick={() => setMode(m)}>
                  {m.toUpperCase()}
                </Button>
              ))}
            </div>
            {!running
              ? <Button onClick={start}>Start mining</Button>
              : <Button tone="danger" onClick={stop}>Stop mining</Button>}
            <Button tone="ghost" onClick={addExclusion}>Add Defender exclusion</Button>
            <div className="mt-2 rounded bg-raised p-2 font-mono text-xs text-ink-2 max-h-40 overflow-auto">
              {lines.length ? lines.map((l, i) => <div key={i}>{l}</div>) : <div>No output yet.</div>}
            </div>
          </div>
        )}
      </Panel>

      <Panel>
        <PanelHead title="Your credits" subtitle="Spend on subscription time" />
        <div className="flex items-center gap-4 p-4">
          <div className="text-2xl font-semibold">{credits} credits</div>
          <Button className="ml-auto" onClick={buyDay} disabled={busy || credits < DAY_PRICE_CREDITS}>
            Buy 1 day — {DAY_PRICE_CREDITS} credits
          </Button>
        </div>
      </Panel>
    </div>
  );
}
```
> If `Notice`/`Lamp`/`Button` props differ from the above (tones, `on`), open `components/ui.jsx` and match the real prop names — the report lists these components at `ui.jsx:19-235`. Adjust prop names to the real ones; do not invent new props.

- [ ] **Step 4: Wire into `App.jsx`**

- Import: add `import EarnView from "./components/EarnView.jsx";` and add `EarnDuoIcon` to the icons import block (lines 19-27).
- NAV: add an entry to the `NAV` array (after `network`, before `settings` — it becomes `Ctrl+7`, Settings shifts to `Ctrl+8`; update the two `hint` strings accordingly):
```js
  { id: "earn", label: "Earn", Icon: EarnDuoIcon, hint: "7" },
  { id: "settings", label: "Settings", Icon: GearDuoIcon, hint: "8" },
```
- Render: in the views block (~263-311) add, following the `StatTrackView` pattern (pass the same props the siblings get — `active`, plus `auth` and `showToast`):
```jsx
        <EarnView active={tab === "earn"} auth={auth} showToast={showToast} />
```
Confirm the exact names the sibling views use for the auth object and the toast function in this file (e.g. it may be `authState` / `pushToast`); match them.
- ContextBar: add a branch to the ternary chain (~323-354):
```jsx
        : tab === "earn" ? "Earn credits by mining"
```

- [ ] **Step 5: Add dev-mock stubs**

In `frontend/src/devMock.js`, add handlers so `?mock` preview works:
```js
  mining_status: async () => ({ ok: true, installed: false, running: false, hashrate: 0, creditedMicros: 0 }),
  mining_enroll: async () => ({ ok: true, minerToken: "mock", stratumHost: "localhost", stratumPort: 3333 }),
  mining_start: async () => ({ ok: true, started: true }),
  mining_stop: async () => ({ ok: true, stopped: true }),
  mining_add_defender_exclusion: async () => ({ ok: true }),
  buy_day_with_credits: async () => ({ ok: true, subscription: { active: true }, credits: { credits: 0 } }),
```

- [ ] **Step 6: Build the frontend to verify it compiles**

Run: `cd frontend && npm run build`
Expected: build succeeds, no unresolved imports. (This is the real test for a UI task — there is no unit test harness for these components.)

- [ ] **Step 7: Visual check in the browser preview**

Run: `npm run dev` and open with `?mock` (loaded via `main.jsx`). Click the **Earn** tab; confirm the not-installed state shows the Defender warning and the enroll button, and the credits panel renders.

- [ ] **Step 8: Commit**

```bash
cd .. && git add frontend/src/components/EarnView.jsx frontend/src/components/icons.jsx frontend/src/App.jsx frontend/src/api.js frontend/src/devMock.js
git commit -m "feat(executor): Earn tab — enroll, mine (cpu/gpu/both), spend credits on a day"
```

---

## Self-Review

**Spec coverage:**
- Money model (units, 100 credits/$1, 80% payout, day = 80 credits) → Task 1 constants. ✓
- Two buckets, spend order, lazy expiry → Tasks 1-3. ✓
- Ledger bucket + kinds → Task 2. ✓
- Grant/spend service, atomic pipeline → Task 3. ✓
- Read sites on effective balance, subscriptionView credits → Task 4. ✓
- Key gift → subscription bucket, lifetime → permanent, revoke → Task 5. ✓
- Migration (→ permanent) → Task 6. ✓
- Buy a day for 80 credits, no loop → Task 7. ✓
- Miner session/token, enroll/status → Task 8. ✓
- Valuation, stratum proxy, fake upstream, accepted-share accounting → Task 9. ✓
- Payout 80% → permanent, wired into server → Task 10. ✓
- On-demand miner download (tools channel, verified, atomic) → Task 11. ✓
- Api mining_* + Defender exclusion + day purchase → Task 12. ✓
- Earn tab UI, Defender warning, CPU/GPU/both, balance, buy-day → Task 13. ✓
- Pool deferred (env unset, fake in tests) → Tasks 9-10 config. ✓
- Out of scope (BTCPay top-up, real pool, macOS miner) → not built. ✓

**Type consistency:** `credits` shape `{ permanentMicros, subscriptionMicros, subscriptionCreditsExpireAt }` is used identically in Tasks 1-7. `grantCredits(userId, micros, { bucket, kind, reason, expiresAt, meta })` signature matches all callers (Tasks 3, 5, 10). `splitSpend(...).next` shape matches Task 7's assignment. `recordAcceptedShare(userId, coin, difficulty)` and `flushPayouts({ cfg, grant })` match across Tasks 8-10. Push event names (`mining-progress`, `mining-stat`, `mining-done`, `mining-error`) match between Task 12 (Python emits) and Task 13 (JS listens). `mining_enroll/start/stop/status` names match across cloud.py, main.py, api.js, devMock.js.

**Known adaptation points flagged inline (not placeholders — real lookups the implementer must confirm against existing code):** exact `ui.jsx` prop names; the `App.jsx` auth/toast prop names; the `tests/helpers/signup.js` return shape. Each step says to match the real names rather than invent.
