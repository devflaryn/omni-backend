import Order from '../models/order.model.js';
import PromoCode from '../models/promoCode.model.js';
import LicenseKey from '../models/licenseKey.model.js';
import { generateKeyCode } from '../utils/generateKeyCode.js';
import { PLAN_LABELS } from '../utils/applyLicenseKey.js';
import { revokeKey } from '../services/revokeKey.js';
import { createBtcPayClient, verifyWebhookSignature } from '../services/btcpay.js';
import { createEmailClient } from '../services/email.js';
import { PLANS, priceOrder, formatUsd, isPurchasablePlan, MAX_QUANTITY } from '../../../shared/plans.js';

/*
 * Guest checkout. No auth anywhere in this file by design: the whole point is
 * that buying requires no account. The email address is the only identity, and
 * the mailbox is what authenticates delivery.
 *
 * Money is NEVER read from the request. The client sends planId/quantity/promo;
 * every figure is recomputed here from shared/plans.js.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const bad = (message, statusCode = 400) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
};

/** a•••@example.com — enough for the buyer to recognise, useless to anyone else. */
function maskEmail(email) {
    const [user, domain] = String(email).split('@');
    if (!domain) return '•••';
    return `${user.slice(0, 1)}${'•'.repeat(Math.max(user.length - 1, 1))}@${domain}`;
}

/**
 * Resolve a promo code to a discount, or throw.
 *
 * Shared by /quote and / so the two can never disagree about whether a code is
 * valid — a code that quotes at 20% off must not silently charge full price.
 */
async function resolvePromo(rawCode) {
    if (!rawCode) return { promoCode: null, percentOff: 0, promo: null };

    const code = String(rawCode).trim().toUpperCase();
    if (!code) return { promoCode: null, percentOff: 0, promo: null };

    const promo = await PromoCode.findOne({ code });
    if (!promo || !promo.isUsable()) throw bad('That promo code is not valid', 422);

    return { promoCode: promo.code, percentOff: promo.percentOff, promo };
}

function parseAndPrice({ planId, quantity, percentOff }) {
    if (!isPurchasablePlan(planId)) throw bad('Unknown plan');
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QUANTITY) {
        throw bad(`Quantity must be between 1 and ${MAX_QUANTITY}`);
    }
    return priceOrder({ planId, quantity: qty, percentOff });
}

/** GET /api/v1/checkout/plans — unit prices, so the modal renders authoritative figures. */
export const listPlans = (req, res) => {
    res.status(200).json({
        success: true,
        data: {
            maxQuantity: MAX_QUANTITY,
            plans: Object.entries(PLANS).map(([id, p]) => ({
                id,
                priceUsdCents: p.priceUsdCents,
                priceUsd: formatUsd(p.priceUsdCents),
                licensePlan: p.licensePlan,
                label: PLAN_LABELS[p.licensePlan] ?? id,
            })),
        },
    });
};

/** POST /api/v1/checkout/quote — live total as the buyer changes quantity/promo. */
export const quote = async (req, res, next) => {
    try {
        const { planId, quantity = 1, promoCode = null } = req.body ?? {};
        const { promoCode: code, percentOff } = await resolvePromo(promoCode);
        const priced = parseAndPrice({ planId, quantity, percentOff });

        res.status(200).json({
            success: true,
            data: {
                ...priced,
                promoCode: code,
                unitPriceUsd: formatUsd(priced.unitPriceUsdCents),
                subtotalUsd: formatUsd(priced.subtotalUsdCents),
                discountUsd: formatUsd(priced.discountUsdCents),
                totalUsd: formatUsd(priced.totalUsdCents),
            },
        });
    } catch (error) { next(error); }
};

/** POST /api/v1/checkout — create the order and its BTCPay invoice. */
export const createCheckout = async (req, res, next) => {
    try {
        const { planId, quantity = 1, email, promoCode = null } = req.body ?? {};

        if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
            throw bad('A valid email address is required');
        }
        const buyerEmail = email.trim().toLowerCase();

        const { promoCode: code, percentOff } = await resolvePromo(promoCode);
        const priced = parseAndPrice({ planId, quantity, percentOff });

        // The order exists BEFORE the invoice: if invoice creation fails we want
        // a record of the attempt, not a silent 500 with nothing to look at.
        const order = await Order.create({
            email: buyerEmail,
            planId: priced.planId,
            quantity: priced.quantity,
            unitPriceUsdCents: priced.unitPriceUsdCents,
            subtotalUsdCents: priced.subtotalUsdCents,
            promoCode: code,
            percentOff: priced.percentOff,
            discountUsdCents: priced.discountUsdCents,
            totalUsdCents: priced.totalUsdCents,
        });

        const publicBase = process.env.OMNI_PUBLIC_BASE || 'https://omniexec.net';
        let invoice;
        try {
            invoice = await createBtcPayClient().createInvoice({
                orderId: order._id.toString(),
                amountUsd: formatUsd(priced.totalUsdCents),
                buyerEmail,
                redirectUrl: `${publicBase}/checkout/${order._id}`,
                description: `${priced.quantity} x ${PLAN_LABELS[priced.licensePlan] ?? priced.planId} key`,
            });
        } catch (error) {
            order.status = 'failed';
            order.lastError = String(error.message).slice(0, 500);
            await order.save();
            // The most likely cause during setup is the node still syncing.
            throw bad('Payment could not be started right now. Please try again shortly.', 503);
        }

        order.invoiceId = invoice.id;
        await order.save();

        res.status(201).json({
            success: true,
            data: {
                orderId: order._id,
                payUrl: invoice.checkoutLink,
                totalUsd: formatUsd(priced.totalUsdCents),
            },
        });
    } catch (error) { next(error); }
};

/**
 * GET /api/v1/checkout/:orderId/status
 *
 * Deliberately does NOT return the keys. An orderId travels in a URL and gets
 * pasted into chat windows; keys go to the mailbox that paid for them and
 * nowhere else.
 */
export const orderStatus = async (req, res, next) => {
    try {
        const order = await Order.findById(req.params.orderId).select(
            'status email quantity planId totalUsdCents emailSentAt createdAt'
        );
        if (!order) throw bad('Order not found', 404);

        res.status(200).json({
            success: true,
            data: {
                status: order.status,
                planId: order.planId,
                quantity: order.quantity,
                totalUsd: formatUsd(order.totalUsdCents),
                sentTo: maskEmail(order.email),
                emailSent: !!order.emailSentAt,
                createdAt: order.createdAt,
            },
        });
    } catch (error) { next(error); }
};

/**
 * Mint `quantity` keys for a paid order and email them.
 *
 * Guarded by the order's own status: BTCPay redelivers webhooks, and minting
 * twice would hand out double the keys that were paid for.
 */
async function fulfilOrder(order) {
    if (order.status !== 'pending') return order;

    const { licensePlan } = PLANS[order.planId];
    const codes = [];

    for (let i = 0; i < order.quantity; i += 1) {
        // Retry on the unique-index collision rather than trusting randomness.
        let created = null;
        for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
            const code = generateKeyCode();
            try {
                created = await LicenseKey.create({
                    code,
                    plan: licensePlan,
                    order: order._id,
                    issuedToEmail: order.email,
                });
            } catch (error) {
                if (error?.code !== 11000) throw error;
            }
        }
        if (!created) throw new Error('Could not mint a unique key code');
        codes.push(created.code);
        order.keys.push(created._id);
    }

    order.status = 'paid';
    await order.save();

    if (order.promoCode) {
        // Counted here, on payment — never at quote time, or window-shoppers
        // would burn a limited launch code without buying anything.
        await PromoCode.updateOne({ code: order.promoCode }, { $inc: { redemptions: 1 } });
    }

    try {
        await createEmailClient().sendKeys({
            to: order.email,
            keys: codes,
            planLabel: PLAN_LABELS[licensePlan] ?? order.planId,
            orderId: order._id.toString(),
        });
        order.emailSentAt = new Date();
        order.lastError = null;
    } catch (error) {
        // The customer has paid. Record the failure loudly and leave the keys
        // minted so delivery can be retried; never swallow this.
        order.lastError = `email failed: ${String(error.message).slice(0, 400)}`;
        console.error(`[checkout] key email FAILED for order ${order._id}:`, error);
    }
    await order.save();

    return order;
}

/** Revoke every key on an order whose payment never confirmed. */
async function unwindOrder(order, reason) {
    const keys = await LicenseKey.find({ _id: { $in: order.keys } }).select('code');
    for (const key of keys) {
        try {
            await revokeKey({ code: key.code, reason });
        } catch (error) {
            console.error(`[checkout] revoke failed for ${key.code}:`, error);
        }
    }
    order.status = 'failed';
    await order.save();
    return order;
}

/**
 * POST /api/v1/checkout/webhook
 *
 * Mounted with express.raw() so `req.body` is the exact bytes BTCPay signed —
 * re-serialising parsed JSON changes whitespace and the HMAC would never match.
 */
export const webhook = async (req, res, next) => {
    try {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
        const signature = req.get('BTCPay-Sig');
        const secret = process.env.BTCPAY_WEBHOOK_SECRET;

        if (!verifyWebhookSignature(raw, signature, secret)) {
            // 400, not 401: this is a malformed/forged delivery, and BTCPay's
            // retry logic should not treat it as a transient auth problem.
            throw bad('Invalid webhook signature', 400);
        }

        const event = JSON.parse(raw.toString('utf8'));
        const order = await Order.findOne({ invoiceId: event.invoiceId });

        // Unknown invoice: ack anyway. Returning an error makes BTCPay retry a
        // delivery that can never succeed.
        if (!order) return res.status(200).json({ ok: true, ignored: true });

        switch (event.type) {
            case 'InvoiceProcessing':
                await fulfilOrder(order);
                break;

            case 'InvoiceSettled':
                if (order.status === 'pending') await fulfilOrder(order);
                if (order.status === 'paid') {
                    order.status = 'settled';
                    await order.save();
                }
                break;

            case 'InvoiceExpired':
                if (order.status === 'pending') {
                    order.status = 'expired';
                    await order.save();
                } else if (order.status === 'paid') {
                    await unwindOrder(order, `Order ${order._id} expired unpaid`);
                }
                break;

            case 'InvoiceInvalid':
                if (order.status === 'paid') {
                    await unwindOrder(order, `Order ${order._id} payment never confirmed`);
                } else if (order.status === 'pending') {
                    order.status = 'failed';
                    await order.save();
                }
                break;

            default:
                break;
        }

        res.status(200).json({ ok: true });
    } catch (error) { next(error); }
};
