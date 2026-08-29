import { useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";

import Nav from "../components/Nav";
import { useAuth } from "../lib/auth-context.js";

/* Register.
 *
 * FREE, and takes no license key — the same flow the desktop app runs. A key
 * buys time on an account that already exists; it is not what brings one into
 * being (see auth.controller.js signUp). Saying so on the form matters: the
 * previous version of this product required a key up front, and anyone who
 * remembers that will otherwise go looking for one.
 *
 * The three rules below are the SERVER's rules, restated. They are checked
 * here so the answer is instant, and checked there because that is the check
 * that counts — if they ever drift, the server wins and this form is wrong. */

const USERNAME_RE = /^[A-Za-z0-9_]{3,24}$/;
const MIN_PASSWORD = 6;

export default function SignUp() {
    const auth = useAuth();
    const navigate = useNavigate();
    const [email, setEmail] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);

    if (auth.ready && auth.signedIn) return <Navigate to="/dashboard" replace />;

    const localProblem =
        username && !USERNAME_RE.test(username)
            ? "3–24 characters, letters, numbers and underscores only."
            : password && password.length < MIN_PASSWORD
                ? `At least ${MIN_PASSWORD} characters.`
                : "";

    const submit = async (e) => {
        e.preventDefault();
        if (localProblem) return setError(localProblem);
        setBusy(true);
        setError("");
        try {
            await auth.signUp(email.trim(), username.trim(), password);
            navigate("/dashboard", { replace: true });
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
                    <h1>Create an account</h1>
                    <p className="auth__sub">
                        Free, and no key needed. A license key adds premium time to an
                        account you already have — redeem one whenever you like.
                    </p>

                    <label className="field">
                        <span>Email</span>
                        <input
                            type="email"
                            value={email}
                            autoComplete="email"
                            required
                            onChange={(e) => setEmail(e.target.value)}
                        />
                    </label>

                    <label className="field">
                        <span>Username</span>
                        <input
                            type="text"
                            value={username}
                            autoComplete="username"
                            required
                            minLength={3}
                            maxLength={24}
                            onChange={(e) => setUsername(e.target.value)}
                        />
                        <small>What the app greets you by. Letters, numbers and underscores.</small>
                    </label>

                    <label className="field">
                        <span>Password</span>
                        <input
                            type="password"
                            value={password}
                            autoComplete="new-password"
                            required
                            minLength={MIN_PASSWORD}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                        <small>At least {MIN_PASSWORD} characters.</small>
                    </label>

                    {(error || localProblem) && (
                        <p className="auth__error" role="alert">{error || localProblem}</p>
                    )}

                    <button
                        className="btn btn--primary auth__submit"
                        disabled={busy || !email || !username || !password || Boolean(localProblem)}
                    >
                        {busy ? "Creating…" : "Create account"}
                    </button>

                    <p className="auth__alt">
                        Already have one? <Link to="/sign-in">Sign in.</Link>
                    </p>
                </form>
            </main>
        </>
    );
}
