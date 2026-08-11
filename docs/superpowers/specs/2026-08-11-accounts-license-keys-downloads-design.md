# Accounts, License Keys, and Download Distribution

Date: 2026-08-11
Status: Approved for planning

## Context

Omni Executor is moving toward a real production distribution model: a
single client app (per OS) that self-bootstraps its dependencies (the
`omnidroid` engine's QEMU + Android base images) on first launch instead of
shipping them inline. That bootstrap needs somewhere to download from.

`omnidroid` already anticipates this — `ensure_qemu()` reads an unset
`qemu.download_url` from config and has a dead-end error message pointing at
"host it on your own server/CDN" (see omnidroid `HANDOFF.md`, "QEMU
delivery" and "Server base updates"). Nothing implements the delivery side
yet, and there's no concept of a licensed Omni account at all today —
`omni-backend` (the Express/Mongo/JWT backend, package name literally
`omni-executor` — "single VPS serving frontend and backend") only has plain
email/password sign-up/sign-in and a stub user CRUD router.

This spec covers building that missing piece: accounts with a redeemable
license-key system, and an authenticated download manifest/file API. A
real Hostinger VPS (72.62.59.232) exists for eventual production deployment,
but deployment itself is explicitly out of scope here — everything in this
spec is built and tested against the existing local dev setup (the Atlas
dev cluster already wired into `.env.development.local`; no local Mongo or
Redis needed). Deployment happens later, and only after the user confirms.

## Goals

1. A logged-in Omni account is required to download engine dependencies
   (QEMU, base images) and executor installer updates.
2. Any free (email/password) account can download — no key required.
3. A separate license-key system exists so the user (acting as admin) can
   generate time-boxed or lifetime keys and users can redeem one onto their
   account. Selling/distributing keys happens outside this system entirely
   — no purchase flow, no payment integration, no admin UI panel.
4. Redeeming a key records subscription state (`plan` + `expiresAt`) on the
   account. **Nothing enforces it yet** — no engine/executor gating. This is
   deliberately just bookkeeping for a later sub-project.
5. A versioned download catalog (the "manifest") that `omnidroid`'s
   bootstrap code (a later sub-project) can query to find the current QEMU
   build, base images, and executor installer per OS/arch, with integrity
   metadata (sha256, size) so a client can verify what it downloaded.

## Non-goals

- Deploying anything to the Hostinger VPS.
- Enforcing subscription/key state anywhere (engine, executor, routes).
- A purchase/checkout flow or admin dashboard UI.
- Object storage / CDN — files are served from local disk on the backend
  host. The manifest is the only contract clients see, so storage can move
  to S3/R2/etc. later without a client-side change.
- Changing the existing sign-up/sign-in/sign-out behavior.

## Data model changes

### `User` (extend existing `backend/src/models/user.model.js`)

```js
role: { type: String, enum: ['user', 'admin'], default: 'user' },
subscription: {
  plan: { type: String, enum: ['1_month', '3_month', 'lifetime', null], default: null },
  expiresAt: { type: Date, default: null }, // null + plan='lifetime' => never expires
},
```

`subscription.plan === null` means no active subscription regardless of
`expiresAt`. A `lifetime` plan always has `expiresAt: null`.

### `LicenseKey` (new model)

```js
code: { type: String, required: true, unique: true },        // e.g. OMNI-XXXX-XXXX-XXXX
plan: { type: String, enum: ['1_month', '3_month', 'lifetime'], required: true },
status: { type: String, enum: ['unused', 'redeemed', 'revoked'], default: 'unused' },
createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
redeemedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
redeemedAt: { type: Date, default: null },
```
(`timestamps: true` for `createdAt`.)

Codes are generated server-side (cryptographically random, formatted for
readability, collision-checked against the unique index).

### `Artifact` (new model — the download catalog)

```js
category: { type: String, enum: ['qemu', 'base_image', 'executor'], required: true },
platform: { type: String, enum: ['windows', 'macos', 'linux'], required: true },
arch: { type: String, enum: ['x86', 'arm', null], default: null }, // base_image only
version: { type: String, required: true },
filename: { type: String, required: true },   // relative path under storage/downloads/
sha256: { type: String, required: true },
sizeBytes: { type: Number, required: true },
```
(`timestamps: true`.) The manifest endpoint returns, per unique
`(category, platform, arch)`, the row with the newest `createdAt` — "latest
wins," no separate "current release" pointer needed. Publishing a new build
is just inserting a new `Artifact` row (a small seed/admin script, not part
of this spec's route surface — out of scope like the rest of admin
tooling).

## API surface

All new routes sit behind the **existing** `authorize` middleware
(`backend/src/middlewares/auth.middleware.js` — Bearer JWT, already used by
`GET /api/v1/users/:id`). No new auth mechanism.

### Admin
- `adminOnly` middleware (new, small): runs after `authorize`, checks
  `req.user.role === 'admin'`, else `403`.
- `POST /api/v1/keys/generate` *(admin only)* — body `{ plan, count }`
  (`count` optional, default `1`, capped at e.g. 100 per call). Returns the
  generated codes. Called with curl/Postman — no UI.

### Any logged-in user
- `POST /api/v1/keys/redeem` — body `{ code }`.
  - `404` unknown code, `409` if `status !== 'unused'`.
  - Applies plan math (below), sets `status: 'redeemed'`, `redeemedBy`,
    `redeemedAt`.
  - Returns the updated `subscription`.
- `GET /api/v1/downloads/manifest` — returns, per category/platform/arch,
  `{ version, sha256, sizeBytes, url }` where `url` is
  `/api/v1/downloads/file/:category/:platform` (or an `?arch=` query for
  `base_image`, since `arch` isn't in the path). No subscription check —
  any authenticated user gets the full manifest.
- `GET /api/v1/downloads/file/:category/:platform` *(+ `?arch=` for
  `base_image`)* — resolves the same "latest" `Artifact` row the manifest
  used, then `res.sendFile(absolutePath)`. Express's `sendFile` (via the
  `send` package) handles `Range` headers automatically, so multi-GB base
  images support resumable/partial downloads for free. `404` if no artifact
  row matches, or if the file is missing on disk (logged as a server-side
  inconsistency — a published row with no backing file is an operator
  mistake, not a client error to hide).

### Key redemption plan math (stacking)

```
now = current time
base = (user.subscription.expiresAt && user.subscription.expiresAt > now)
         ? user.subscription.expiresAt
         : now
if key.plan === 'lifetime':
    user.subscription = { plan: 'lifetime', expiresAt: null }
else:
    months = key.plan === '1_month' ? 1 : 3
    user.subscription = { plan: key.plan, expiresAt: addMonths(base, months) }
    # Note: a 1_month key redeemed while already on 'lifetime' would
    # regress the plan — reject this case explicitly (409, "already on a
    # lifetime plan") rather than silently downgrading.
```

## Storage

New gitignored directory `omni-backend/storage/downloads/<category>/
<platform>/[<arch>/]<filename>`. Plain filesystem for now. The `Artifact`
row's `filename` is a path relative to `storage/downloads/`, resolved and
validated (no `..` traversal) before `sendFile`.

## Error handling

Reuses the existing `errorMiddleware` pattern (`throw` an `Error` with
`.statusCode`, caught by Express's error handler already wired in
`server.js`). No new error-handling infrastructure.

## Testing

- Unit tests (Vitest or Node's built-in `node:test`, whichever matches
  existing repo conventions — repo currently has none, so this introduces
  the first test setup) for the redemption plan-math function in isolation
  (unused/redeemed/revoked codes, stacking math, the lifetime-downgrade
  rejection).
- Integration/manual pass against a locally running `npm run dev`
  (`http://localhost:5500`, using the existing Atlas dev cluster) via curl:
  sign-up → promote to admin via the one-off script → generate a key →
  sign-up a second test account → redeem → `GET manifest` → download a
  small real test artifact (e.g. the portable Windows QEMU zip already
  sitting in the `omnidroid/qemu/` dir on this machine) and verify the
  sha256 matches.

## Admin bootstrap

`scripts/promote-admin.js <email>` — a one-off Node script (uses the same
Mongo connection as the server) that sets `role: 'admin'` on the matching
user. Run manually, once, locally. No standing env-var-driven auto-promote
mechanism.

## Open items carried to later sub-projects (not this spec)

- `omnidroid` engine changes: `ensure_base_images()`, macOS/Linux
  `ensure_qemu()` download path, wiring `Authorization: Bearer <token>`
  into its download requests, and where the executor stores/passes the
  Omni-account JWT to the engine subprocess.
- omni-executor: an "Omni account" login screen (distinct from the
  per-account Roblox login already in the app), executor packaging
  (PyInstaller build for the executor itself — currently only runs via
  `python main.py`), and platform installers (Windows/macOS/Linux).
- Actual deployment to the Hostinger VPS — explicitly gated on user
  confirmation.
- License enforcement (subscription/key state currently tracked but not
  checked anywhere).
