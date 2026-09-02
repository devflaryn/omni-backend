import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { PLANS, priceOrder, formatUsd, isPurchasablePlan } from '../../shared/plans.js';
import { verifyWebhookSignature } from '../src/services/btcpay.js';
import { computeSubscriptionAfterRevoke } from '../src/services/revokeKey.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------- pricing */

test('priceOrder: single key at list price', () => {
    const o = priceOrder({ planId: 'month', quantity: 1 });
    assert.equal(o.totalUsdCents, 1999);
    assert.equal(o.licensePlan, '30_day');
});

test('priceOrder: discount is applied to the SUBTOTAL, rounded once', () => {
    // 3 x 4999 = 14997; 33% = 4949.01 -> floored to 4949, total 10048.
    // Discounting per-key would round three times and overcharge.
    const o = priceOrder({ planId: 'quarter', quantity: 3, percentOff: 33 });
    assert.equal(o.subtotalUsdCents, 14997);
    assert.equal(o.discountUsdCents, 4949);
    assert.equal(o.totalUsdCents, 10048);
});

test('priceOrder: rounding never favours us over the customer', () => {
    // floor() on the discount can only ever make the discount smaller by <1c,
    // so the customer is never charged more than the exact percentage implies.
    for (let qty = 1; qty <= 20; qty += 1) {
        for (const pct of [1, 7, 33, 50, 99]) {
            const o = priceOrder({ planId: 'month', quantity: qty, percentOff: pct });
            const exact = (o.subtotalUsdCents * pct) / 100;
            assert.ok(o.discountUsdCents <= exact, `discount exceeded exact at ${qty}/${pct}`);
            assert.ok(exact - o.discountUsdCents < 1, `discount lost more than a cent at ${qty}/${pct}`);
            assert.equal(o.totalUsdCents, o.subtotalUsdCents - o.discountUsdCents);
        }
    }
});

test('priceOrder: rejects everything malformed', () => {
    assert.throws(() => priceOrder({ planId: 'free', quantity: 1 }), /Unknown plan/);
    assert.throws(() => priceOrder({ planId: 'nope', quantity: 1 }), /Unknown plan/);
    for (const q of [0, -1, 1.5, 21, '3x', NaN]) {
        assert.throws(() => priceOrder({ planId: 'month', quantity: q }), /Quantity/);
    }
    assert.throws(() => priceOrder({ planId: 'month', quantity: 1, percentOff: 101 }), /percentOff/);
});

test('free tier is not purchasable', () => {
    assert.equal(isPurchasablePlan('free'), false);
    assert.equal(isPurchasablePlan('month'), true);
});

test('formatUsd renders exact cents', () => {
    assert.equal(formatUsd(1999), '19.99');
    assert.equal(formatUsd(10048), '100.48');
    assert.equal(formatUsd(0), '0.00');
});

/* --------------------------------------------- prices match what we advertise */

test('shared/plans.js agrees with the prices shown on the landing page', () => {
    const home = fs.readFileSync(path.join(__dirname, '../../frontend/src/pages/Home.jsx'), 'utf8');
    // Home.jsx keeps its own display strings (marketing copy); this catches the
    // two drifting apart, which would mean advertising one price and charging
    // another.
    const advertised = [...home.matchAll(/id:\s*"([a-z]+)"[\s\S]{0,200}?price:\s*"\$([\d.]+)"/g)]
        .reduce((acc, [, id, price]) => ({ ...acc, [id]: price }), {});

    for (const [id, plan] of Object.entries(PLANS)) {
        assert.equal(
            advertised[id],
            formatUsd(plan.priceUsdCents),
            `Home.jsx advertises ${id} at $${advertised[id]} but plans.js charges $${formatUsd(plan.priceUsdCents)}`,
        );
    }
});

/* -------------------------------------------------------- webhook signature */

const SECRET = 'webhook-secret';
const BODY = JSON.stringify({ type: 'InvoiceProcessing', invoiceId: 'INV1' });
const sign = (body, secret = SECRET) =>
    'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

test('webhook signature: accepts a genuine signature', () => {
    assert.equal(verifyWebhookSignature(BODY, sign(BODY), SECRET), true);
});

test('webhook signature: rejects forgery and tampering', () => {
    assert.equal(verifyWebhookSignature(BODY + ' ', sign(BODY), SECRET), false, 'tampered body');
    assert.equal(verifyWebhookSignature(BODY, sign(BODY, 'wrong'), SECRET), false, 'wrong secret');
    assert.equal(verifyWebhookSignature(BODY, sign(BODY).slice(0, -4), SECRET), false, 'truncated');
    assert.equal(verifyWebhookSignature(BODY, sign(BODY).replace('sha256=', ''), SECRET), false, 'no prefix');
    assert.equal(verifyWebhookSignature(BODY, '', SECRET), false, 'empty');
    assert.equal(verifyWebhookSignature(BODY, undefined, SECRET), false, 'missing header');
    assert.equal(verifyWebhookSignature(BODY, sign(BODY), undefined), false, 'missing secret');
});

/* ------------------------------------------------------------- revocation */

const DAY = 24 * 60 * 60 * 1000;

test('revoke: subtracts exactly the time the key granted', () => {
    const now = Date.now();
    const key = { plan: '30_day', grantedMs: 30 * DAY, subscriptionBefore: { plan: null, expiresAt: null } };
    const after = computeSubscriptionAfterRevoke({ plan: '30_day', expiresAt: new Date(now + 30 * DAY) }, key);
    assert.ok(Math.abs(after.expiresAt.getTime() - now) < 1000);
});

test('revoke: stacked keys survive - only this key\'s time is removed', () => {
    // Bought 30 days, then another 90. Revoking the 30-day key must leave the
    // 90 days the customer separately paid for.
    const now = Date.now();
    const expiresAt = new Date(now + 120 * DAY);
    const key = { plan: '30_day', grantedMs: 30 * DAY, subscriptionBefore: { plan: null, expiresAt: null } };
    const after = computeSubscriptionAfterRevoke({ plan: '90_day', expiresAt }, key);
    assert.ok(Math.abs(after.expiresAt.getTime() - (now + 90 * DAY)) < 1000);
    assert.equal(after.plan, '90_day');
});

test('revoke: lifetime restores the prior subscription', () => {
    const prior = new Date(Date.now() + 10 * DAY);
    const key = { plan: 'lifetime', grantedMs: null, subscriptionBefore: { plan: '30_day', expiresAt: prior } };
    const after = computeSubscriptionAfterRevoke({ plan: 'lifetime', expiresAt: null }, key);
    assert.equal(after.plan, '30_day');
    assert.equal(after.expiresAt, prior);
});

test('revoke: lifetime on a never-activated account clears the plan', () => {
    const key = { plan: 'lifetime', grantedMs: null, subscriptionBefore: { plan: null, expiresAt: null } };
    const after = computeSubscriptionAfterRevoke({ plan: 'lifetime', expiresAt: null }, key);
    assert.equal(after.plan, null);
    assert.equal(after.expiresAt, null);
});

test('revoke: an account with no dated plan is left alone', () => {
    const key = { plan: '30_day', grantedMs: 30 * DAY, subscriptionBefore: { plan: null, expiresAt: null } };
    const current = { plan: null, expiresAt: null };
    assert.deepEqual(computeSubscriptionAfterRevoke(current, key), current);
});
