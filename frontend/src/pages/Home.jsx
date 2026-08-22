import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Nav from "../components/Nav";
import FleetGrid from "../components/FleetGrid";
import { fetchVersion } from "../lib/dist";

const STEPS = [
    { n: "01", t: "Spin up", d: "A clean Android VM boots from a warm pool in under a second — no snapshots, no waiting." },
    { n: "02", t: "Sign in & join", d: "Your saved cookie logs the client in and drops it straight into the place. No taps, no login screen." },
    { n: "03", t: "Farm or play", d: "Run it headless by the dozen, or take a low-latency session with native keyboard and mouse." },
];

export default function Home() {
    const [version, setVersion] = useState(null);
    useEffect(() => { fetchVersion().then(setVersion); }, []);

    return (
        <>
            <Nav />
            <section className="hero">
                <FleetGrid />
                <div className="hero__wrap">
                    <span className="eyebrow">Omni Executor</span>
                    <h1>Run Roblox by the <span className="accent">fleet.</span></h1>
                    <p className="hero__sub">
                        Omni Executor boots disposable Android VMs — each one a <strong>real, logged-in
                        Roblox client</strong> — then farms them headless at scale or hands you a
                        playable session with native input. Auto-login, auto-join, and it keeps
                        itself up to date.
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
            </section>

            <section className="flow" id="flow">
                <div className="shell">
                    <div className="section-head">
                        <h2>One launch, start to world.</h2>
                        <p>Every instance follows the same three beats — from cold VM to a client standing in the place.</p>
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

            <footer className="shell foot">
                <span>© Omni Executor</span>
                <span className="mono">{version ? `build v${version}` : "—"}</span>
            </footer>
        </>
    );
}
