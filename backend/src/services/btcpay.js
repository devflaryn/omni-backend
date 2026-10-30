import crypto from 'crypto';

/*
 * BTCPay Greenfield client — invoice creation and webhook verification.
 *
 * BTCPay is self-hosted on this same box and reached over loopback, so there is
 * no third party in the payment path and no SDK: Node 20 has global fetch and
 * the API is three endpoints. Adding a dependency here would buy nothing.
 *
 * Config is injected rather than read from module scope so tests can drive a
 * fake server without touching the environment.
 */

export class BtcPayError extends Error {
    constructor(message, statusCode, detail) {
        super(message);
        this.name = 'BtcPayError';
        this.statusCode = statusCode;
        this.detail = detail;
    }
}

export function createBtcPayClient({
    baseUrl = process.env.BTCPAY_URL,
    storeId = process.env.BTCPAY_STORE_ID,
    apiKey = process.env.BTCPAY_API_KEY,
    fetchImpl = fetch,
} = {}) {
    if (!baseUrl || !storeId || !apiKey) {
        throw new Error('BTCPay is not configured (need BTCPAY_URL, BTCPAY_STORE_ID, BTCPAY_API_KEY)');
    }
    const root = `${baseUrl.replace(/\/+$/, '')}/api/v1`;

    async function call(path, { method = 'GET', body } = {}) {
        const res = await fetchImpl(`${root}${path}`, {
            method,
            headers: {
                // Greenfield uses "token <key>", NOT "Bearer".
                Authorization: `token ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* keep raw */ }
        if (!res.ok) {
            throw new BtcPayError(
                json?.message || `BTCPay ${method} ${path} failed (${res.status})`,
                res.status,
                json ?? text,
            );
        }
        return json;
    }

    return {
        /**
         * Create an invoice for an order.
         *
         * `orderId` goes in metadata AND is what the webhook hands back, so it
         * is the only link between a BTCPay invoice and our Order row. Without
         * it a webhook is unattributable.
         *
         * Amount is a decimal STRING: BTCPay parses it exactly, whereas a JS
         * number would round-trip 19.99 through a float first.
         */
        createInvoice({ orderId, amountUsd, buyerEmail, redirectUrl, description }) {
            return call(`/stores/${storeId}/invoices`, {
                method: 'POST',
                body: {
                    amount: String(amountUsd),
                    currency: 'USD',
                    metadata: {
                        orderId: String(orderId),
                        buyerEmail,
                        itemDesc: description,
                    },
                    checkout: {
                        redirectURL: redirectUrl,
                        // Send the buyer back to our status page as soon as the
                        // payment is SEEN, matching when we actually mint keys.
                        redirectAutomatically: true,
                    },
                },
            });
        },

        getInvoice(invoiceId) {
            return call(`/stores/${storeId}/invoices/${invoiceId}`);
        },

        listWebhooks() {
            return call(`/stores/${storeId}/webhooks`);
        },

        createWebhook({ url, secret }) {
            return call(`/stores/${storeId}/webhooks`, {
                method: 'POST',
                body: {
                    url,
                    secret,
                    enabled: true,
                    automaticRedelivery: true,
                    authorizedEvents: {
                        everything: false,
                        specificEvents: [
                            'InvoiceProcessing',
                            'InvoiceSettled',
                            'InvoiceExpired',
                            'InvoiceInvalid',
                        ],
                    },
                },
            });
        },
    };
}

/**
 * The checkout link a BUYER can open.
 *
 * BTCPay builds `checkoutLink` from the host it was called on, and this server
 * calls it over loopback (BTCPAY_URL = http://127.0.0.1:23000) -- so every link
 * it handed back was `http://127.0.0.1:23000/i/<id>`, which in a buyer's
 * browser is their OWN machine. The order was created, the invoice existed,
 * and the payment page with the address never opened. The public origin is the
 * nginx-fronted host (`paywall.omniexec.net`); only the origin changes, the
 * path and query are BTCPay's.
 */
export function publicCheckoutLink(link, publicBase = process.env.BTCPAY_PUBLIC_URL || 'https://paywall.omniexec.net') {
    if (!link) return link;
    try {
        const url = new URL(link);
        const pub = new URL(publicBase);
        url.protocol = pub.protocol;
        url.hostname = pub.hostname;
        // Explicitly, even when empty: assigning a host with no port KEEPS
        // the old one, which produced https://paywall.omniexec.net:23000/...
        url.port = pub.port;
        return url.toString();
    } catch {
        return link;
    }
}

/**
 * Verify a webhook actually came from our BTCPay.
 *
 * BTCPay signs the RAW request body with HMAC-SHA256 and sends it as
 * `BTCPay-Sig: sha256=<hex>`. This must run against the raw bytes BEFORE any
 * JSON parsing — re-serialising the parsed object changes whitespace and the
 * signature will never match.
 *
 * timingSafeEqual, not ===, so the comparison cannot be timed to leak the
 * expected digest byte by byte.
 */
export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
    if (!signatureHeader || !secret) return false;

    const expected = 'sha256=' + crypto
        .createHmac('sha256', secret)
        .update(rawBody)
        .digest('hex');

    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    // timingSafeEqual throws on length mismatch, which is itself an answer.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}
