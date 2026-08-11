# Accounts, License Keys, and Download Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a redeemable license-key system on top of the existing email/password auth, and an authenticated download manifest/file API, so `omnidroid`/omni-executor have somewhere real to pull QEMU, base images, and installer updates from.

**Architecture:** Everything is added to the existing `omni-backend` Express/Mongoose app — no new services. Three new Mongoose models (`User` extended, `LicenseKey`, `Artifact`), two new route groups (`/api/v1/keys`, `/api/v1/downloads`) reusing the existing `authorize` Bearer-JWT middleware, and a new `adminOnly` middleware for key generation. Downloadable files live on local disk under `omni-backend/storage/downloads/`, served via `res.sendFile` (which gives Range-request support for free, needed for resumable multi-GB downloads later). A DB-backed `Artifact` catalog means publishing a new build is just inserting a row, not a redeploy.

**Tech Stack:** Node.js (ESM), Express 4, Mongoose 8, `node:test` + `node:assert/strict` (built-in test runner, new to this repo), `supertest` (new devDependency) for HTTP-level tests.

## Global Constraints

- Everything in this plan is built and tested against the existing local dev setup (the Atlas dev cluster already wired into `.env.development.local`). No local Mongo/Redis needed. **No deployment to the Hostinger VPS in this plan** — that happens later, only after explicit user confirmation.
- Nothing enforces subscription/key state anywhere yet. Redemption is bookkeeping only (`user.subscription`), not gating.
- No purchase/payment flow, no admin UI panel. Admin actions are an authenticated API endpoint called with curl/Postman, plus a one-off local script.
- All new routes reuse the **existing** `authorize` middleware (`backend/src/middlewares/auth.middleware.js`) — no new auth mechanism.
- Downloads require login (any account) — no subscription/key check on download endpoints.
- Files under `omni-backend/storage/downloads/` are never committed to git.
- Key redemption **stacks**: a new key's duration extends from the later of (current `expiresAt`, now). Redeeming a `1_month`/`3_month` key while already on `lifetime` is rejected with 409 rather than silently downgrading. Redeeming `lifetime` while already `lifetime` is a harmless no-op.
- The manifest's "latest" artifact per `(category, platform, arch)` is whichever `Artifact` row has the newest `createdAt` — no separate "current release" pointer.

---

### Task 1: User model — role + subscription fields, test harness setup

**Files:**
- Modify: `omni-backend/package.json` (add `test` script)
- Modify: `omni-backend/backend/src/models/user.model.js`
- Create: `omni-backend/backend/tests/user.model.test.js`

**Interfaces:**
- Produces: `User` model instances now have `role: 'user' | 'admin'` (default `'user'`) and `subscription: { plan: '1_month' | '3_month' | 'lifetime' | null, expiresAt: Date | null }` (both default `null`). Later tasks read/write `user.subscription` and `user.role` directly (it's a normal Mongoose subdocument path, not a separate model).

- [ ] **Step 1: Add the test script and create the tests directory**

Edit `omni-backend/package.json` — add a `test` entry to `"scripts"`:

```json
  "scripts": {
    "start": "node server.js",
    "dev": "nodemon server.js",
    "test": "node --test backend/tests"
  },
```

- [ ] **Step 2: Write the failing test**

Create `omni-backend/backend/tests/user.model.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import User from '../src/models/user.model.js';

describe('User model defaults', () => {
    it('defaults role to user and subscription to inactive', () => {
        const user = new User({ email: 'defaults@omni.test', password: 'hunter22' });
        const obj = user.toObject();
        assert.equal(obj.role, 'user');
        assert.equal(obj.subscription.plan, null);
        assert.equal(obj.subscription.expiresAt, null);
    });

    it('rejects an invalid role', () => {
        const user = new User({ email: 'bad@omni.test', password: 'hunter22', role: 'superuser' });
        const err = user.validateSync();
        assert.ok(err, 'expected a validation error');
        assert.ok(err.errors.role, 'expected role to be the invalid field');
    });
});
```

- [ ] **Step 3: Run the test and verify it fails**

Run (from `omni-backend/`): `npm test`
Expected: FAIL — `obj.role` is `undefined`, not `'user'` (the field doesn't exist yet).

- [ ] **Step 4: Add the fields to the User model**

Edit `omni-backend/backend/src/models/user.model.js` — replace the whole file:

```js
import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
    email: {
        type: String,
        required: [true, "Email is required"],
        unique: true,
        trim: true,
        lowercase: true,
        match: [/\S+@\S+\.\S+/, "Please fill a valid email address"],
    },
    password: {
        type: String,
        required: [true, "Password is required"],
        minLength: 6
    },
    role: {
        type: String,
        enum: ['user', 'admin'],
        default: 'user',
    },
    subscription: {
        plan: {
            type: String,
            enum: ['1_month', '3_month', 'lifetime', null],
            default: null,
        },
        expiresAt: {
            type: Date,
            default: null,
        },
    },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

export default User;
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `npm test`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
cd "omni-backend"
git add package.json backend/src/models/user.model.js backend/tests/user.model.test.js
git commit -m "feat(auth): add role and subscription fields to User model"
```

---

### Task 2: LicenseKey model + key-code generator utility

**Files:**
- Create: `omni-backend/backend/src/models/licenseKey.model.js`
- Create: `omni-backend/backend/src/utils/generateKeyCode.js`
- Create: `omni-backend/backend/tests/licenseKey.model.test.js`
- Create: `omni-backend/backend/tests/generateKeyCode.test.js`

**Interfaces:**
- Consumes: none (standalone).
- Produces: `LicenseKey` default-exported Mongoose model with fields `code, plan, status, createdBy, redeemedBy, redeemedAt` (used by Task 7). `generateKeyCode(): string` named export producing codes matching `/^OMNI-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/` (used by Task 7).

- [ ] **Step 1: Write the failing tests**

Create `omni-backend/backend/tests/generateKeyCode.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyCode } from '../src/utils/generateKeyCode.js';

describe('generateKeyCode', () => {
    it('matches the OMNI-XXXX-XXXX-XXXX format', () => {
        const code = generateKeyCode();
        assert.match(code, /^OMNI-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    });

    it('excludes ambiguous characters (0, O, 1, I)', () => {
        const code = generateKeyCode();
        assert.doesNotMatch(code, /[01OI]/);
    });

    it('produces distinct codes across many calls', () => {
        const codes = new Set(Array.from({ length: 500 }, generateKeyCode));
        assert.equal(codes.size, 500);
    });
});
```

Create `omni-backend/backend/tests/licenseKey.model.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import LicenseKey from '../src/models/licenseKey.model.js';

describe('LicenseKey model', () => {
    it('defaults status to unused', () => {
        const key = new LicenseKey({
            code: 'OMNI-TEST-TEST-TEST',
            plan: '1_month',
            createdBy: new mongoose.Types.ObjectId(),
        });
        assert.equal(key.toObject().status, 'unused');
    });

    it('rejects an invalid plan', () => {
        const key = new LicenseKey({
            code: 'OMNI-TEST-TEST-TEST',
            plan: 'yearly',
            createdBy: new mongoose.Types.ObjectId(),
        });
        const err = key.validateSync();
        assert.ok(err && err.errors.plan);
    });

    it('requires createdBy', () => {
        const key = new LicenseKey({ code: 'OMNI-TEST-TEST-TEST', plan: 'lifetime' });
        const err = key.validateSync();
        assert.ok(err && err.errors.createdBy);
    });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test`
Expected: FAIL with module-not-found errors for both new test files (the source files don't exist yet).

- [ ] **Step 3: Implement the key-code generator**

Create `omni-backend/backend/src/utils/generateKeyCode.js`:

```js
import crypto from 'crypto';

// No 0/O or 1/I: both are easy to mistype/misread when a key is read off a
// screen or dictated over chat, which is how these will actually change hands.
const GROUP_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const GROUP_COUNT = 3;
const GROUP_LENGTH = 4;

function randomGroup() {
    let group = '';
    const bytes = crypto.randomBytes(GROUP_LENGTH);
    for (let i = 0; i < GROUP_LENGTH; i++) {
        group += GROUP_CHARS[bytes[i] % GROUP_CHARS.length];
    }
    return group;
}

export function generateKeyCode() {
    const groups = Array.from({ length: GROUP_COUNT }, randomGroup);
    return `OMNI-${groups.join('-')}`;
}
```

- [ ] **Step 4: Implement the LicenseKey model**

Create `omni-backend/backend/src/models/licenseKey.model.js`:

```js
import mongoose from 'mongoose';

const licenseKeySchema = new mongoose.Schema({
    code: {
        type: String,
        required: true,
        unique: true,
    },
    plan: {
        type: String,
        enum: ['1_month', '3_month', 'lifetime'],
        required: true,
    },
    status: {
        type: String,
        enum: ['unused', 'redeemed', 'revoked'],
        default: 'unused',
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    redeemedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
    },
    redeemedAt: {
        type: Date,
        default: null,
    },
}, { timestamps: true });

const LicenseKey = mongoose.model('LicenseKey', licenseKeySchema);

export default LicenseKey;
```

- [ ] **Step 5: Run tests and verify they pass**

Run: `npm test`
Expected: PASS (all tests, including Task 1's).

- [ ] **Step 6: Commit**

```bash
git add backend/src/models/licenseKey.model.js backend/src/utils/generateKeyCode.js backend/tests/licenseKey.model.test.js backend/tests/generateKeyCode.test.js
git commit -m "feat(keys): add LicenseKey model and key-code generator"
```

---

### Task 3: Artifact model (download catalog)

**Files:**
- Create: `omni-backend/backend/src/models/artifact.model.js`
- Create: `omni-backend/backend/tests/artifact.model.test.js`

**Interfaces:**
- Consumes: none.
- Produces: `Artifact` default-exported Mongoose model with fields `category ('qemu'|'base_image'|'executor'), platform ('windows'|'macos'|'linux'), arch ('x86'|'arm'|null), version, filename, sha256, sizeBytes` (used by Task 8).

- [ ] **Step 1: Write the failing test**

Create `omni-backend/backend/tests/artifact.model.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import Artifact from '../src/models/artifact.model.js';

describe('Artifact model', () => {
    it('accepts a valid qemu artifact with no arch', () => {
        const artifact = new Artifact({
            category: 'qemu',
            platform: 'windows',
            version: '9.1.0',
            filename: 'qemu/windows/qemu-portable-9.1.0.zip',
            sha256: 'a'.repeat(64),
            sizeBytes: 123456,
        });
        assert.equal(artifact.validateSync(), undefined);
    });

    it('accepts a valid base_image artifact with arch', () => {
        const artifact = new Artifact({
            category: 'base_image',
            platform: 'windows',
            arch: 'arm',
            version: '2026.08.11',
            filename: 'base_image/windows/arm/base_arm.qcow2',
            sha256: 'b'.repeat(64),
            sizeBytes: 5_000_000_000,
        });
        assert.equal(artifact.validateSync(), undefined);
    });

    it('rejects an unknown category', () => {
        const artifact = new Artifact({
            category: 'launcher',
            platform: 'windows',
            version: '1.0.0',
            filename: 'x',
            sha256: 'a'.repeat(64),
            sizeBytes: 1,
        });
        const err = artifact.validateSync();
        assert.ok(err && err.errors.category);
    });
});
```

- [ ] **Step 2: Run test and verify it fails**

Run: `npm test`
Expected: FAIL — module not found (`artifact.model.js` doesn't exist).

- [ ] **Step 3: Implement the Artifact model**

Create `omni-backend/backend/src/models/artifact.model.js`:

```js
import mongoose from 'mongoose';

const artifactSchema = new mongoose.Schema({
    category: {
        type: String,
        enum: ['qemu', 'base_image', 'executor'],
        required: true,
    },
    platform: {
        type: String,
        enum: ['windows', 'macos', 'linux'],
        required: true,
    },
    arch: {
        type: String,
        enum: ['x86', 'arm', null],
        default: null,
    },
    version: {
        type: String,
        required: true,
    },
    filename: {
        type: String,
        required: true,
    },
    sha256: {
        type: String,
        required: true,
    },
    sizeBytes: {
        type: Number,
        required: true,
    },
}, { timestamps: true });

const Artifact = mongoose.model('Artifact', artifactSchema);

export default Artifact;
```

- [ ] **Step 4: Run test and verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/models/artifact.model.js backend/tests/artifact.model.test.js
git commit -m "feat(downloads): add Artifact model (download catalog)"
```

---

### Task 4: Subscription redemption math (pure function)

**Files:**
- Create: `omni-backend/backend/src/utils/applyLicenseKey.js`
- Create: `omni-backend/backend/tests/applyLicenseKey.test.js`

**Interfaces:**
- Consumes: none (pure function, no DB).
- Produces: `computeSubscriptionAfterRedeem(currentSubscription, keyPlan, now = new Date()): { plan, expiresAt }` and `class LicenseKeyError extends Error` (has `.statusCode`). Both named exports, consumed by Task 7's `redeemKey` controller.

- [ ] **Step 1: Write the failing tests**

Create `omni-backend/backend/tests/applyLicenseKey.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeSubscriptionAfterRedeem, LicenseKeyError } from '../src/utils/applyLicenseKey.js';

describe('computeSubscriptionAfterRedeem', () => {
    const now = new Date('2026-08-11T00:00:00Z');

    it('starts a fresh 1_month subscription from now', () => {
        const result = computeSubscriptionAfterRedeem({ plan: null, expiresAt: null }, '1_month', now);
        assert.equal(result.plan, '1_month');
        assert.equal(result.expiresAt.toISOString(), '2026-09-11T00:00:00.000Z');
    });

    it('stacks a 3_month key on top of remaining time', () => {
        const current = { plan: '1_month', expiresAt: new Date('2026-08-21T00:00:00Z') }; // 10 days left
        const result = computeSubscriptionAfterRedeem(current, '3_month', now);
        assert.equal(result.plan, '3_month');
        assert.equal(result.expiresAt.toISOString(), '2026-11-21T00:00:00.000Z');
    });

    it('resets from now when the current subscription already expired', () => {
        const current = { plan: '1_month', expiresAt: new Date('2026-01-01T00:00:00Z') };
        const result = computeSubscriptionAfterRedeem(current, '1_month', now);
        assert.equal(result.expiresAt.toISOString(), '2026-09-11T00:00:00.000Z');
    });

    it('sets a lifetime plan with a null expiresAt', () => {
        const current = { plan: '1_month', expiresAt: new Date('2026-08-21T00:00:00Z') };
        const result = computeSubscriptionAfterRedeem(current, 'lifetime', now);
        assert.deepEqual(result, { plan: 'lifetime', expiresAt: null });
    });

    it('rejects a time-boxed key when already on lifetime', () => {
        assert.throws(
            () => computeSubscriptionAfterRedeem({ plan: 'lifetime', expiresAt: null }, '1_month', now),
            (err) => err instanceof LicenseKeyError && err.statusCode === 409
        );
    });

    it('allows redeeming another lifetime key while already lifetime (no-op)', () => {
        const result = computeSubscriptionAfterRedeem({ plan: 'lifetime', expiresAt: null }, 'lifetime', now);
        assert.deepEqual(result, { plan: 'lifetime', expiresAt: null });
    });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test`
Expected: FAIL — module not found (`applyLicenseKey.js` doesn't exist).

- [ ] **Step 3: Implement the redemption logic**

Create `omni-backend/backend/src/utils/applyLicenseKey.js`:

```js
export class LicenseKeyError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.name = 'LicenseKeyError';
        this.statusCode = statusCode;
    }
}

function addMonths(date, months) {
    const result = new Date(date.getTime());
    result.setMonth(result.getMonth() + months);
    return result;
}

const PLAN_MONTHS = { '1_month': 1, '3_month': 3 };

/**
 * Pure function: given a user's current subscription and the plan on a key
 * being redeemed, returns the new subscription object. Throws
 * LicenseKeyError (409) if the redemption would downgrade an active
 * lifetime plan.
 */
export function computeSubscriptionAfterRedeem(currentSubscription, keyPlan, now = new Date()) {
    const currentPlan = currentSubscription?.plan ?? null;
    const currentExpiresAt = currentSubscription?.expiresAt
        ? new Date(currentSubscription.expiresAt)
        : null;

    if (currentPlan === 'lifetime' && keyPlan !== 'lifetime') {
        throw new LicenseKeyError(
            'This account already has a lifetime plan; a time-boxed key would downgrade it.',
            409
        );
    }

    if (keyPlan === 'lifetime') {
        return { plan: 'lifetime', expiresAt: null };
    }

    const months = PLAN_MONTHS[keyPlan];
    if (!months) {
        throw new LicenseKeyError(`Unknown plan "${keyPlan}"`, 400);
    }

    const base = (currentExpiresAt && currentExpiresAt > now) ? currentExpiresAt : now;
    return { plan: keyPlan, expiresAt: addMonths(base, months) };
}
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/utils/applyLicenseKey.js backend/tests/applyLicenseKey.test.js
git commit -m "feat(keys): pure subscription redemption/stacking logic"
```

---

### Task 5: adminOnly middleware

**Files:**
- Create: `omni-backend/backend/src/middlewares/admin.middleware.js`
- Create: `omni-backend/backend/tests/admin.middleware.test.js`

**Interfaces:**
- Consumes: `req.user` as set by the existing `authorize` middleware (a Mongoose `User` document, has `.role`).
- Produces: default-exported Express middleware `adminOnly(req, res, next)`, consumed by Task 7's key-generation route (mounted after `authorize`).

- [ ] **Step 1: Write the failing tests**

Create `omni-backend/backend/tests/admin.middleware.test.js`:

```js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import adminOnly from '../src/middlewares/admin.middleware.js';

function mockRes() {
    const res = {};
    res.statusCode = null;
    res.body = null;
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
}

describe('adminOnly middleware', () => {
    it('calls next for an admin user', () => {
        let called = false;
        adminOnly({ user: { role: 'admin' } }, mockRes(), () => { called = true; });
        assert.ok(called);
    });

    it('403s a non-admin user', () => {
        let called = false;
        const res = mockRes();
        adminOnly({ user: { role: 'user' } }, res, () => { called = true; });
        assert.equal(called, false);
        assert.equal(res.statusCode, 403);
    });

    it('403s when req.user is missing', () => {
        const res = mockRes();
        adminOnly({}, res, () => {});
        assert.equal(res.statusCode, 403);
    });
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run: `npm test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the middleware**

Create `omni-backend/backend/src/middlewares/admin.middleware.js`:

```js
const adminOnly = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    next();
};

export default adminOnly;
```

- [ ] **Step 4: Run tests and verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/middlewares/admin.middleware.js backend/tests/admin.middleware.test.js
git commit -m "feat(keys): add adminOnly middleware"
```

---

### Task 6: Make server.js test-safe + Express test harness proof

**Files:**
- Modify: `omni-backend/server.js`
- Modify: `omni-backend/package.json` (add `supertest` devDependency)
- Create: `omni-backend/backend/tests/app.harness.test.js`

**Interfaces:**
- Produces: `server.js` default-exports the Express `app` **without** calling `app.listen()` when imported (only when run directly as `node server.js`), so tests can `import app from '../../server.js'` and drive it with `supertest` without binding a real port or double-connecting to Mongo. Tasks 7 and 8 both add router imports/mounts to this same file.

- [ ] **Step 1: Add supertest as a devDependency**

Run (from `omni-backend/`): `npm install --save-dev supertest`

- [ ] **Step 2: Guard `app.listen()` behind a main-module check**

Edit `omni-backend/server.js` — replace the whole file:

```js
import express from "express";

import path from 'path';
import { fileURLToPath } from 'url';

import cookieParser from 'cookie-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { PORT } from "./backend/src/config/env.js";

import authRouter from "./backend/src/routes/auth.routes.js";
import userRouter from "./backend/src/routes/user.routes.js";
import connectToDatabase from "./backend/src/database/mongodb.js";
import errorMiddleware from "./backend/src/middlewares/error.middleware.js";
import arcjetMiddleware from "./backend/src/middlewares/arcjet.middleware.js";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use('/api', arcjetMiddleware);

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', userRouter);

// TODO: add a production logic
const reactBuildPath = path.join(__dirname, 'frontend', 'dist');
app.use(express.static(reactBuildPath));

app.get('*', (req, res) => {
    res.sendFile(path.join(reactBuildPath, 'index.html'));
});

app.use(errorMiddleware);

// Importing this module (e.g. from a test file) must never bind a real
// port or open a second DB connection — only `node server.js` does that.
const isMainModule = process.argv[1] === __filename;

if (isMainModule) {
    app.listen(PORT, "0.0.0.0", async () => {
        console.log(`✅ Server running on port ${PORT}`);

        await connectToDatabase();
    });
}

export default app;
```

(Only the bottom `app.listen(...)` call changed — it's now wrapped in the `isMainModule` check.)

- [ ] **Step 3: Write the harness test**

Create `omni-backend/backend/tests/app.harness.test.js`:

```js
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';

describe('app smoke test', () => {
    before(async () => {
        await connectToDatabase();
    });

    after(async () => {
        await mongoose.connection.close();
    });

    it('signs a new user up and lists it back', async () => {
        const email = `harness-${Date.now()}@omni.test`;
        const signUp = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email, password: 'hunter22' });
        assert.equal(signUp.status, 201);

        const users = await request(app).get('/api/v1/users');
        assert.equal(users.status, 200);
        assert.ok(users.body.data.some((u) => u.email === email));

        await User.deleteOne({ email });
    });
});
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `npm test`
Expected: PASS, and the process exits on its own (proof `app.listen()` did not fire). This test needs network access to the Atlas dev cluster and to the Arcjet API (the existing `/api` middleware calls out to Arcjet on every request) — both are already configured in `.env.development.local`.

- [ ] **Step 5: Commit**

```bash
git add server.js package.json package-lock.json backend/tests/app.harness.test.js
git commit -m "refactor(server): guard app.listen behind main-module check for testability"
```

---

### Task 7: Keys API — generate + redeem

**Files:**
- Create: `omni-backend/backend/src/controllers/keys.controller.js`
- Create: `omni-backend/backend/src/routes/keys.routes.js`
- Modify: `omni-backend/server.js`
- Create: `omni-backend/backend/tests/keys.test.js`

**Interfaces:**
- Consumes: `LicenseKey`, `User` models (Tasks 1–2), `generateKeyCode()` (Task 2), `computeSubscriptionAfterRedeem`/`LicenseKeyError` (Task 4), `authorize`/`adminOnly` middleware (existing / Task 5).
- Produces: `POST /api/v1/keys/generate` (admin-only), `POST /api/v1/keys/redeem` (any logged-in user), mounted in `server.js`.

- [ ] **Step 1: Write the failing integration test**

Create `omni-backend/backend/tests/keys.test.js`:

```js
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';
import LicenseKey from '../src/models/licenseKey.model.js';

describe('keys API', () => {
    let adminToken, adminEmail, userToken, userEmail;
    const createdCodes = [];

    before(async () => {
        await connectToDatabase();

        adminEmail = `keys-admin-${Date.now()}@omni.test`;
        const adminSignUp = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email: adminEmail, password: 'hunter22' });
        adminToken = adminSignUp.body.data.token;
        await User.updateOne({ email: adminEmail }, { role: 'admin' });

        userEmail = `keys-user-${Date.now()}@omni.test`;
        const userSignUp = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email: userEmail, password: 'hunter22' });
        userToken = userSignUp.body.data.token;
    });

    after(async () => {
        await User.deleteMany({ email: { $in: [adminEmail, userEmail] } });
        await LicenseKey.deleteMany({ code: { $in: createdCodes } });
        await mongoose.connection.close();
    });

    it('rejects key generation from a non-admin', async () => {
        const res = await request(app)
            .post('/api/v1/keys/generate')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ plan: '1_month', count: 1 });
        assert.equal(res.status, 403);
    });

    it('lets an admin generate keys and a user redeem one', async () => {
        const generateRes = await request(app)
            .post('/api/v1/keys/generate')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ plan: '1_month', count: 1 });
        assert.equal(generateRes.status, 201);
        const [code] = generateRes.body.data.codes;
        createdCodes.push(code);
        assert.match(code, /^OMNI-/);

        const redeemRes = await request(app)
            .post('/api/v1/keys/redeem')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code });
        assert.equal(redeemRes.status, 200);
        assert.equal(redeemRes.body.data.subscription.plan, '1_month');

        const reRedeemRes = await request(app)
            .post('/api/v1/keys/redeem')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code });
        assert.equal(reRedeemRes.status, 409);
    });

    it('404s on an unknown code', async () => {
        const res = await request(app)
            .post('/api/v1/keys/redeem')
            .set('Authorization', `Bearer ${userToken}`)
            .send({ code: 'OMNI-0000-0000-0000' });
        assert.equal(res.status, 404);
    });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/routes/keys.routes.js'` (nothing implemented yet).

- [ ] **Step 3: Implement the controller**

Create `omni-backend/backend/src/controllers/keys.controller.js`:

```js
import LicenseKey from '../models/licenseKey.model.js';
import { generateKeyCode } from '../utils/generateKeyCode.js';
import { computeSubscriptionAfterRedeem } from '../utils/applyLicenseKey.js';

const VALID_PLANS = ['1_month', '3_month', 'lifetime'];
const MAX_GENERATE_COUNT = 100;

async function createUniqueKey(plan, createdBy, attemptsLeft = 5) {
    const code = generateKeyCode();
    try {
        const key = await LicenseKey.create({ code, plan, createdBy });
        return key.code;
    } catch (error) {
        if (error.code === 11000 && attemptsLeft > 1) {
            return createUniqueKey(plan, createdBy, attemptsLeft - 1);
        }
        throw error;
    }
}

export const generateKeys = async (req, res, next) => {
    try {
        const { plan, count = 1 } = req.body;

        if (!VALID_PLANS.includes(plan)) {
            const error = new Error(`plan must be one of ${VALID_PLANS.join(', ')}`);
            error.statusCode = 400;
            throw error;
        }
        if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATE_COUNT) {
            const error = new Error(`count must be an integer between 1 and ${MAX_GENERATE_COUNT}`);
            error.statusCode = 400;
            throw error;
        }

        const codes = [];
        for (let i = 0; i < count; i++) {
            codes.push(await createUniqueKey(plan, req.user._id));
        }

        res.status(201).json({ success: true, data: { codes } });
    } catch (error) {
        next(error);
    }
};

export const redeemKey = async (req, res, next) => {
    try {
        const { code } = req.body;
        if (typeof code !== 'string' || !code.trim()) {
            const error = new Error('A key code is required');
            error.statusCode = 400;
            throw error;
        }

        const key = await LicenseKey.findOne({ code: code.trim() });
        if (!key) {
            const error = new Error('Key not found');
            error.statusCode = 404;
            throw error;
        }
        if (key.status !== 'unused') {
            const error = new Error(`Key is already ${key.status}`);
            error.statusCode = 409;
            throw error;
        }

        req.user.subscription = computeSubscriptionAfterRedeem(req.user.subscription, key.plan);
        await req.user.save();

        key.status = 'redeemed';
        key.redeemedBy = req.user._id;
        key.redeemedAt = new Date();
        await key.save();

        res.status(200).json({ success: true, data: { subscription: req.user.subscription } });
    } catch (error) {
        next(error);
    }
};
```

`LicenseKeyError` already carries `.statusCode` from its constructor (Task 4), so `errorMiddleware` handles it exactly like any other thrown error — no special-casing needed here.

- [ ] **Step 4: Implement the routes**

Create `omni-backend/backend/src/routes/keys.routes.js`:

```js
import { Router } from 'express';

import authorize from '../middlewares/auth.middleware.js';
import adminOnly from '../middlewares/admin.middleware.js';
import { generateKeys, redeemKey } from '../controllers/keys.controller.js';

const keysRouter = Router();

// Path: /api/v1/keys/...

keysRouter.post('/generate', authorize, adminOnly, generateKeys);
keysRouter.post('/redeem', authorize, redeemKey);

export default keysRouter;
```

- [ ] **Step 5: Mount the router**

Edit `omni-backend/server.js` — add the import next to `userRouter`:

```js
import userRouter from "./backend/src/routes/user.routes.js";
import keysRouter from "./backend/src/routes/keys.routes.js";
```

and mount it next to the other `/api/v1` routes:

```js
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1/keys', keysRouter);
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server.js backend/src/controllers/keys.controller.js backend/src/routes/keys.routes.js backend/tests/keys.test.js
git commit -m "feat(keys): add key generation (admin) and redemption endpoints"
```

---

### Task 8: Downloads API — manifest + file streaming

**Files:**
- Create: `omni-backend/backend/src/controllers/downloads.controller.js`
- Create: `omni-backend/backend/src/routes/downloads.routes.js`
- Modify: `omni-backend/server.js`
- Modify: `omni-backend/.gitignore`
- Create: `omni-backend/storage/downloads/.gitkeep`
- Create: `omni-backend/backend/tests/downloads.test.js`

**Interfaces:**
- Consumes: `Artifact` model (Task 3), `authorize` middleware (existing).
- Produces: `GET /api/v1/downloads/manifest`, `GET /api/v1/downloads/file/:category/:platform[?arch=]`, mounted in `server.js`. Exports `DOWNLOADS_ROOT` (absolute path constant) from the controller — later sub-projects (the `omnidroid`/executor download client, and Task 9/10's scripts here) resolve artifact files relative to this same root.

- [ ] **Step 1: Write the failing integration test**

Create `omni-backend/backend/tests/downloads.test.js`:

```js
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import request from 'supertest';
import mongoose from 'mongoose';
import app from '../../server.js';
import connectToDatabase from '../src/database/mongodb.js';
import User from '../src/models/user.model.js';
import Artifact from '../src/models/artifact.model.js';
import { DOWNLOADS_ROOT } from '../src/controllers/downloads.controller.js';

describe('downloads API', () => {
    let userToken, userEmail;
    const testRelativePath = 'qemu/windows/_test-artifact.txt';
    const testContent = 'not a real qemu build, just test bytes\n';

    before(async () => {
        await connectToDatabase();

        userEmail = `downloads-user-${Date.now()}@omni.test`;
        const signUp = await request(app)
            .post('/api/v1/auth/sign-up')
            .send({ email: userEmail, password: 'hunter22' });
        userToken = signUp.body.data.token;

        const absolutePath = path.join(DOWNLOADS_ROOT, testRelativePath);
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        fs.writeFileSync(absolutePath, testContent);

        await Artifact.create({
            category: 'qemu',
            platform: 'windows',
            version: '0.0.0-test',
            filename: testRelativePath,
            sha256: crypto.createHash('sha256').update(testContent).digest('hex'),
            sizeBytes: Buffer.byteLength(testContent),
        });
    });

    after(async () => {
        await User.deleteOne({ email: userEmail });
        await Artifact.deleteMany({ version: '0.0.0-test' });
        fs.rmSync(path.join(DOWNLOADS_ROOT, testRelativePath), { force: true });
        await mongoose.connection.close();
    });

    it('rejects an unauthenticated manifest request', async () => {
        const res = await request(app).get('/api/v1/downloads/manifest');
        assert.equal(res.status, 401);
    });

    it('lists the test artifact in the manifest', async () => {
        const res = await request(app)
            .get('/api/v1/downloads/manifest')
            .set('Authorization', `Bearer ${userToken}`);
        assert.equal(res.status, 200);
        const entry = res.body.data.find((a) => a.version === '0.0.0-test');
        assert.ok(entry, 'expected the test artifact in the manifest');
        assert.equal(entry.url, '/api/v1/downloads/file/qemu/windows');
    });

    it('downloads the file with matching bytes and sha256', async () => {
        const res = await request(app)
            .get('/api/v1/downloads/file/qemu/windows')
            .set('Authorization', `Bearer ${userToken}`);
        assert.equal(res.status, 200);
        assert.equal(res.text, testContent);
        const sha256 = crypto.createHash('sha256').update(res.text).digest('hex');
        const artifact = await Artifact.findOne({ version: '0.0.0-test' });
        assert.equal(sha256, artifact.sha256);
    });

    it('404s on an unpublished platform', async () => {
        const res = await request(app)
            .get('/api/v1/downloads/file/qemu/macos')
            .set('Authorization', `Bearer ${userToken}`);
        assert.equal(res.status, 404);
    });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/controllers/downloads.controller.js'`.

- [ ] **Step 3: Implement the controller**

Create `omni-backend/backend/src/controllers/downloads.controller.js`:

```js
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import Artifact from '../models/artifact.model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// backend/src/controllers -> backend/src -> backend -> omni-backend (root) -> storage/downloads
export const DOWNLOADS_ROOT = path.resolve(__dirname, '../../../storage/downloads');

const CATEGORIES = ['qemu', 'base_image', 'executor'];
const PLATFORMS = ['windows', 'macos', 'linux'];

async function latestArtifacts() {
    const all = await Artifact.find().sort({ createdAt: -1 }).lean();
    const latest = new Map();
    for (const artifact of all) {
        const key = `${artifact.category}:${artifact.platform}:${artifact.arch ?? ''}`;
        if (!latest.has(key)) {
            latest.set(key, artifact);
        }
    }
    return [...latest.values()];
}

export const getManifest = async (req, res, next) => {
    try {
        const artifacts = await latestArtifacts();
        const data = artifacts.map((a) => ({
            category: a.category,
            platform: a.platform,
            arch: a.arch,
            version: a.version,
            sha256: a.sha256,
            sizeBytes: a.sizeBytes,
            url: `/api/v1/downloads/file/${a.category}/${a.platform}${a.arch ? `?arch=${a.arch}` : ''}`,
        }));
        res.status(200).json({ success: true, data });
    } catch (error) {
        next(error);
    }
};

export const downloadFile = async (req, res, next) => {
    try {
        const { category, platform } = req.params;
        const arch = typeof req.query.arch === 'string' ? req.query.arch : null;

        if (!CATEGORIES.includes(category) || !PLATFORMS.includes(platform)) {
            const error = new Error('Unknown category or platform');
            error.statusCode = 404;
            throw error;
        }

        const artifact = await Artifact.findOne({ category, platform, arch }).sort({ createdAt: -1 });
        if (!artifact) {
            const error = new Error('No artifact published for that category/platform/arch');
            error.statusCode = 404;
            throw error;
        }

        const resolved = path.resolve(DOWNLOADS_ROOT, artifact.filename);
        if (!resolved.startsWith(DOWNLOADS_ROOT + path.sep)) {
            const error = new Error('Invalid artifact path');
            error.statusCode = 500;
            throw error;
        }
        if (!fs.existsSync(resolved)) {
            const error = new Error('Artifact is published but its file is missing on disk');
            error.statusCode = 404;
            throw error;
        }

        res.sendFile(resolved);
    } catch (error) {
        next(error);
    }
};
```

- [ ] **Step 4: Implement the routes**

Create `omni-backend/backend/src/routes/downloads.routes.js`:

```js
import { Router } from 'express';

import authorize from '../middlewares/auth.middleware.js';
import { getManifest, downloadFile } from '../controllers/downloads.controller.js';

const downloadsRouter = Router();

// Path: /api/v1/downloads/...

downloadsRouter.get('/manifest', authorize, getManifest);
downloadsRouter.get('/file/:category/:platform', authorize, downloadFile);

export default downloadsRouter;
```

- [ ] **Step 5: Mount the router and create the storage directory**

Edit `omni-backend/server.js` — add the import next to `keysRouter`:

```js
import keysRouter from "./backend/src/routes/keys.routes.js";
import downloadsRouter from "./backend/src/routes/downloads.routes.js";
```

and mount it:

```js
app.use('/api/v1/keys', keysRouter);
app.use('/api/v1/downloads', downloadsRouter);
```

Create the storage directory so it exists before tests run:

```bash
mkdir -p "omni-backend/storage/downloads"
touch "omni-backend/storage/downloads/.gitkeep"
```

Edit `omni-backend/.gitignore` — add at the end:

```
# Download artifacts (large binaries, never commit)
/storage/downloads/*
!/storage/downloads/.gitkeep
```

- [ ] **Step 6: Run the test and verify it passes**

Run: `npm test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server.js .gitignore backend/src/controllers/downloads.controller.js backend/src/routes/downloads.routes.js backend/tests/downloads.test.js storage/downloads/.gitkeep
git commit -m "feat(downloads): add manifest and authenticated file-download endpoints"
```

---

### Task 9: Admin bootstrap script

**Files:**
- Create: `omni-backend/scripts/promote-admin.js`
- Modify: `omni-backend/package.json` (add `promote-admin` script)

**Interfaces:**
- Consumes: `connectToDatabase` (existing), `User` model (Task 1).
- Produces: a one-off CLI (`node scripts/promote-admin.js <email>`), the only way an account becomes `role: 'admin'`.

- [ ] **Step 1: Implement the script**

Create `omni-backend/scripts/promote-admin.js`:

```js
import mongoose from 'mongoose';

import connectToDatabase from '../backend/src/database/mongodb.js';
import User from '../backend/src/models/user.model.js';

const email = process.argv[2];

if (!email) {
    console.error('Usage: node scripts/promote-admin.js <email>');
    process.exit(1);
}

await connectToDatabase();

const user = await User.findOneAndUpdate(
    { email: email.trim().toLowerCase() },
    { role: 'admin' },
    { new: true }
);

if (!user) {
    console.error(`No account found for ${email}`);
    process.exit(1);
}

console.log(`✅ ${user.email} is now an admin`);
await mongoose.connection.close();
```

- [ ] **Step 2: Add the npm script**

Edit `omni-backend/package.json` — add to `"scripts"`:

```json
    "promote-admin": "node scripts/promote-admin.js"
```

- [ ] **Step 3: Verify it manually**

From `omni-backend/`, with `npm run dev` running in another terminal:

```bash
curl -s -X POST http://localhost:5500/api/v1/auth/sign-up \
    -H "Content-Type: application/json" \
    -d '{"email":"promote-test@omni.test","password":"hunter22"}'
```

Copy the `data.token` and `data.user._id` from the response, then:

```bash
npm run promote-admin -- promote-test@omni.test
```

Expected output: `✅ promote-test@omni.test is now an admin`

Confirm it took effect (replace `<TOKEN>` and `<ID>` with the values above):

```bash
curl -s http://localhost:5500/api/v1/users/<ID> -H "Authorization: Bearer <TOKEN>"
```

Expected: the JSON response's `data.role` is `"admin"`.

Clean up the test account (Mongo shell or Compass against the Atlas dev cluster — delete the `promote-test@omni.test` user document; there's no delete-account endpoint wired up yet).

- [ ] **Step 4: Commit**

```bash
git add scripts/promote-admin.js package.json
git commit -m "feat(admin): add one-off admin-promotion script"
```

---

### Task 10: Manual end-to-end smoke test

**Files:**
- Create: `omni-backend/scripts/seed-test-artifact.js`
- Create: `omni-backend/scripts/smoke-test.sh`
- Modify: `omni-backend/package.json` (add `seed-test-artifact` script)

**Interfaces:**
- Consumes: `connectToDatabase`, `Artifact` model (Task 3), `DOWNLOADS_ROOT` (Task 8).
- Produces: a copy-pasteable local verification of the entire feature area (sign-up → admin promotion → key generation → redemption → manifest → authenticated download → Range-request check) run against the real `npm run dev` server — the proof-of-done for this whole plan.

- [ ] **Step 1: Implement the artifact-seeding script**

Create `omni-backend/scripts/seed-test-artifact.js`:

```js
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import mongoose from 'mongoose';

import connectToDatabase from '../backend/src/database/mongodb.js';
import Artifact from '../backend/src/models/artifact.model.js';
import { DOWNLOADS_ROOT } from '../backend/src/controllers/downloads.controller.js';

const [, , sourcePath, category, platform, archArg] = process.argv;

if (!sourcePath || !category || !platform) {
    console.error('Usage: node scripts/seed-test-artifact.js <source-file> <category> <platform> [arch]');
    process.exit(1);
}

const arch = archArg || null;
const filename = `${category}/${platform}${arch ? `/${arch}` : ''}/${path.basename(sourcePath)}`;
const destination = path.join(DOWNLOADS_ROOT, filename);

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(sourcePath, destination);

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
const sizeBytes = fs.statSync(destination).size;

await connectToDatabase();

const artifact = await Artifact.create({
    category, platform, arch,
    version: `manual-${Date.now()}`,
    filename, sha256, sizeBytes,
});

console.log(`✅ seeded artifact ${artifact._id}: ${filename} (${sizeBytes} bytes, sha256=${sha256})`);
await mongoose.connection.close();
```

Add to `omni-backend/package.json` `"scripts"`:

```json
    "seed-test-artifact": "node scripts/seed-test-artifact.js"
```

- [ ] **Step 2: Implement the smoke-test script**

Create `omni-backend/scripts/smoke-test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Manual end-to-end smoke test for accounts + license keys + downloads.
# Prerequisite: `npm run dev` already running in another terminal
# (http://localhost:5500). Run this from the omni-backend root:
#   bash scripts/smoke-test.sh

BASE_URL="${BASE_URL:-http://localhost:5500}"
STAMP=$(date +%s)
ADMIN_EMAIL="smoke-admin-${STAMP}@omni.test"
USER_EMAIL="smoke-user-${STAMP}@omni.test"
PASSWORD="hunter22"

echo "== sign up admin account =="
ADMIN_SIGNUP=$(curl -sf -X POST "$BASE_URL/api/v1/auth/sign-up" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$PASSWORD\"}")
ADMIN_TOKEN=$(echo "$ADMIN_SIGNUP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')
echo "admin token acquired"

echo "== promote to admin =="
node scripts/promote-admin.js "$ADMIN_EMAIL"

echo "== sign up regular user =="
USER_SIGNUP=$(curl -sf -X POST "$BASE_URL/api/v1/auth/sign-up" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$USER_EMAIL\",\"password\":\"$PASSWORD\"}")
USER_TOKEN=$(echo "$USER_SIGNUP" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')
echo "user token acquired"

echo "== generate a 1_month key as admin =="
GENERATE=$(curl -sf -X POST "$BASE_URL/api/v1/keys/generate" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"plan":"1_month","count":1}')
CODE=$(echo "$GENERATE" | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.codes[0]')
echo "generated key: $CODE"

echo "== redeem it as the regular user =="
curl -sf -X POST "$BASE_URL/api/v1/keys/redeem" \
    -H "Authorization: Bearer $USER_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"code\":\"$CODE\"}" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).data, null, 2)'

echo "== seed a synthetic 5MB test artifact =="
TMP_ARTIFACT=$(mktemp)
head -c 5000000 /dev/urandom > "$TMP_ARTIFACT"
node scripts/seed-test-artifact.js "$TMP_ARTIFACT" qemu windows
rm -f "$TMP_ARTIFACT"

echo "== fetch the manifest =="
curl -sf "$BASE_URL/api/v1/downloads/manifest" \
    -H "Authorization: Bearer $USER_TOKEN" | node -pe 'JSON.stringify(JSON.parse(require("fs").readFileSync(0)).data, null, 2)'

echo "== download the seeded qemu/windows artifact and verify sha256 =="
OUT_FILE=$(mktemp)
curl -sf "$BASE_URL/api/v1/downloads/file/qemu/windows" \
    -H "Authorization: Bearer $USER_TOKEN" -o "$OUT_FILE"
EXPECTED=$(curl -sf "$BASE_URL/api/v1/downloads/manifest" -H "Authorization: Bearer $USER_TOKEN" \
    | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.find(a => a.category === "qemu" && a.platform === "windows").sha256')
ACTUAL=$(shasum -a 256 "$OUT_FILE" | cut -d' ' -f1)
if [ "$EXPECTED" = "$ACTUAL" ]; then
    echo "sha256 matches: $ACTUAL"
else
    echo "MISMATCH: expected $EXPECTED, got $ACTUAL"
    exit 1
fi
rm -f "$OUT_FILE"

echo "== range-request resume support =="
curl -sf -r 0-99 "$BASE_URL/api/v1/downloads/file/qemu/windows" \
    -H "Authorization: Bearer $USER_TOKEN" -o /dev/null -w "status=%{http_code} bytes=%{size_download}\n"

echo "ALL SMOKE CHECKS PASSED"
```

- [ ] **Step 3: Run it**

```bash
chmod +x scripts/smoke-test.sh
# in one terminal:
npm run dev
# in another terminal, from omni-backend/:
bash scripts/smoke-test.sh
```

Expected: every `==` section prints its result, ending in `ALL SMOKE CHECKS PASSED`. The Range-request check should print `status=206`.

Clean up afterward: delete the `smoke-admin-*@omni.test` / `smoke-user-*@omni.test` users and the `manual-*` version `Artifact` row (and its file under `storage/downloads/qemu/windows/`) from the Atlas dev cluster.

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-test-artifact.js scripts/smoke-test.sh package.json
git commit -m "test(smoke): add end-to-end manual verification script"
```

---

## Definition of done

- `npm test` passes (Tasks 1–8's automated suite).
- `bash scripts/smoke-test.sh` passes end-to-end against a locally running `npm run dev`.
- No file under `omni-backend/storage/downloads/` other than `.gitkeep` is tracked by git.
- Nothing has been deployed to 72.62.59.232 — that's a separate, explicitly-confirmed step later.
