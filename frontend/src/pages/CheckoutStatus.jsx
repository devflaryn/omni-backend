import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";

import Nav from "../components/Nav";
import { apiCall } from "../lib/api";

/*
 * Where BTCPay sends the buyer back to. There is no session here — the order id
 * in the URL is all we have, which is exactly why this page never shows the
 * keys themselves. A link that reveals keys is a link that leaks them; the keys
 * go to the mailbox that paid for them.
 */

const POLL_MS = 4000;

const VIEW = {
    pending: {
        title: "Waiting for your payment",
        tone: "is-wait",
        body: "We haven't seen the payment on-chain yet. This page updates itself — you can leave it open.",
    },
    paid: {
        title: "Payment received",
        tone: "is-good",
        body: "Your keys have been generated and emailed.",
    },
    settled: {
        title: "Payment confirmed",
        tone: "is-good",
        body: "Your payment is confirmed on-chain and your keys have been emailed.",
    },
    expired: {
        title: "This order expired",
        tone: "is-bad",
        body: "No payment arrived before the invoice expired. Nothing was charged — start a new order whenever you like.",
    },
    failed: {
        title: "Payment did not complete",
        tone: "is-bad",
        body: "The payment was never confirmed, so any keys issued for this order have been revoked. Nothing further is owed.",
    },
};

export default function CheckoutStatus() {
    const { orderId } = useParams();
    const [order, setOrder] = useState(null);
    const [error, setError] = useState(null);

    useEffect(() => {
        let alive = true;
        let timer = null;

        const tick = async () => {
            try {
                const res = await apiCall(`/checkout/${orderId}/status`);
                if (!alive) return;
                setOrder(res.data);
                // Stop polling once the outcome can no longer change.
                if (res.data.status === "pending") timer = setTimeout(tick, POLL_MS);
            } catch (err) {
                if (!alive) return;
                setError(err.message);
            }
        };

        tick();
        return () => { alive = false; if (timer) clearTimeout(timer); };
    }, [orderId]);

    const view = order ? (VIEW[order.status] ?? VIEW.pending) : null;

    return (
        <>
            <Nav />
            <main className="auth">
                <div className="auth__card">
                    <span className="eyebrow">Order</span>

                    {error && <p className="auth__error">{error}</p>}

                    {!order && !error && <h1>Checking your order…</h1>}

                    {order && (
                        <>
                            <h1>{view.title}</h1>
                            <p className="auth__sub">{view.body}</p>

                            <div className="field">
                                <span>Order</span>
                                <p className="mono" style={{ margin: 0, wordBreak: "break-all" }}>{orderId}</p>
                            </div>

                            <div className="field">
                                <span>{order.emailSent ? "Keys sent to" : "Will be sent to"}</span>
                                <p style={{ margin: 0 }}>{order.sentTo}</p>
                            </div>

                            <div className="field">
                                <span>Purchased</span>
                                <p style={{ margin: 0 }}>
                                    {order.quantity} x {order.planId} — ${order.totalUsd}
                                </p>
                            </div>

                            {/* Delivery is the one failure the buyer can act on: they have
                                paid, the keys exist, but the mail did not go out. Say so
                                plainly rather than showing a success screen. */}
                            {(order.status === "paid" || order.status === "settled") && !order.emailSent && (
                                <p className="auth__error" style={{ marginTop: 18 }}>
                                    Your keys were created but the email has not gone out yet.
                                    Contact support with this order id and we will resend them.
                                </p>
                            )}

                            <p className="auth__alt">
                                <Link to="/sign-up">Create a free account</Link> to redeem your key.
                            </p>
                        </>
                    )}
                </div>
            </main>
        </>
    );
}
