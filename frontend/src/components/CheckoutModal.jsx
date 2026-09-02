import { useCallback, useEffect, useRef, useState } from "react";

import { apiCall } from "../lib/api";
import { MAX_QUANTITY } from "../../../shared/plans.js";
import "./checkout-modal.css";

/*
 * Guest checkout. No account, no session — an email address and a payment.
 *
 * The total shown here is NEVER computed in the browser: every figure comes
 * from POST /checkout/quote, which prices the order from the same shared module
 * the server charges from. A client-side total would be a number the user could
 * edit, and it would drift from the invoice the moment a promo rule changed.
 */

const DEBOUNCE_MS = 350;

export default function CheckoutModal({ plan, onClose }) {
    const [quantity, setQuantity] = useState(1);
    const [email, setEmail] = useState("");
    const [promo, setPromo] = useState("");
    const [quote, setQuote] = useState(null);
    const [promoError, setPromoError] = useState(null);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    const dialogRef = useRef(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;

    // Esc closes, and focus moves into the dialog: this is a modal, so the page
    // behind it must not be quietly operable by keyboard.
    useEffect(() => {
        const onKey = (e) => { if (e.key === "Escape") closeRef.current(); };
        document.addEventListener("keydown", onKey);
        document.body.style.overflow = "hidden";
        dialogRef.current?.focus();
        return () => {
            document.removeEventListener("keydown", onKey);
            document.body.style.overflow = "";
        };
    }, []);

    const refreshQuote = useCallback(async (qty, code) => {
        try {
            const res = await apiCall("/checkout/quote", {
                method: "POST",
                body: { planId: plan.id, quantity: qty, promoCode: code || null },
            });
            setQuote(res.data);
            setPromoError(null);
        } catch (err) {
            // A rejected promo must not blank the price — re-quote without it so
            // the buyer still sees what they would pay.
            if (err.status === 422 && code) {
                setPromoError(err.message);
                try {
                    const res = await apiCall("/checkout/quote", {
                        method: "POST",
                        body: { planId: plan.id, quantity: qty, promoCode: null },
                    });
                    setQuote(res.data);
                } catch { /* leave the previous quote up */ }
            } else {
                setError(err.message);
            }
        }
    }, [plan.id]);

    useEffect(() => {
        const t = setTimeout(() => refreshQuote(quantity, promo.trim()), DEBOUNCE_MS);
        return () => clearTimeout(t);
    }, [quantity, promo, refreshQuote]);

    const submit = async (e) => {
        e.preventDefault();
        setError(null);
        setBusy(true);
        try {
            const res = await apiCall("/checkout", {
                method: "POST",
                body: {
                    planId: plan.id,
                    quantity,
                    email: email.trim(),
                    promoCode: promo.trim() || null,
                },
            });
            // Hand off to BTCPay's hosted checkout. Same tab: coming back here
            // mid-payment with no order state would be worse than leaving.
            window.location.href = res.data.payUrl;
        } catch (err) {
            setError(err.message);
            setBusy(false);
        }
    };

    const step = (delta) => setQuantity((q) => Math.min(MAX_QUANTITY, Math.max(1, q + delta)));
    const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

    return (
        <div className="ckt__backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div
                className="ckt"
                role="dialog"
                aria-modal="true"
                aria-label={`Buy ${plan.name}`}
                tabIndex={-1}
                ref={dialogRef}
            >
                <button type="button" className="ckt__close" onClick={onClose} aria-label="Close">×</button>

                <span className="eyebrow">{plan.name}</span>

                <div className="ckt__price">
                    {quote ? `$${quote.unitPriceUsd}` : plan.price}
                    <span className="ckt__cadence">/key</span>
                </div>

                <form onSubmit={submit}>
                    <label className="field ckt__qty">
                        <span>Quantity of keys</span>
                        <div className="ckt__stepper">
                            <button type="button" onClick={() => step(-1)} disabled={quantity <= 1} aria-label="Fewer">−</button>
                            <input
                                type="text"
                                inputMode="numeric"
                                value={quantity}
                                onChange={(e) => {
                                    const n = parseInt(e.target.value.replace(/\D/g, ""), 10);
                                    setQuantity(Number.isNaN(n) ? 1 : Math.min(MAX_QUANTITY, Math.max(1, n)));
                                }}
                                aria-label="Quantity"
                            />
                            <button type="button" onClick={() => step(1)} disabled={quantity >= MAX_QUANTITY} aria-label="More">+</button>
                        </div>
                    </label>

                    <label className="field">
                        <span>Email (your keys are sent here)</span>
                        <input
                            type="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="you@email.com"
                            autoComplete="email"
                            required
                        />
                    </label>

                    <label className="field">
                        <span>Promo code (optional)</span>
                        <input
                            type="text"
                            value={promo}
                            onChange={(e) => setPromo(e.target.value.toUpperCase())}
                            placeholder="OMNI20"
                            autoCapitalize="characters"
                            spellCheck="false"
                        />
                        {promoError && <small className="ckt__promo-bad">{promoError}</small>}
                        {!promoError && quote?.promoCode && (
                            <small className="ckt__promo-ok">
                                {quote.promoCode} applied — {quote.percentOff}% off
                            </small>
                        )}
                    </label>

                    <div className="ckt__total">
                        <span>Total</span>
                        <strong>
                            {quote ? `$${quote.totalUsd}` : "—"}
                            {quote && quote.discountUsdCents > 0 && (
                                <s className="ckt__was">${quote.subtotalUsd}</s>
                            )}
                        </strong>
                    </div>

                    {error && <p className="auth__error ckt__error">{error}</p>}

                    <button
                        type="submit"
                        className="btn btn--primary ckt__pay"
                        disabled={busy || !emailValid || !quote}
                    >
                        {busy ? "Starting payment…" : "Pay with crypto"}
                    </button>
                </form>

                <p className="ckt__foot">
                    Paid in Bitcoin. Your keys are emailed as soon as the payment is seen —
                    no account needed to buy, and none needed to receive them.
                </p>
            </div>
        </div>
    );
}
