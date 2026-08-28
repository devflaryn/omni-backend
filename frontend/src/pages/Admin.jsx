import { useCallback, useEffect, useState } from "react";

/**
 * The credits desk: find a user, read their balance and history, move credit.
 *
 * This page carries its own sign-in because the rest of the site is anonymous
 * marketing — there is no session to inherit. The token lives in localStorage
 * under its own key so it cannot be confused with anything the public pages do.
 *
 * Every amount crossing the wire is in integer MICRO-dollars (1e-6). Dollars
 * only exist for display and for the one input a human types into.
 */

const TOKEN_KEY = "omni-admin-token";
const MICROS = 1_000_000;

const money = (micros) => `$${((Number(micros) || 0) / MICROS).toFixed(2)}`;

async function api(path, { token, method = "GET", body } = {}) {
    const res = await fetch(`/api/v1${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
    return json;
}

function SignIn({ onToken }) {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState(false);

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        try {
            const r = await api("/auth/sign-in", {
                method: "POST",
                body: { email, password },
            });
            const token = r?.data?.token;
            if (!token) throw new Error("No token returned");
            localStorage.setItem(TOKEN_KEY, token);
            onToken(token);
        } catch (e2) {
            setErr(e2.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <form onSubmit={submit} style={S.card}>
            <h1 style={S.h1}>Admin</h1>
            <input style={S.input} placeholder="email" value={email} autoComplete="username"
                   onChange={(e) => setEmail(e.target.value)} />
            <input style={S.input} type="password" placeholder="password" value={password}
                   autoComplete="current-password"
                   onChange={(e) => setPassword(e.target.value)} />
            <button style={S.button} disabled={busy || !email || !password}>
                {busy ? "Signing in…" : "Sign in"}
            </button>
            {err && <p style={S.error}>{err}</p>}
        </form>
    );
}

function Adjust({ token, user, onDone }) {
    const [dollars, setDollars] = useState("");
    const [reason, setReason] = useState("");
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState(false);

    // A reason is required by the API, not just by this form: the ledger's
    // whole purpose is that a balance change can be explained a month later.
    const apply = async (sign) => {
        const amount = Number(dollars);
        if (!Number.isFinite(amount) || amount <= 0) return setErr("Enter an amount");
        if (!reason.trim()) return setErr("A reason is required");
        setBusy(true);
        setErr("");
        try {
            await api(`/credits/admin/users/${user._id}/adjust`, {
                token,
                method: "POST",
                body: { deltaMicros: sign * Math.round(amount * MICROS), reason: reason.trim() },
            });
            setDollars("");
            setReason("");
            onDone();
        } catch (e) {
            setErr(e.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={{ ...S.row, flexWrap: "wrap", gap: 8 }}>
            <input style={{ ...S.input, width: 110, margin: 0 }} placeholder="$ amount"
                   value={dollars} onChange={(e) => setDollars(e.target.value)} />
            <input style={{ ...S.input, flex: 1, minWidth: 180, margin: 0 }} placeholder="reason (required)"
                   value={reason} onChange={(e) => setReason(e.target.value)} />
            <button style={{ ...S.button, margin: 0, background: "#1c7f4b" }}
                    disabled={busy} onClick={() => apply(1)}>Add</button>
            <button style={{ ...S.button, margin: 0, background: "#8c2f2f" }}
                    disabled={busy} onClick={() => apply(-1)}>Remove</button>
            {err && <p style={{ ...S.error, width: "100%" }}>{err}</p>}
        </div>
    );
}

function Ledger({ token, user }) {
    const [rows, setRows] = useState(null);
    useEffect(() => {
        let alive = true;
        api(`/credits/admin/users/${user._id}/transactions`, { token })
            .then((r) => alive && setRows(r.data || []))
            .catch(() => alive && setRows([]));
        return () => { alive = false; };
    }, [token, user._id, user.balanceMicros]);

    if (rows === null) return <p style={S.dim}>Loading history…</p>;
    if (!rows.length) return <p style={S.dim}>No transactions yet.</p>;
    return (
        <table style={S.table}>
            <thead>
                <tr>
                    <th style={S.th}>When</th><th style={S.th}>Kind</th>
                    <th style={S.th}>Change</th><th style={S.th}>Balance after</th>
                    <th style={S.th}>Reason</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((t) => (
                    <tr key={t._id}>
                        <td style={S.td}>{new Date(t.createdAt).toLocaleString()}</td>
                        <td style={S.td}>{t.kind}</td>
                        <td style={{ ...S.td, color: t.deltaMicros < 0 ? "#e08585" : "#7fd4a2" }}>
                            {t.deltaMicros < 0 ? "-" : "+"}{money(Math.abs(t.deltaMicros))}
                        </td>
                        <td style={S.td}>{money(t.balanceAfterMicros)}</td>
                        <td style={S.td}>{t.reason || "—"}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

export default function Admin() {
    const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
    const [q, setQ] = useState("");
    const [users, setUsers] = useState([]);
    const [selected, setSelected] = useState(null);
    const [err, setErr] = useState("");

    const load = useCallback(async () => {
        if (!token) return;
        try {
            const r = await api(`/credits/admin/users?q=${encodeURIComponent(q)}`, { token });
            setUsers(r.data || []);
            setErr("");
            // Keep the open user's balance in step with the list we just read.
            setSelected((cur) => (cur ? (r.data || []).find((u) => u._id === cur._id) || cur : cur));
        } catch (e) {
            // A stale or non-admin token should return you to the login form
            // rather than leaving an empty page with no explanation.
            if (/401|403/.test(e.message)) {
                localStorage.removeItem(TOKEN_KEY);
                setToken("");
            }
            setErr(e.message);
        }
    }, [token, q]);

    useEffect(() => { load(); }, [load]);

    if (!token) return <div style={S.page}><SignIn onToken={setToken} /></div>;

    return (
        <div style={S.page}>
            <div style={{ ...S.card, maxWidth: 900 }}>
                <div style={S.row}>
                    <h1 style={{ ...S.h1, flex: 1 }}>Credits</h1>
                    <button style={{ ...S.button, margin: 0, background: "#333" }}
                            onClick={() => { localStorage.removeItem(TOKEN_KEY); setToken(""); }}>
                        Sign out
                    </button>
                </div>

                <input style={S.input} placeholder="search by email or username"
                       value={q} onChange={(e) => setQ(e.target.value)} />
                {err && <p style={S.error}>{err}</p>}

                <table style={S.table}>
                    <thead>
                        <tr>
                            <th style={S.th}>User</th><th style={S.th}>Plan</th>
                            <th style={S.th}>Balance</th><th style={S.th} />
                        </tr>
                    </thead>
                    <tbody>
                        {users.map((u) => (
                            <tr key={u._id}>
                                <td style={S.td}>
                                    {u.username || "—"}<br />
                                    <span style={S.dim}>{u.email}</span>
                                </td>
                                <td style={S.td}>{u.subscription?.plan || "free"}</td>
                                {/* The admin sees the TRUE balance, overdraft included:
                                    they are the one person who needs the real number. */}
                                <td style={{ ...S.td, color: u.balanceMicros < 0 ? "#e08585" : "inherit" }}>
                                    {money(u.balanceMicros)}
                                </td>
                                <td style={S.td}>
                                    <button style={{ ...S.button, margin: 0, padding: "4px 10px" }}
                                            onClick={() => setSelected(u)}>Manage</button>
                                </td>
                            </tr>
                        ))}
                        {!users.length && (
                            <tr><td style={S.td} colSpan={4}><span style={S.dim}>No users found.</span></td></tr>
                        )}
                    </tbody>
                </table>

                {selected && (
                    <div style={S.panel}>
                        <div style={S.row}>
                            <strong style={{ flex: 1 }}>
                                {selected.username || selected.email} — {money(selected.balanceMicros)}
                            </strong>
                            <button style={{ ...S.button, margin: 0, background: "#333" }}
                                    onClick={() => setSelected(null)}>Close</button>
                        </div>
                        <Adjust token={token} user={selected} onDone={load} />
                        <Ledger token={token} user={selected} />
                    </div>
                )}
            </div>
        </div>
    );
}

const S = {
    page: { minHeight: "100vh", background: "#0d0f12", color: "#e6e8ea",
            fontFamily: "system-ui, sans-serif", padding: 24 },
    card: { maxWidth: 420, margin: "40px auto", background: "#14181d",
            border: "1px solid #232a31", borderRadius: 12, padding: 20 },
    h1: { fontSize: 20, margin: "0 0 14px" },
    row: { display: "flex", alignItems: "center", gap: 10 },
    input: { width: "100%", boxSizing: "border-box", margin: "0 0 10px",
             padding: "9px 11px", borderRadius: 8, border: "1px solid #2a323a",
             background: "#0f1317", color: "#e6e8ea", fontSize: 14 },
    button: { margin: "6px 0 0", padding: "9px 14px", borderRadius: 8,
              border: "none", background: "#2f6feb", color: "#fff",
              fontSize: 14, cursor: "pointer" },
    error: { color: "#e08585", fontSize: 13, margin: "8px 0 0" },
    dim: { color: "#8b949e", fontSize: 12 },
    table: { width: "100%", borderCollapse: "collapse", marginTop: 12, fontSize: 13 },
    th: { textAlign: "left", padding: "6px 8px", borderBottom: "1px solid #232a31",
          color: "#8b949e", fontWeight: 500 },
    td: { padding: "8px", borderBottom: "1px solid #1b2128", verticalAlign: "top" },
    panel: { marginTop: 16, padding: 14, border: "1px solid #232a31",
             borderRadius: 10, background: "#0f1317" },
};
