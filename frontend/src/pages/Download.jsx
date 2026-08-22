import { useEffect, useState } from "react";
import Nav from "../components/Nav";
import { PLATFORMS, fetchVersion, probeInstaller, detectOS } from "../lib/dist";

const GLYPH = {
    win: (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M3 4.6 10.4 3.6v7.4H3V4.6Zm0 8.4h7.4v7.4L3 19.4V13Zm8.6-9.6L21 2.1V11h-9.4V3.4ZM21 13v8.9l-9.4-1.3V13H21Z"/>
        </svg>
    ),
    mac: (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M16.4 12.7c0-2 1.6-3 1.7-3-.9-1.4-2.4-1.5-2.9-1.6-1.2-.1-2.4.7-3 .7-.6 0-1.6-.7-2.6-.7-1.3 0-2.6.8-3.2 2-1.4 2.4-.4 6 .9 7.9.7 1 1.4 2 2.4 2 1 0 1.3-.6 2.5-.6 1.2 0 1.5.6 2.5.6 1 0 1.7-.9 2.3-1.9.7-1.1 1-2.1 1-2.2 0-.1-2-.8-2-3Zm-2-5.6c.5-.7.9-1.6.8-2.5-.8 0-1.7.5-2.3 1.2-.5.6-1 1.5-.8 2.4.9.1 1.8-.5 2.3-1.1Z"/>
        </svg>
    ),
    linux: (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2.2c-2 0-3.2 1.7-3.2 3.9 0 1.3.3 1.9.3 3-.1.9-1 1.9-1.7 3.2-.7 1.2-1.6 2.4-1.6 4 0 .7.3 1.2.8 1.4-.1.6-.2 1.2.2 1.6.4.4 1.1.4 2 .3.7-.1 1.3-.1 1.7.2.5.3 1 .8 2.2.8s1.7-.5 2.2-.8c.4-.3 1-.3 1.7-.2.9.1 1.6.1 2-.3.4-.4.3-1 .2-1.6.5-.2.8-.7.8-1.4 0-1.6-.9-2.8-1.6-4-.7-1.3-1.6-2.3-1.7-3.2 0-1.1.3-1.7.3-3 0-2.2-1.2-3.9-3.2-3.9Zm-1.3 4c.3 0 .6.4.6.8 0 .5-.3.8-.6.8s-.6-.3-.6-.8c0-.4.3-.8.6-.8Zm2.6 0c.3 0 .6.4.6.8 0 .5-.3.8-.6.8s-.6-.3-.6-.8c0-.4.3-.8.6-.8Z"/>
        </svg>
    ),
};

const DL_ICON = (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 1.5v9m0 0L4.5 7M8 10.5 11.5 7M2.5 13.5h11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
);

export default function Download() {
    const [version, setVersion] = useState(null);
    const [avail, setAvail] = useState({});     // os -> { available, url }
    const [you, setYou] = useState("win");

    useEffect(() => {
        setYou(detectOS());
        fetchVersion().then(setVersion);
        PLATFORMS.forEach((p) =>
            probeInstaller(p.os).then((a) => setAvail((s) => ({ ...s, [p.os]: a })))
        );
    }, []);

    return (
        <>
            <Nav />
            <main className="shell dl">
                <div className="dl__head">
                    <h1>Download Omni Executor.</h1>
                    <p>One installer per platform. Every build checks for updates on launch and
                       keeps itself current — install once, stay on the latest.</p>
                    <div className="version-tag">
                        <span className="pulse" aria-hidden="true" />
                        {version
                            ? <>Latest build <span className="dim">·</span> v{version}</>
                            : <>Checking latest build…</>}
                    </div>
                </div>

                <div className="os-grid">
                    {PLATFORMS.map((p) => {
                        const a = avail[p.os];
                        const ready = a?.available;
                        const loading = a === undefined;
                        const isYou = you === p.os;
                        return (
                            <section
                                key={p.id}
                                className={"os" + (ready ? " is-ready" : "") + (isYou ? " is-you" : "")}
                            >
                                {isYou && <div className="os__reco">Your device</div>}
                                <div className="os__glyph">{GLYPH[p.os]}</div>
                                <h2 className="os__name">{p.name}</h2>
                                <div className="os__meta">{p.meta}</div>

                                <span className={"status " + (ready ? "ok" : "soon")}>
                                    <span className="d" />
                                    {loading ? "Checking…" : ready ? "Available now" : "Coming soon"}
                                </span>

                                <div className="os__spacer" />

                                {ready ? (
                                    <a className="btn btn--primary" href={a.url} download={p.filename}>
                                        {DL_ICON} Download {p.ext}
                                    </a>
                                ) : (
                                    <button className="btn btn--ghost is-disabled" disabled>
                                        {p.ext} · not yet published
                                    </button>
                                )}
                                <p className="os__note">{ready ? p.note : "We’ll flip this on the moment the build ships."}</p>
                            </section>
                        );
                    })}
                </div>

                <div className="dl__foot">
                    <span className="badge">Auto-update</span>
                    <span>After install, Omni Executor updates silently on launch — a newer build downloads in the
                          background and offers a restart. You never chase a version.</span>
                </div>
            </main>

            <footer className="shell foot">
                <span>© Omni Executor</span>
                <span className="mono">{version ? `build v${version}` : "—"}</span>
            </footer>
        </>
    );
}
