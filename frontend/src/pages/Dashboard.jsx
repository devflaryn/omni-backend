import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import Nav from "../components/Nav";
import { useAuth } from "../lib/auth-context.js";
import { displayName } from "../lib/display.js";

/*
 * The dashboard: your accounts, where they are running, and what they are
 * earning.
 *
 * TWO SOURCES, DELIBERATELY, and the page is built around the fact that they
 * answer different questions:
 *
 *   /api/v1/accounts   FREE. Every account you own and its presence lease —
 *                      "a VM is up, on this machine". Everyone gets this.
 *   /api/v1/stats      PREMIUM. What the script inside that VM last reported.
 *                      A free account gets 402 and the premium panel below.
 *
 * So a free account still sees a real, useful dashboard (which of my accounts
 * are online right now, and where) and sees exactly what premium adds, rather
 * than a wall. And a premium account gets both lights: "running" can be true
 * while "reporting" is false, which is precisely the state — a live VM whose
 * Roblox client died — that this page exists to make visible.
 *
 * Polling is a plain interval and stops when the tab is hidden: a fleet
 * dashboard left open on a second monitor should not spend a request every
 * fifteen seconds for a screen nobody is looking at.
 */

const POLL_MS = 15000;

export default function Dashboard() {
    const auth = useAuth();
    const [accounts, setAccounts] = useState(null);
    const [stats, setStats] = useState(null);
    // The 402 is not an error: it is the answer, and it is what renders the
    // premium panel. Kept apart from `error` so a network failure and a lapsed
    // plan never show each other's message.
    const [locked, setLocked] = useState(false);
    const [error, setError] = useState("");

    const load = useCallback(async () => {
        try {
            const res = await auth.call("/accounts");
            setAccounts(res?.data?.accounts ?? []);
            setError("");
        } catch (err) {
            if (err.status !== 401) setError(err.message);
            return;
        }
        try {
            const res = await auth.call("/stats");
            setStats(res?.data ?? null);
            setLocked(false);
        } catch (err) {
            if (err.status === 402) {
                setLocked(true);
                setStats(null);
            }
        }
    }, [auth]);

    useEffect(() => {
        load();
        const timer = setInterval(() => {
            if (!document.hidden) load();
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [load]);

    const rows = mergeRows(accounts, stats?.accounts);
    const online = rows.filter((r) => r.presence?.state === "running");
    const tracking = rows.filter((r) => r.tracking);

    return (
        <>
            <Nav />
            <main className="dash shell">
                <header className="dash__head">
                    <div>
                        <span className="eyebrow">Dashboard</span>
                        <h1>
                            {auth.user?.username ? `Hey, ${displayName(auth.user.username)}.` : "Your fleet."}
                        </h1>
                        <p>
                            {accounts === null
                                ? "Loading your accounts…"
                                : rows.length === 0
                                    ? "No Roblox accounts yet — add them in the desktop app and they show up here."
                                    : `${rows.length} account${rows.length === 1 ? "" : "s"}, ${online.length} running right now.`}
                        </p>
                    </div>
                    <span className={`plan ${auth.premium ? "is-premium" : ""}`}>
                        {auth.premium
                            ? `${auth.subscription?.planLabel ?? "Premium"}${
                                  auth.subscription?.daysRemaining != null
                                      ? ` · ${auth.subscription.daysRemaining} days left`
                                      : ""
                              }`
                            : "Free plan"}
                    </span>
                </header>

                {error && <p className="dash__error" role="alert">{error}</p>}

                <div className="stat-row">
                    <Tile label="Accounts" value={rows.length} />
                    <Tile label="Running" value={online.length} tone="live" />
                    <Tile
                        label="Reporting"
                        value={locked ? "—" : tracking.length}
                        tone="live"
                        muted={locked}
                    />
                </div>

                {locked && <PremiumPanel lapsed={Boolean(auth.subscription?.plan)} />}

                <section className="dash__list">
                    <header className="dash__list-head">
                        <h2>Accounts</h2>
                        <span>{locked ? "Presence only" : "Live stats"}</span>
                    </header>

                    {rows.length === 0 ? (
                        <p className="dash__empty">
                            {accounts === null
                                ? "…"
                                : "Nothing here yet. Sign in to the desktop app, add a Roblox account, and it appears on this page."}
                        </p>
                    ) : (
                        <ul className="acct-list">
                            {rows.map((row) => (
                                <AccountRow key={row.username} row={row} locked={locked} />
                            ))}
                        </ul>
                    )}
                </section>
            </main>
        </>
    );
}

/*
 * One row per account, whether or not it has ever reported.
 *
 * The accounts list is the spine — it is the complete set and it is free — and
 * the stats are laid over it. An account that stopped reporting therefore
 * still has a row, which is the entire point: a dashboard built the other way
 * around (stats first) silently drops the account you came to check on.
 */
function mergeRows(accounts, statRows) {
    if (!accounts) return [];
    const byName = new Map((statRows ?? []).map((s) => [s.username, s]));
    return accounts.map((a) => {
        const s = byName.get(a.username);
        return {
            username: a.username,
            customName: a.customName,
            presence: a.presence,
            placeId: a.placeId,
            tracking: Boolean(s?.tracking),
            placeName: s?.placeName ?? null,
            metrics: s?.metrics ?? [],
            uptimeSec: s?.uptimeSec ?? null,
            reportedAt: s?.reportedAt ?? null,
        };
    });
}

function AccountRow({ row, locked }) {
    const running = row.presence?.state === "running";
    const dot = row.tracking ? "live" : running ? "warm" : "off";
    const state = row.tracking
        ? "Reporting"
        : running
            ? locked ? row.presence.label : `${row.presence.label} · silent`
            : "Stopped";

    return (
        <li className="acct">
            <span className={`acct__dot is-${dot}`} aria-hidden="true" />
            <span className="acct__id">
                <b>{row.customName || row.username}</b>
                <small>{row.placeName || (row.placeId ? `Place ${row.placeId}` : "—")}</small>
            </span>

            <span className="acct__metrics">
                {row.metrics.slice(0, 4).map((m) => (
                    <span className="metric" key={m.key}>
                        <small>{m.label}</small>
                        <b>{m.display || "—"}</b>
                    </span>
                ))}
                {!row.metrics.length && (
                    <span className="metric metric--none">
                        {locked ? "Premium" : "no readings yet"}
                    </span>
                )}
            </span>

            <span className="acct__state">
                {state}
                {row.reportedAt && <small>{formatAgo(row.reportedAt)}</small>}
            </span>
        </li>
    );
}

function PremiumPanel({ lapsed }) {
    return (
        <section className="premium">
            <div className="premium__body">
                <span className="badge">Premium</span>
                <h2>Stat Track</h2>
                <p>
                    {lapsed
                        ? "Your plan has expired, so your accounts stopped reporting. Redeem a key and they pick it back up on the next launch."
                        : "See what every account is actually earning — gems, coins, level, whatever the game puts on screen — live, from this page."}
                </p>
                <ul>
                    <li>Read straight out of the running client, no screenshots.</li>
                    <li>Tells a live instance apart from one that has quietly stopped earning.</li>
                    <li>Turn it on once in the desktop app; every launch reports after that.</li>
                </ul>
            </div>
            <Link className="btn btn--primary" to="/download">Get the app</Link>
        </section>
    );
}

function Tile({ label, value, tone, muted }) {
    return (
        <div className={`tile ${muted ? "is-muted" : ""}`}>
            <span className="tile__label">{label}</span>
            <span className={`tile__value ${tone === "live" && Number(value) > 0 ? "is-live" : ""}`}>
                {value}
            </span>
        </div>
    );
}

function formatAgo(iso) {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms)) return "";
    if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    return `${Math.round(ms / 3_600_000)}h ago`;
}
