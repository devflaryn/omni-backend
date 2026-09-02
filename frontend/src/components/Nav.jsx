import { Link, NavLink } from "react-router-dom";

import { useAuth } from "../lib/auth-context.js";

export default function Nav() {
    const auth = useAuth();

    return (
        <header className="nav">
            <div className="nav__bar">
                <Link to="/" className="wordmark" aria-label="Omni Executor home">
                    <span className="wordmark__mark" aria-hidden="true" />
                    <b>Omni</b><span>Executor</span>
                </Link>

                <nav className="nav__links" aria-label="Main menu">
                    <NavLink to="/" end className={({ isActive }) => "nav__link" + (isActive ? " is-active" : "")}>
                        Overview
                    </NavLink>
                    {auth.signedIn && (
                        <NavLink
                            to="/dashboard"
                            className={({ isActive }) => "nav__link" + (isActive ? " is-active" : "")}
                        >
                            Dashboard
                        </NavLink>
                    )}
                    <a href="/#pricing" className="nav__link">Pricing</a>
                    <a href="/#flow" className="nav__link">How it works</a>
                </nav>

                {/* Nothing auth-shaped renders until the first /me has answered.
                    Otherwise every reload of a signed-in session flashes "Sign
                    in" for a beat, which reads as having been logged out. */}
                <div className="nav__actions">
                    {auth.ready && (auth.signedIn ? (
                        <button type="button" className="nav__link nav__link--btn" onClick={auth.signOut}>
                            Sign out
                        </button>
                    ) : (
                        <NavLink
                            to="/sign-in"
                            className={({ isActive }) => "nav__link" + (isActive ? " is-active" : "")}
                        >
                            Sign in
                        </NavLink>
                    ))}
                    <Link to="/download" className="nav__cta">Download</Link>
                </div>
            </div>
        </header>
    );
}
