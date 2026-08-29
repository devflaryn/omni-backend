import { Link, NavLink } from "react-router-dom";

import { useAuth } from "../lib/auth-context.js";

export default function Nav() {
    const auth = useAuth();

    return (
        <header className="nav">
            <div className="nav__inner">
                <Link to="/" className="wordmark" aria-label="Omni Executor home">
                    <b>OMNI</b><span className="dot">·</span>EXEC
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
                    {/* Nothing auth-shaped renders until the first /me has
                        answered. Otherwise every reload of a signed-in session
                        flashes "Sign in" for a beat, which reads as having been
                        logged out. */}
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
                    <Link to="/download" className="nav__cta is-key">Download</Link>
                </nav>
            </div>
        </header>
    );
}
