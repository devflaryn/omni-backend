import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";

import Nav from "../components/Nav";
import { useAuth } from "../lib/auth-context.js";

/* Sign in.
 *
 * The same account as the desktop app — that sentence is on the page on
 * purpose. The two surfaces share one credential and one set of Roblox
 * accounts, and someone who has already installed the app needs to know they
 * are not making a second one here. */
export default function SignIn() {
    const auth = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    // Where to land afterwards: back where they were sent from, or the
    // dashboard. Preserved by RequireAuth so a bookmarked /dashboard survives
    // a sign-in instead of dumping everyone on the same page.
    const next = location.state?.from ?? "/dashboard";

    if (auth.ready && auth.signedIn) return <Navigate to={next} replace />;

    const submit = async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            await auth.signIn(email.trim(), password);
            navigate(next, { replace: true });
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <Nav />
            <main className="auth">
                <form className="auth__card" onSubmit={submit}>
                    <span className="eyebrow">Omni Executor</span>
                    <h1>Sign in</h1>
                    <p className="auth__sub">
                        The same account as the desktop app. Your Roblox accounts, their
                        cookies and their stats follow the account, not the machine.
                    </p>

                    <label className="field">
                        <span>Email</span>
                        <input
                            type="email"
                            value={email}
                            autoComplete="username"
                            required
                            onChange={(e) => setEmail(e.target.value)}
                        />
                    </label>

                    <label className="field">
                        <span>Password</span>
                        <input
                            type="password"
                            value={password}
                            autoComplete="current-password"
                            required
                            onChange={(e) => setPassword(e.target.value)}
                        />
                    </label>

                    {error && <p className="auth__error" role="alert">{error}</p>}

                    <button className="btn btn--primary auth__submit" disabled={busy || !email || !password}>
                        {busy ? "Signing in…" : "Sign in"}
                    </button>

                    <p className="auth__alt">
                        No account yet? <Link to="/sign-up">Create one — it&rsquo;s free.</Link>
                    </p>
                </form>
            </main>
        </>
    );
}
