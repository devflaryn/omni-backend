import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import Nav from "../components/Nav";
import DemoConsole from "../components/DemoConsole";
import CheckoutModal from "../components/CheckoutModal";
import { fetchVersion } from "../lib/dist";

/*
 * Four tiers, one axis: how long the premium features (farming + stat track)
 * stay unlocked. Every paid tier also gifts account credits, and the gift
 * grows with the commitment — that's the whole comparison, so the cards keep
 * the same feature list and let price, duration and credits do the talking.
 */
const PLANS = [
    {
        id: "free",
        name: "Free",
        price: "$0",
        cadence: "forever",
        features: [
            "The Omni Executor desktop app",
            "Playable Android VM sessions",
            "Auto-login & auto-join",
            "Auto-updating builds",
        ],
        cta: "Start for free",
    },
    {
        id: "month",
        name: "1 Month",
        price: "$19.99",
        cadence: "month",
        features: [
            "Everything in Free",
            "Headless farming at scale",
            "Stat track across the fleet",
            "$5 credit for the captcha solver",
        ],
        cta: "Get a 1-month key",
    },
    {
        id: "quarter",
        name: "3 Months",
        price: "$49.99",
        cadence: "3 months",
        features: [
            "Everything in Free",
            "Headless farming at scale",
            "Stat track across the fleet",
            "$20 credit for the captcha solver",
        ],
        cta: "Get a 3-month key",
    },
    {
        id: "lifetime",
        name: "Lifetime",
        price: "$79.99",
        cadence: "once",
        features: [
            "Everything in Free",
            "Headless farming at scale",
            "Stat track across the fleet",
            "$35 credit for the captcha solver",
        ],
        cta: "Go lifetime",
        featured: true,
    },
];

const STEPS = [
    { n: "01", t: "Spin up", d: "A clean Android VM boots from a warm pool in under a second — no snapshots, no waiting." },
    { n: "02", t: "Sign in & join", d: "Your saved cookie logs the client in and drops it straight into the place. No taps, no login screen." },
    { n: "03", t: "Farm or play", d: "Run it headless by the dozen, or take a low-latency session with native keyboard and mouse." },
];

export default function Home() {
    const [version, setVersion] = useState(null);
    /* Which plan the checkout modal is open for, or null. The Free tier
       never sets this: sign-up is already free and needs no key. */
    const [buyPlan, setBuyPlan] = useState(null);
    useEffect(() => { fetchVersion().then(setVersion); }, []);

    /* Landing on /#pricing (or /#flow) from another page is a fresh document:
       the browser tries the anchor jump before React has rendered the target,
       so nothing scrolls. Once mounted, honor the hash ourselves. Same-page
       clicks never reach this — the element exists, the browser handles it. */
    const { hash } = useLocation();
    useEffect(() => {
        if (!hash) return;
        document.getElementById(hash.slice(1))?.scrollIntoView();
    }, [hash]);

    /* On narrow viewports the plan cards become a one-per-view carousel; the
       arrows page it a card at a time. On wide screens they never render.
       The glide is animated by hand: Chrome cancels smooth programmatic
       scrolls inside a snap container (verified here — scrollTo({smooth})
       landed back on the starting card), while direct scrollLeft sticks. */
    const planRail = useRef(null);
    const pagePlans = (dir) => {
        const rail = planRail.current;
        if (!rail) return;
        const cards = [...rail.querySelectorAll(".price")];
        if (!cards.length) return;
        const railLeft = rail.getBoundingClientRect().left;
        const lefts = cards.map((c) => rail.scrollLeft + c.getBoundingClientRect().left - railLeft - 2);
        const current = lefts.reduce((best, left, i) =>
            Math.abs(left - rail.scrollLeft) < Math.abs(lefts[best] - rail.scrollLeft) ? i : best, 0);
        const target = lefts[Math.min(cards.length - 1, Math.max(0, current + dir))];
        const from = rail.scrollLeft;
        const t0 = performance.now();
        const glide = (t) => {
            const k = Math.min(1, (t - t0) / 320);
            rail.scrollLeft = from + (target - from) * (1 - (1 - k) ** 3);
            if (k < 1) requestAnimationFrame(glide);
        };
        requestAnimationFrame(glide);
    };

    return (
        <>
            <Nav />
            <section className="hero">
                <div className="hero__wrap">
                    <span className="eyebrow">More than an executor</span>
                    <h1>
                        Run Roblox by the fleet,
                        <span className="dim-line">on disposable Android VMs.</span>
                    </h1>
                    <p className="hero__sub">
                        Omni Executor boots throwaway Android VMs — each one a <strong>real,
                        logged-in Roblox client</strong> — then farms them headless at scale or hands
                        you a playable session with native input. Auto-login, auto-join, always current.
                    </p>
                    <div className="hero__actions">
                        <Link to="/download" className="btn btn--primary">
                            Download
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                                <path d="M8 1.5v9m0 0L4.5 7M8 10.5 11.5 7M2.5 13.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                        </Link>
                        <a href="#flow" className="btn btn--ghost">See how it works</a>
                    </div>
                    <div className="hero__meta">
                        <span><b>●</b> {version ? `Latest build v${version}` : "Latest build"}</span>
                        <span>Auto-updating</span>
                        <span>Windows · macOS · Linux</span>
                    </div>
                </div>

                {/* Signature: the desktop app itself, docked into the fold.
                    Not a capture — the app is a webview, so its Home screen
                    lives here as live HTML (DemoConsole) with the same canned
                    fleet the old screenshot showed, and it stays clickable
                    through the fade. */}
                <div className="console">
                    <div className="console__glow" />
                    <div className="console__frame">
                        <DemoConsole />
                    </div>
                </div>
            </section>

            <section className="flow" id="flow">
                <div className="shell">
                    <div className="section-head">
                        <span className="eyebrow">The flow</span>
                        <h2>One launch, from cold VM to a client in the world.</h2>
                        <p>Every instance follows the same three beats — nothing to babysit between them.</p>
                    </div>
                    <ol className="flow__grid">
                        {STEPS.map((s) => (
                            <li className="step" key={s.n}>
                                <div className="step__n">{s.n}</div>
                                <h3>{s.t}</h3>
                                <p>{s.d}</p>
                            </li>
                        ))}
                    </ol>
                </div>
            </section>

            <section className="pricing" id="pricing">
                <div className="shell">
                    <div className="section-head section-head--center">
                        <span className="eyebrow">Pricing</span>
                    </div>

                </div>

                {/* The cards live in their own, wider rail (not the shell):
                    all four seat at once when the viewport allows, and below
                    that the rail scrolls with the arrows underneath. */}
                <div className="price-rail">
                    <div className="price-grid" ref={planRail}>
                        {PLANS.map((p) => (
                            <section key={p.id} className={"price" + (p.featured ? " is-featured" : "")}>
                                {p.featured && <div className="price__flag">Best value</div>}
                                <div className="price__name">{p.name}</div>
                                <div className="price__amount">
                                    {p.price}
                                    <span className="price__cadence">/{p.cadence}</span>
                                </div>
                                <ul className="price__features">
                                    {p.features.map((f) => <li key={f}>{f}</li>)}
                                </ul>

                                <div className="price__spacer" />

                                {p.id === "free" ? (
                                    <Link
                                        to="/sign-up"
                                        className={"btn " + (p.featured ? "btn--primary" : "btn--ghost")}
                                    >
                                        {p.cta}
                                    </Link>
                                ) : (
                                    <button
                                        type="button"
                                        className={"btn " + (p.featured ? "btn--primary" : "btn--ghost")}
                                        onClick={() => setBuyPlan(p)}
                                    >
                                        {p.cta}
                                    </button>
                                )}
                            </section>
                        ))}
                    </div>
                    <div className="price-nav">
                        <button type="button" className="price-arrow" aria-label="Previous plan" onClick={() => pagePlans(-1)}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                <path d="m14 6-6 6 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                        </button>
                        <button type="button" className="price-arrow" aria-label="Next plan" onClick={() => pagePlans(1)}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                                <path d="m10 6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                        </button>
                    </div>
                </div>

            </section>

            <footer className="shell foot">
                <span>© Omni Executor</span>
                <span className="mono">{version ? `build v${version}` : "—"}</span>
            </footer>

            {buyPlan && (
                <CheckoutModal plan={buyPlan} onClose={() => setBuyPlan(null)} />
            )}
        </>
    );
}
