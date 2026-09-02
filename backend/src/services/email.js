/*
 * Transactional email via Resend.
 *
 * Plain fetch against the REST API rather than the SDK: this sends exactly one
 * kind of message, and the API key we hold is send-only (it is refused on
 * /domains), so there is nothing else to call.
 *
 * Delivery here is the last mile of a PAID transaction. If this fails the
 * customer has money gone and nothing to show for it, so every failure must be
 * loud and recorded on the order — never swallowed.
 */

export class EmailError extends Error {
    constructor(message, statusCode, detail) {
        super(message);
        this.name = 'EmailError';
        this.statusCode = statusCode;
        this.detail = detail;
    }
}

const escapeHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function createEmailClient({
    apiKey = process.env.RESEND_API_KEY,
    from = process.env.RESEND_FROM || 'keys@omniexec.net',
    fetchImpl = fetch,
} = {}) {
    if (!apiKey) throw new Error('Email is not configured (need RESEND_API_KEY)');

    async function send({ to, subject, html, text }) {
        const res = await fetchImpl('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ from, to: [to], subject, html, text }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            throw new EmailError(
                body?.message || `Resend rejected the message (${res.status})`,
                res.status,
                body,
            );
        }
        return body;
    }

    return {
        send,

        /**
         * The one email this product sends: here are the keys you paid for.
         *
         * Keys are in the BODY, not behind a link. A link would need a session
         * or a guessable token, and the buyer has no account — the mailbox IS
         * the authentication.
         */
        sendKeys({ to, keys, planLabel, orderId }) {
            const plural = keys.length === 1 ? 'key' : 'keys';
            const list = keys.join('\n');

            const text = [
                `Thanks for your purchase.`,
                ``,
                `Your ${planLabel} ${plural}:`,
                ``,
                list,
                ``,
                `To use ${keys.length === 1 ? 'it' : 'them'}: create a free account at`,
                `https://omniexec.net/sign-up (no key needed to sign up), then redeem`,
                `from your dashboard. A key adds premium time to an existing account.`,
                ``,
                `Order ${orderId}`,
            ].join('\n');

            const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.6;color:#111">
  <h2 style="margin:0 0 16px">Thanks for your purchase</h2>
  <p style="margin:0 0 12px">Your <strong>${escapeHtml(planLabel)}</strong> ${plural}:</p>
  <pre style="background:#f4f4f5;border:1px solid #e4e4e7;border-radius:8px;padding:14px 16px;font-size:15px;letter-spacing:.5px;white-space:pre-wrap;word-break:break-all">${escapeHtml(list)}</pre>
  <p style="margin:16px 0 12px">To use ${keys.length === 1 ? 'it' : 'them'}, create a free account at
    <a href="https://omniexec.net/sign-up">omniexec.net/sign-up</a> — no key is needed to sign up —
    then redeem from your dashboard. A key adds premium time to an account that already exists.</p>
  <p style="margin:24px 0 0;color:#71717a;font-size:13px">Order ${escapeHtml(orderId)}</p>
</div>`;

            return send({
                to,
                subject: `Your Omni Executor ${planLabel} ${plural}`,
                html,
                text,
            });
        },
    };
}
