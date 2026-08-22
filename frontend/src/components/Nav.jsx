import { Link, NavLink } from "react-router-dom";

export default function Nav() {
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
                    <Link to="/download" className="nav__cta is-key">Download</Link>
                </nav>
            </div>
        </header>
    );
}
