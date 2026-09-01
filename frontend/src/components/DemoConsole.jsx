/* DemoConsole — the desktop app, live in the hero.

   The real app is a webview (omni-executor/frontend), so its Home screen can
   exist here as actual HTML instead of a screenshot. This is that: the same
   rail, titlebar, cards and pills, with the data hardcoded to the same
   fictional fleet the old capture showed (devflaryn, twelve accounts, three
   running) — and it's alive. Tabs switch, instances launch and stop with the
   boot pulse, the editor "executes", the link check re-runs, the theme
   flips. None of it talks to a backend; every interaction is canned state.

   The whole thing renders at a fixed 1080×640 design size and scales to its
   container (see useFitScale), so the layout is identical at every viewport
   — a live version of what <img> scaling used to do. */

import { memo, useEffect, useMemo, useRef, useState } from "react";
import "./demo-console.css";

/* ------------------------------------------------------------------- data */

const FLEET = [
    { name: "VelvetOtter912", arch: "x86", base: "bliss-15", running: true, mode: "farming", vnc: 5901, adb: 5555 },
    { name: "CinderHawk304", arch: "x86", base: "bliss-15", running: true, mode: "gaming", win: [1280, 720], adb: 5557 },
    { name: "LunarBison77", arch: "arm", base: "bliss-15", running: false },
    { name: "QuartzRaven158", arch: "x86", base: "bliss-15", running: false },
    { name: "DriftMarmot421", arch: "x86", base: "bliss-15", running: false },
    { name: "EmberLynx630", arch: "x86", base: "bliss-15", running: true, mode: "farming", vnc: 5906, adb: 5561 },
    { name: "OpalHeron245", arch: "x86", base: "bliss-15", running: false },
    { name: "NimbusVole883", arch: "arm", base: "bliss-15", running: false },
    { name: "SableFinch519", arch: "x86", base: "bliss-15", running: false },
    { name: "TundraStoat228", arch: "x86", base: "bliss-15", running: false },
    { name: "CobaltShrew660", arch: "arm", base: "bliss-15", running: false },
    { name: "PrairieLark414", arch: "x86", base: "bliss-15", running: false },
];

const FARM_MEMBERS = FLEET.slice(0, 9).map((a) => a.name);

const AUTOEXEC = ["00-antiafk.lua", "10-collect.lua", "20-rejoin.lua"];

/* What the editor opens with. The buffer is real, editable state — see
   EditorTab's textarea-over-highlight surface. */
const STARTER_LUA = 'print("Hello, world!")';

const NAV = [
    { id: "home", label: "Home" },
    { id: "editor", label: "Editor" },
    { id: "accounts", label: "Accounts" },
    { id: "farming", label: "Farming" },
    { id: "stattrack", label: "Stat Track" },
    { id: "network", label: "Network" },
    { id: "settings", label: "Settings" },
];

/* ------------------------------------------------------------------ icons
   Copied from the app's icon set (lucide outlines + the duo rail set). */

const base = {
    viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round",
};
const rail = { ...base, strokeWidth: 1.9 };
const DIM = { opacity: 0.45 };

const I = {
    HomeDuo: (p) => (
        <svg {...rail} {...p}>
            <path d="M4.6 10.4 12 4.9l7.4 5.5v6.9a2.3 2.3 0 0 1-2.3 2.3H6.9a2.3 2.3 0 0 1-2.3-2.3z" />
            <path {...DIM} d="M9.9 19.4v-4.3a1.6 1.6 0 0 1 1.6-1.6h1a1.6 1.6 0 0 1 1.6 1.6v4.3" />
        </svg>
    ),
    CodeDuo: (p) => (
        <svg {...rail} {...p}>
            <rect {...DIM} x="3.3" y="3.9" width="17.4" height="16.2" rx="4.4" />
            <path d="m9.5 9.6-2.5 2.4 2.5 2.4m5-4.8 2.5 2.4-2.5 2.4" />
        </svg>
    ),
    UsersDuo: (p) => (
        <svg {...rail} {...p}>
            <g {...DIM}>
                <path d="M16.4 6.3a2.9 2.9 0 0 1 0 5.6" />
                <path d="M15.5 14.5c2.5.4 4.3 1.9 4.9 4.3.15.6-.3 1.2-.95 1.2h-1.7" />
            </g>
            <circle cx="9.3" cy="8.6" r="3.1" />
            <path d="M3.3 18.9c.6-2.9 2.9-4.6 6-4.6s5.4 1.7 6 4.6c.13.6-.35 1.1-.97 1.1H4.27c-.62 0-1.1-.5-.97-1.1z" />
        </svg>
    ),
    GridDuo: (p) => (
        <svg {...rail} {...p}>
            <rect x="3.7" y="3.7" width="7" height="7" rx="2.3" />
            <rect {...DIM} x="13.3" y="3.7" width="7" height="7" rx="2.3" />
            <rect {...DIM} x="3.7" y="13.3" width="7" height="7" rx="2.3" />
            <rect x="13.3" y="13.3" width="7" height="7" rx="2.3" />
        </svg>
    ),
    ChartDuo: (p) => (
        <svg {...rail} {...p} strokeWidth="2.6">
            <path {...DIM} d="M5.6 19.4v-6.6" />
            <path d="M12 19.4V4.9" />
            <path {...DIM} d="M18.4 19.4v-9.7" />
        </svg>
    ),
    SignalDuo: (p) => (
        <svg {...rail} {...p} strokeWidth="2.1">
            <path {...DIM} d="M4.2 11.2a11 11 0 0 1 15.6 0" />
            <path d="M7.7 14.7a6 6 0 0 1 8.6 0" />
            <path d="M11.99 18.6h.02" strokeWidth="2.8" />
        </svg>
    ),
    GearDuo: (p) => (
        <svg {...rail} {...p}>
            <path {...DIM} d="M12 2.8h-.1a1.9 1.9 0 0 0-1.9 1.9v.17a1.9 1.9 0 0 1-.95 1.64l-.41.24a1.9 1.9 0 0 1-1.9 0l-.14-.08a1.9 1.9 0 0 0-2.6.7l-.05.08a1.9 1.9 0 0 0 .7 2.6l.14.09a1.9 1.9 0 0 1 .95 1.63v.47a1.9 1.9 0 0 1-.95 1.66l-.14.08a1.9 1.9 0 0 0-.7 2.6l.05.08a1.9 1.9 0 0 0 2.6.7l.14-.08a1.9 1.9 0 0 1 1.9 0l.41.24a1.9 1.9 0 0 1 .95 1.64v.17a1.9 1.9 0 0 0 1.9 1.9h.1a1.9 1.9 0 0 0 1.9-1.9v-.17a1.9 1.9 0 0 1 .95-1.64l.41-.24a1.9 1.9 0 0 1 1.9 0l.14.08a1.9 1.9 0 0 0 2.6-.7l.05-.09a1.9 1.9 0 0 0-.7-2.6l-.14-.08a1.9 1.9 0 0 1-.95-1.65v-.47a1.9 1.9 0 0 1 .95-1.64l.14-.09a1.9 1.9 0 0 0 .7-2.6l-.05-.08a1.9 1.9 0 0 0-2.6-.7l-.14.08a1.9 1.9 0 0 1-1.9 0l-.41-.24a1.9 1.9 0 0 1-.95-1.64v-.17A1.9 1.9 0 0 0 12 2.8z" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    ),
    Minus: (p) => <svg {...base} {...p}><path d="M5 12h14" /></svg>,
    Maximize: (p) => <svg {...base} strokeLinecap="butt" {...p}><rect x="5" y="5" width="14" height="14" rx="1.5" /></svg>,
    Close: (p) => <svg {...base} {...p}><path d="m6 6 12 12M18 6 6 18" /></svg>,
    Users: (p) => (
        <svg {...base} {...p}>
            <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
    ),
    UserPlus: (p) => (
        <svg {...base} {...p}>
            <path d="M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="8.5" cy="7" r="4" />
            <path d="M19 8v6M22 11h-6" />
        </svg>
    ),
    Play: (p) => (
        <svg viewBox="0 0 24 24" fill="currentColor" {...p}>
            <path d="M7 4.6c0-.8.87-1.29 1.55-.88l11.2 6.9a1 1 0 0 1 0 1.7l-11.2 6.9A1.03 1.03 0 0 1 7 18.34Z" />
        </svg>
    ),
    Stop: (p) => <svg viewBox="0 0 24 24" fill="currentColor" {...p}><rect x="6" y="6" width="12" height="12" rx="2" /></svg>,
    Plus: (p) => <svg {...base} strokeWidth={2.1} {...p}><path d="M12 5v14M5 12h14" /></svg>,
    Gear: (p) => (
        <svg {...base} {...p}>
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    ),
    Rocket: (p) => (
        <svg {...base} {...p}>
            <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
            <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
            <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
        </svg>
    ),
    File: (p) => (
        <svg {...base} {...p}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6" />
        </svg>
    ),
    Code: (p) => <svg {...base} {...p}><path d="m8 6-6 6 6 6M16 6l6 6-6 6" /></svg>,
    Search: (p) => <svg {...base} {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.6-3.6" /></svg>,
    Monitor: (p) => <svg {...base} {...p}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></svg>,
    MonitorOff: (p) => (
        <svg {...base} {...p}>
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" /><path d="m3 2 18 18" />
        </svg>
    ),
    Trash: (p) => (
        <svg {...base} {...p}>
            <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
    ),
    Copy: (p) => (
        <svg {...base} {...p}>
            <rect x="9" y="9" width="12" height="12" rx="2" />
            <path d="M5 15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2" />
        </svg>
    ),
    Eraser: (p) => (
        <svg {...base} {...p}>
            <path d="M8.5 20.5 3.9 15.9a2 2 0 0 1 0-2.83l8.4-8.4a2 2 0 0 1 2.83 0l4.6 4.6a2 2 0 0 1 0 2.83L11.3 20.5Z" />
            <path d="M11 21h9M7.5 11.5 15 19" />
        </svg>
    ),
    Check: (p) => <svg {...base} strokeWidth={2.2} {...p}><path d="m4 12.5 5.2 5.2L20 7" /></svg>,
    Chart: (p) => <svg {...base} {...p}><path d="M3 3v16a2 2 0 0 0 2 2h16" /><path d="m7 15 3.5-4 3 2.5L18 8" /></svg>,
    Grid: (p) => (
        <svg {...base} {...p}>
            <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
            <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
        </svg>
    ),
    HeartPulse: (p) => (
        <svg {...base} {...p}>
            <path d="M20.4 5.6a5 5 0 0 0-7.1 0L12 6.9l-1.3-1.3a5 5 0 1 0-7.1 7.1l1.3 1.3L12 21l7.1-7a34 34 0 0 0 1.3-1.3 5 5 0 0 0 0-7.1z" />
            <path d="M3.5 12.5h3l1.5-2.5 2 4 1.5-3 1 1.5h3" />
        </svg>
    ),
    Clock: (p) => <svg {...base} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 1.9" /></svg>,
    Signal: (p) => <svg {...base} {...p}><path d="M3 20v-3" /><path d="M8.5 20v-7" /><path d="M14 20v-11" /><path d="M19.5 20V4" /></svg>,
    Globe: (p) => (
        <svg {...base} {...p}>
            <circle cx="12" cy="12" r="9" /><path d="M3 12h18" />
            <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18z" />
        </svg>
    ),
    Route: (p) => (
        <svg {...base} {...p}>
            <circle cx="5.5" cy="18.5" r="2.5" /><circle cx="18.5" cy="5.5" r="2.5" />
            <path d="M8 18.5h5a3.5 3.5 0 0 0 0-7h-2a3.5 3.5 0 0 1 0-7h5" />
        </svg>
    ),
    Refresh: (p) => <svg {...base} {...p}><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 4v5h-5" /></svg>,
    Cpu: (p) => (
        <svg {...base} {...p}>
            <rect x="6" y="6" width="12" height="12" rx="2" />
            <path d="M9.5 2.5v3.5M14.5 2.5v3.5M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5" />
        </svg>
    ),
    User: (p) => <svg {...base} {...p}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>,
};

/* --------------------------------------------------------------- helpers */

function greeting() {
    const h = new Date().getHours();
    const part = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    return `${part}, devflaryn`;
}

function initials(name) {
    const parts = String(name).trim().split(/[\s_-]+/).filter(Boolean);
    if (!parts.length) return "?";
    const chars = parts.length > 1 ? parts.slice(0, 2).map((p) => p[0]) : [parts[0].slice(0, 2)];
    return chars.join("").toUpperCase();
}

const LUA_KW = new Set([
    "local", "function", "end", "for", "in", "do", "if", "then", "elseif",
    "else", "while", "return", "break", "not", "and", "or", "true", "false", "nil",
]);
const LUA_GLOBALS = new Set(["game", "workspace", "task", "print", "string", "math"]);

/* Small Lua highlighter for the canned buffer — same token classes as the
   app's lua.js, driven by the same one-hue-per-class palette. */
function highlightLine(line, key) {
    const out = [];
    const re = /(--.*$)|("(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)|([+\-*/%=<>~#]+)/g;
    let last = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
        if (m.index > last) out.push(line.slice(last, m.index));
        const text = m[0];
        let cls = null;
        if (m[1]) cls = "dc-tok-com";
        else if (m[2]) cls = "dc-tok-str";
        else if (m[3]) cls = "dc-tok-num";
        else if (m[5]) cls = "dc-tok-op";
        else if (LUA_KW.has(text)) cls = "dc-tok-kw";
        else {
            const prev = line[m.index - 1];
            const next = line[re.lastIndex];
            if (prev === "." || prev === ":") cls = next === "(" ? "dc-tok-fn" : "dc-tok-prop";
            else if (LUA_GLOBALS.has(text) || next === "(") cls = "dc-tok-fn";
            else cls = "dc-tok-var";
        }
        out.push(cls ? <span key={`${key}-${m.index}`} className={cls}>{text}</span> : text);
        last = re.lastIndex;
    }
    if (last < line.length) out.push(line.slice(last));
    return out;
}

/* One rendered line. Memoized: while typing, every unchanged line skips its
   re-highlight — only the edited line pays. */
const CodeLine = memo(function CodeLine({ text, k }) {
    return <div>{text ? highlightLine(text, k) : "\u00a0"}</div>;
});

/** Scale the fixed-size sheet to whatever width the hero gives it. */
function useFitScale(designW) {
    const ref = useRef(null);
    const [scale, setScale] = useState(1);
    useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const measure = () => setScale(el.clientWidth / designW);
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [designW]);
    return [ref, scale];
}

function Lamp({ tone = "off", pulse = false, sm = false }) {
    return (
        <span
            className={`dc-lamp${sm ? " dc-lamp--sm" : ""}${tone !== "off" ? ` dc-lamp--${tone}` : ""}${pulse ? " dc-pulse" : ""}`}
        />
    );
}

function Chip({ tone, upper, cap, children, title }) {
    return (
        <span
            title={title}
            className={`dc-chip${tone ? ` dc-chip--${tone}` : ""}${upper ? " dc-chip--upper" : ""}${cap ? " dc-chip--cap" : ""}`}
        >
            {children}
        </span>
    );
}

function Btn({ solid, sm, lg, full, className = "", children, ...rest }) {
    const cls = ["dc-btn", solid && "dc-btn--solid", sm && "dc-btn--sm", lg && "dc-btn--lg", full && "dc-btn--full", className]
        .filter(Boolean).join(" ");
    return <button type="button" className={cls} {...rest}>{children}</button>;
}

function IconBtn({ label, tone, className = "", children, ...rest }) {
    const cls = ["dc-iconbtn", tone && `dc-iconbtn--${tone}`, className].filter(Boolean).join(" ");
    return <button type="button" title={label} aria-label={label} className={cls} {...rest}>{children}</button>;
}

function PanelHead({ icon: Icon, title, count, right }) {
    return (
        <header className="dc-panelhead dc-rule-b">
            {Icon && <Icon />}
            <h3>{title}</h3>
            {count != null && <span className="dc-panelhead__count">{count}</span>}
            <div className="dc-panelhead__right">{right}</div>
        </header>
    );
}

function Field({ label, hint, children }) {
    return (
        <div className="dc-field">
            <label>{label}</label>
            {children}
            {hint && <small>{hint}</small>}
        </div>
    );
}

/* ------------------------------------------------------------- component */

/* The virtual sheet is drawn at this size, then scaled to fit the frame. A
   LARGER design width means a smaller scale factor — the whole app reads a
   step more zoomed out (and more of it fits under the fold). */
const DESIGN_W = 1420;
const DESIGN_H = 840;

export default function DemoConsole() {
    const [fitRef, scale] = useFitScale(DESIGN_W);
    const [theme, setTheme] = useState("dark");
    const [tab, setTab] = useState("home");
    const [accounts, setAccounts] = useState(FLEET);
    const [launch, setLaunch] = useState({ mode: "gaming", gpu: "auto", place: "8737899170" });
    const [stattrack, setStattrack] = useState(true);
    // The editor buffer lives up here so edits survive a tab switch and the
    // Home tab's "Recent scripts" line count stays honest.
    const [code, setCode] = useState(STARTER_LUA);

    // Pretend engine: launches and stops land after a short, staggered delay,
    // exactly long enough to watch the boot pulse travel the strip.
    const timers = useRef([]);
    useEffect(() => () => timers.current.forEach(clearTimeout), []);
    const after = (ms, fn) => timers.current.push(setTimeout(fn, ms));
    const patch = (name, p) =>
        setAccounts((list) => list.map((a) => (a.name === name ? { ...a, ...p } : a)));

    const start = (name, delay = 0) => {
        patch(name, { busy: "Starting" });
        after(1500 + delay, () =>
            patch(name, {
                busy: null, running: true, mode: launch.mode,
                ...(launch.mode === "farming" ? { vnc: 5910, adb: 5560, win: undefined } : { win: [1280, 720], adb: 5560, vnc: undefined }),
            })
        );
    };
    const stop = (name, delay = 0) => {
        patch(name, { busy: "Stopping" });
        after(900 + delay, () => patch(name, { busy: null, running: false, mode: undefined, vnc: undefined, win: undefined }));
    };
    const startMany = (names) => names.forEach((n, i) => start(n, i * 350));
    const stopMany = (names) => names.forEach((n, i) => stop(n, i * 200));

    const running = accounts.filter((a) => a.running);
    const stopped = accounts.filter((a) => !a.running && !a.busy);

    const subtitle =
        tab === "accounts" ? `${accounts.length} accounts${running.length ? ` · ${running.length} running` : ""}`
        : tab === "editor" || tab === "farming" ? "Engine ready"
        : tab === "network" ? "Both links answer"
        : tab === "settings" ? "devflaryn"
        : running.length ? `${running.length} running` : "Engine ready";

    const railIcons = { home: I.HomeDuo, editor: I.CodeDuo, accounts: I.UsersDuo, farming: I.GridDuo, stattrack: I.ChartDuo, network: I.SignalDuo, settings: I.GearDuo };

    return (
        <div ref={fitRef} className="dc-fit" style={{ height: DESIGN_H * scale }}>
            <div
                className={`dc${theme === "light" ? " dc--light" : ""}`}
                style={{ width: DESIGN_W, height: DESIGN_H, transform: `scale(${scale})` }}
            >
                <aside className="dc-rail">
                    <div className="dc-rail__mark" aria-hidden="true">Ω</div>
                    <nav className="dc-rail__nav" aria-label="Demo sections">
                        {NAV.map(({ id, label }) => {
                            const Icon = railIcons[id];
                            return (
                                <button
                                    key={id}
                                    type="button"
                                    title={label}
                                    aria-label={label}
                                    aria-current={tab === id ? "page" : undefined}
                                    onClick={() => setTab(id)}
                                    className={`dc-railbtn${tab === id ? " is-active" : ""}`}
                                >
                                    <Icon />
                                </button>
                            );
                        })}
                    </nav>
                </aside>

                <div className="dc-main">
                    <header className="dc-titlebar">
                        <span className="dc-titlebar__title">{NAV.find((n) => n.id === tab)?.label}</span>
                        <span className="dc-titlebar__sub">· {subtitle}</span>
                        <div className="dc-titlebar__controls" aria-hidden="true">
                            <IconBtn label="Minimize (demo)" tabIndex={-1}><I.Minus /></IconBtn>
                            <IconBtn label="Maximize (demo)" tabIndex={-1}><I.Maximize /></IconBtn>
                            <IconBtn label="Close (demo)" tabIndex={-1}><I.Close /></IconBtn>
                        </div>
                    </header>

                    {tab === "home" && (
                        <HomeTab
                            accounts={accounts} running={running} stopped={stopped}
                            scriptLines={code.split("\n").length}
                            onGo={setTab} onLaunchAll={() => startMany(stopped.map((a) => a.name))}
                            onStopAll={() => stopMany(running.map((a) => a.name))}
                        />
                    )}
                    {tab === "editor" && <EditorTab running={running} code={code} onCode={setCode} />}
                    {tab === "accounts" && (
                        <AccountsTab
                            accounts={accounts} launch={launch} onLaunch={setLaunch}
                            onStart={start} onStop={stop} onStartMany={startMany} onStopMany={stopMany}
                        />
                    )}
                    {tab === "farming" && <FarmingTab accounts={accounts} />}
                    {tab === "stattrack" && <StatTrackTab accounts={accounts} enabled={stattrack} onToggle={setStattrack} />}
                    {tab === "network" && <NetworkTab />}
                    {tab === "settings" && <SettingsTab theme={theme} onTheme={setTheme} />}
                </div>
            </div>
        </div>
    );
}

/* ------------------------------------------------------------------- Home */

function HomeTab({ accounts, running, stopped, scriptLines, onGo, onLaunchAll, onStopAll }) {
    return (
        <div className="dc-view">
            <div className="dc-view__inner dc-rise">
                <div className="dc-greet">
                    <div>
                        <h2>{greeting()}</h2>
                        <p>{running.length} of {accounts.length} running on this machine.</p>
                    </div>
                    <div className="dc-greet__health">
                        <Lamp tone={running.length ? "live" : "off"} />
                        <span className="dc-silk">{running.length ? `${running.length} running` : "Ready"}</span>
                    </div>
                </div>

                {/* Instrument strip: one lamp per account. */}
                <div className="dc-card dc-strip" aria-label="Instances at a glance">
                    {accounts.map((a) => (
                        <span
                            key={a.name}
                            title={`${a.name} — ${a.busy ? a.busy.toLowerCase() : a.running ? "running" : "stopped"}`}
                            className={`dc-cell${a.busy ? " dc-cell--busy" : a.running ? " dc-cell--live" : ""}`}
                        />
                    ))}
                </div>

                <div className="dc-tiles">
                    <button type="button" className="dc-tile" onClick={() => onGo("accounts")}>
                        <span className="dc-tile__label"><I.Users />Accounts</span>
                        <span className="dc-tile__value">{accounts.length}</span>
                    </button>
                    <button type="button" className="dc-tile" onClick={() => onGo("accounts")}>
                        <span className="dc-tile__label"><I.Play />Running now</span>
                        <span className={`dc-tile__value${running.length ? " is-live" : ""}`}>{running.length}</span>
                    </button>
                    <button type="button" className="dc-tile" onClick={() => onGo("editor")}>
                        <span className="dc-tile__label"><I.Code />Scripts open</span>
                        <span className="dc-tile__value">1</span>
                    </button>
                </div>

                <div className="dc-actions">
                    <Btn onClick={() => onGo("editor")}><I.Plus />New script</Btn>
                    <Btn solid disabled={!stopped.length} onClick={onLaunchAll}>
                        <I.Play />Launch all{stopped.length ? ` (${stopped.length})` : ""}
                    </Btn>
                    {running.length > 0 && <Btn onClick={onStopAll}><I.Stop />Stop all</Btn>}
                    <Btn onClick={() => onGo("accounts")}><I.Users />Add account</Btn>
                    <Btn className="dc-push" onClick={() => onGo("settings")}><I.Gear />Settings</Btn>
                </div>

                <div className="dc-cols">
                    <div className="dc-stack">
                        <section className="dc-card">
                            <PanelHead
                                icon={I.Rocket} title="Autoexec" count={AUTOEXEC.length}
                                right={<><Btn sm onClick={() => onGo("editor")}>Refresh</Btn><Btn sm onClick={() => onGo("editor")}>Open folder</Btn></>}
                            />
                            <ul className="dc-list">
                                {AUTOEXEC.map((name, i) => (
                                    <li key={name}>
                                        <button type="button" className="dc-row dc-rule-b" onClick={() => onGo("editor")}>
                                            <span className="dc-row__n">{i + 1}</span>
                                            <span className="dc-row__name dc-mono">{name}</span>
                                            <span className="dc-row__meta">every instance</span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </section>

                        <section className="dc-card">
                            <PanelHead icon={I.File} title="Recent scripts" count={1} />
                            <ul className="dc-list">
                                <li>
                                    <button type="button" className="dc-row dc-rule-b" onClick={() => onGo("editor")}>
                                        <I.File className="dc-row__icon" />
                                        <span className="dc-row__name dc-mono">untitled.lua</span>
                                        <span className="dc-row__meta">{scriptLines} ln · just now</span>
                                    </button>
                                </li>
                            </ul>
                        </section>
                    </div>

                    <section className="dc-card">
                        <PanelHead
                            icon={I.Users} title="Instances" count={accounts.length}
                            right={accounts.length > 8 && <Btn sm onClick={() => onGo("accounts")}>All {accounts.length}</Btn>}
                        />
                        <ul className="dc-list">
                            {accounts.slice(0, 8).map((a) => (
                                <li key={a.name}>
                                    <button type="button" className="dc-row dc-rule-b" onClick={() => onGo("accounts")}>
                                        <Lamp sm tone={a.busy ? "busy" : a.running ? "live" : "off"} pulse={Boolean(a.busy)} />
                                        <span className="dc-row__name">{a.name}</span>
                                        {a.running && a.mode && <Chip tone="live" cap>{a.mode}</Chip>}
                                        <span className="dc-row__meta">{a.busy ? `${a.busy}…` : a.running ? "Running" : "Stopped"}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </section>
                </div>
            </div>
        </div>
    );
}

/* ----------------------------------------------------------------- Editor */

/* Editing smarts — ported from the app's own CodeSurface (EditorView.jsx):
   auto-closing pairs (wrap the selection, step over the closer, Backspace
   eats both halves of a fresh pair), Enter auto-indent, and a completion
   menu (letters open it, Ctrl+Space forces it, arrows + Enter/Tab drive
   it). Same word lists as the app's lua.js, trimmed. */
const PAIR = { "(": ")", "[": "]", "{": "}", '"': '"', "'": "'" };
const CLOSERS = new Set([")", "]", "}"]);
const WORD_CH = /[A-Za-z0-9_]/;

const KIND_STYLE = {
    kw: { tag: "k", cls: "dc-kind-kw" },
    fn: { tag: "f", cls: "dc-kind-fn" },
    prop: { tag: "m", cls: "dc-kind-prop" },
    var: { tag: "v", cls: "dc-kind-var" },
};

const COMPLETE_KEYWORDS = [
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function",
    "goto", "if", "in", "local", "nil", "not", "or", "repeat", "return",
    "then", "true", "until", "while",
];
const COMPLETE_BUILTINS = [
    "print", "pairs", "ipairs", "next", "type", "tostring", "tonumber",
    "require", "pcall", "xpcall", "error", "assert", "select", "setmetatable",
    "getmetatable", "coroutine", "table", "string", "math", "os", "utf8",
    "debug", "_G", "game", "workspace", "script", "wait", "task", "spawn",
    "delay", "tick", "Instance", "Vector3", "Vector2", "CFrame", "Color3",
    "UDim2", "Enum", "typeof", "warn", "getgenv", "loadstring",
];
const LUA_MEMBERS = {
    string: ["byte", "char", "find", "format", "gmatch", "gsub", "len", "lower", "match", "rep", "reverse", "split", "sub", "upper"],
    table: ["concat", "insert", "remove", "sort", "unpack", "pack", "find", "clear", "clone", "create", "freeze"],
    math: ["abs", "ceil", "clamp", "cos", "deg", "exp", "floor", "fmod", "huge", "log", "max", "min", "pi", "pow", "rad", "random", "randomseed", "round", "sign", "sin", "sqrt", "tan"],
    os: ["clock", "date", "difftime", "time"],
    coroutine: ["create", "resume", "running", "status", "wrap", "yield", "close"],
    task: ["cancel", "defer", "delay", "spawn", "wait"],
    game: ["GetService", "FindFirstChild", "WaitForChild", "GetChildren", "GetDescendants", "HttpGet", "Players", "Workspace", "ReplicatedStorage", "Lighting", "PlaceId", "JobId", "IsLoaded"],
    workspace: ["FindFirstChild", "WaitForChild", "GetChildren", "GetDescendants", "CurrentCamera", "Gravity"],
    Instance: ["new"],
    Vector3: ["new", "zero", "one", "xAxis", "yAxis", "zAxis"],
    Vector2: ["new", "zero", "one"],
    CFrame: ["new", "Angles", "fromEulerAnglesXYZ", "lookAt", "identity"],
    Color3: ["new", "fromRGB", "fromHSV", "fromHex"],
    UDim2: ["new", "fromScale", "fromOffset"],
    debug: ["traceback", "info"],
    utf8: ["char", "codepoint", "len", "offset"],
};

/* Completion candidates for the word `prefix` ending at `caret`. After a `.`
   or `:` the menu is members — the curated list merged with every `base.x`
   the buffer already contains. Otherwise keywords + builtins + the buffer's
   own identifiers. `force` (Ctrl+Space) opens even on an empty word. */
function completionsFor(source, caret, prefix, force = false) {
    const before = source.slice(0, caret - prefix.length);
    const member = before.match(/([A-Za-z_]\w*)\s*[.:]$/);
    const seen = new Set();
    const items = [];
    const push = (label, kind) => {
        if (label === prefix || seen.has(label)) return;
        if (prefix && !label.toLowerCase().startsWith(prefix.toLowerCase())) return;
        seen.add(label);
        items.push({ label, kind });
    };
    if (member) {
        for (const m of LUA_MEMBERS[member[1]] || []) push(m, "prop");
        const used = new RegExp(`\\b${member[1]}\\s*[.:]([A-Za-z_]\\w*)`, "g");
        for (const m of source.matchAll(used)) push(m[1], "prop");
    } else {
        if (!prefix && !force) return [];
        for (const k of COMPLETE_KEYWORDS) push(k, "kw");
        for (const b of COMPLETE_BUILTINS) push(b, "fn");
        for (const m of source.matchAll(/[A-Za-z_]\w{2,}/g)) push(m[0], "var");
    }
    items.sort((a, b) => a.label.length - b.label.length || a.label.localeCompare(b.label));
    return items.slice(0, 8);
}

function EditorTab({ running, code, onCode }) {
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [results, setResults] = useState(null);
    const [caret, setCaret] = useState({ line: 1, col: 1 });
    const [menu, setMenu] = useState(null); // { items, index, prefix, left, top }
    const menuKeyRef = useRef(false); // keyup after a menu-nav keydown must not refilter
    const charWRef = useRef(0);
    const inputRef = useRef(null);
    const layerRef = useRef(null);
    const gutterRef = useRef(null);
    const timers = useRef([]);
    useEffect(() => () => timers.current.forEach(clearTimeout), []);

    const lines = useMemo(() => code.split("\n"), [code]);

    // One glyph's width — strictly monospace, so caret pixels are arithmetic.
    const charWidth = () => {
        if (!charWRef.current) {
            const st = getComputedStyle(inputRef.current);
            const ctx = document.createElement("canvas").getContext("2d");
            ctx.font = `${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
            charWRef.current = ctx.measureText("M").width || 8;
        }
        return charWRef.current;
    };

    const sync = () => {
        const input = inputRef.current;
        if (!input) return;
        if (layerRef.current) {
            layerRef.current.scrollTop = input.scrollTop;
            layerRef.current.scrollLeft = input.scrollLeft;
        }
        if (gutterRef.current) gutterRef.current.scrollTop = input.scrollTop;
    };

    const updateCaret = () => {
        const input = inputRef.current;
        if (!input) return;
        const upto = input.value.slice(0, input.selectionStart).split("\n");
        setCaret({ line: upto.length, col: upto[upto.length - 1].length + 1 });
    };

    // execCommand keeps the native undo stack alive; fall back if unavailable.
    const insertText = (text) => {
        const input = inputRef.current;
        if (!document.execCommand("insertText", false, text)) {
            input.setRangeText(text, input.selectionStart, input.selectionEnd, "end");
            onCode(input.value);
        }
    };

    /* Build (or close) the completion menu for the word at the caret,
       anchored under that word's first character. */
    const openMenu = (force = false) => {
        const input = inputRef.current;
        if (!input || input.selectionStart !== input.selectionEnd) return setMenu(null);
        const at = input.selectionStart;
        const text = input.value;
        const prefix = (text.slice(0, at).match(/[A-Za-z_]\w*$/) || [""])[0];
        const items = completionsFor(text, at, prefix, force);
        if (!items.length) return setMenu(null);
        const upTo = text.slice(0, at - prefix.length);
        const line0 = (upTo.match(/\n/g) || []).length;
        const lineText = upTo.slice(upTo.lastIndexOf("\n") + 1);
        let col = 0; // visual column — tabs render 4 wide
        for (const ch of lineText) col += ch === "\t" ? 4 - (col % 4) : 1;
        const PAD_Y = 16, LINE_H = 22, WIDTH = 230;
        const box = input.parentElement;
        const height = items.length * 25 + 8;
        const left = Math.max(4, Math.min(col * charWidth() - input.scrollLeft, box.clientWidth - WIDTH - 4));
        let top = PAD_Y + (line0 + 1) * LINE_H - input.scrollTop + 2;
        if (top + height > box.clientHeight - 4) top = PAD_Y + line0 * LINE_H - input.scrollTop - height - 2;
        setMenu({ items, index: 0, prefix, left, top });
    };

    const accept = (item) => {
        insertText(item.label.slice(menu.prefix.length));
        setMenu(null);
        updateCaret();
    };

    const execute = () => {
        setMenu(null);
        setBusy(true);
        timers.current.push(setTimeout(() => {
            const m = code.match(/print\s*\(\s*(["'])([\s\S]*?)\1\s*\)/);
            const out = m ? m[2] : "ok · script ran";
            setBusy(false);
            setResults(running.map((a) => ({ name: a.name, text: out })));
        }, 650));
    };
    const copy = () => {
        try { navigator.clipboard?.writeText(code); } catch { /* demo — best effort */ }
        setCopied(true);
        timers.current.push(setTimeout(() => setCopied(false), 1200));
    };

    const onKeyDown = (e) => {
        const input = inputRef.current;
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (running.length && !busy) execute();
            return;
        }
        if (e.ctrlKey && e.code === "Space") {
            e.preventDefault();
            openMenu(true);
            return;
        }
        if (menu) {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                menuKeyRef.current = true;
                const step = e.key === "ArrowDown" ? 1 : -1;
                setMenu((m) => m && { ...m, index: (m.index + step + m.items.length) % m.items.length });
                return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                menuKeyRef.current = true;
                accept(menu.items[menu.index]);
                return;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                menuKeyRef.current = true;
                setMenu(null);
                return;
            }
        }
        const s = input.selectionStart;
        const t = input.selectionEnd;
        const prev = input.value[s - 1] || "";
        const next = input.value[t] || "";
        // Step over the closer (or closing quote) auto-close already placed.
        if (s === t && next === e.key && (CLOSERS.has(e.key) || PAIR[e.key] === e.key)) {
            e.preventDefault();
            input.setSelectionRange(s + 1, s + 1);
            updateCaret();
            return;
        }
        if (PAIR[e.key]) {
            const isQuote = PAIR[e.key] === e.key;
            if (s !== t) {
                // Wrap the selection instead of overtyping it.
                e.preventDefault();
                const inner = input.value.slice(s, t);
                insertText(e.key + inner + PAIR[e.key]);
                input.setSelectionRange(s + 1, s + 1 + inner.length);
                return;
            }
            // A quote against a word (it's, don't) stays a lone quote.
            if (isQuote && (WORD_CH.test(prev) || WORD_CH.test(next))) return;
            e.preventDefault();
            insertText(e.key + PAIR[e.key]);
            input.setSelectionRange(s + 1, s + 1);
            return;
        }
        // Deleting an opener takes its untouched closer with it.
        if (e.key === "Backspace" && s === t && s > 0 && PAIR[prev] === next && next !== "") {
            e.preventDefault();
            input.setSelectionRange(s - 1, s + 1);
            if (!document.execCommand("delete")) {
                input.setRangeText("", s - 1, s + 1, "end");
                onCode(input.value);
            }
            updateCaret();
            return;
        }
        if (e.key === "Tab") {
            e.preventDefault();
            insertText("    ");
            return;
        }
        if (e.key === "Enter") {
            e.preventDefault();
            const before = input.value.slice(0, s);
            const currentLine = before.slice(before.lastIndexOf("\n") + 1);
            const indent = (currentLine.match(/^[ \t]*/) || [""])[0];
            // Enter inside a fresh pair puts the closer on its own line, the
            // caret indented on the line between.
            if ((prev === "{" && next === "}") || (prev === "(" && next === ")")) {
                insertText("\n" + indent + "    \n" + indent);
                const mid = s + 1 + indent.length + 4;
                input.setSelectionRange(mid, mid);
                updateCaret();
                return;
            }
            const opensBlock = /\b(function|then|do|repeat|else)\s*$|[{(]\s*$/.test(currentLine);
            insertText("\n" + indent + (opensBlock ? "    " : ""));
        }
    };

    /* The menu lives off keyUP: by then the character is in the buffer, so
       the word under the caret is current. */
    const onKeyUp = (e) => {
        updateCaret();
        if (menuKeyRef.current) {
            menuKeyRef.current = false;
            return;
        }
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key.length === 1 || e.key === "Backspace") openMenu();
        else if (menu) setMenu(null);
    };

    return (
        <div className="dc-editor dc-rise">
            <div className="dc-edtabs dc-rule-b">
                <span className="dc-edtab is-active">untitled.lua</span>
                <IconBtn label="New script"><I.Plus /></IconBtn>
                <div className="dc-edtabs__tools">
                    <span className="dc-select">
                        <select className="dc-edtarget" defaultValue="all" aria-label="Run target">
                            <option value="all">Every running instance</option>
                            {running.map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
                        </select>
                    </span>
                    <IconBtn label="Save to autoexec"><I.Rocket /></IconBtn>
                    <IconBtn label={copied ? "Copied" : "Copy script"} onClick={copy}>
                        {copied ? <I.Check style={{ color: "var(--dc-live)" }} /> : <I.Copy />}
                    </IconBtn>
                    <IconBtn label="Clear results" tone="danger" onClick={() => setResults(null)}><I.Eraser /></IconBtn>
                    <Btn solid sm disabled={busy || !running.length} onClick={execute} style={{ marginLeft: 4 }}>
                        <I.Play style={{ width: 12, height: 12 }} />{busy ? "Running…" : "Execute"}
                    </Btn>
                </div>
            </div>

            <div className="dc-editor__surface">
                <div ref={gutterRef} className="dc-gutter" aria-hidden="true">
                    {lines.map((_, i) => (
                        <div key={i} className={i + 1 === caret.line ? "is-caret" : undefined}>{i + 1}</div>
                    ))}
                </div>
                <div className="dc-editwrap">
                    <pre ref={layerRef} className="dc-codelayer" aria-hidden="true">
                        {lines.map((line, i) => <CodeLine key={i} text={line} k={i} />)}
                    </pre>
                    <textarea
                        ref={inputRef}
                        className="dc-codeinput"
                        value={code}
                        onChange={(e) => { onCode(e.target.value); updateCaret(); }}
                        onScroll={sync}
                        onKeyDown={onKeyDown}
                        onKeyUp={onKeyUp}
                        onSelect={updateCaret}
                        onClick={() => { updateCaret(); setMenu(null); }}
                        onBlur={() => setMenu(null)}
                        onWheel={() => menu && setMenu(null)}
                        spellCheck={false}
                        autoComplete="off"
                        autoCorrect="off"
                        autoCapitalize="off"
                        wrap="off"
                        aria-label="Lua script"
                    />

                    {/* Completion menu, anchored under the word it completes.
                        mousedown (not click) accepts, so the textarea never
                        loses focus. */}
                    {menu && (
                        <div className="dc-editmenu" role="listbox" aria-label="Completions" style={{ left: menu.left, top: menu.top }}>
                            {menu.items.map((item, i) => (
                                <button
                                    key={item.label}
                                    type="button"
                                    role="option"
                                    aria-selected={i === menu.index}
                                    className={i === menu.index ? "is-active" : undefined}
                                    onMouseDown={(e) => { e.preventDefault(); accept(item); }}
                                    onMouseEnter={() => setMenu((m) => m && { ...m, index: i })}
                                >
                                    <span className={`dc-editmenu__kind ${KIND_STYLE[item.kind].cls}`}>{KIND_STYLE[item.kind].tag}</span>
                                    <span className="dc-editmenu__label">
                                        <b>{item.label.slice(0, menu.prefix.length)}</b>
                                        {item.label.slice(menu.prefix.length)}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {results && (
                <div className="dc-edresults dc-rule-t">
                    {results.map((r) => (
                        <div key={r.name} className="dc-edresults__row">
                            <span>{r.name}</span>
                            <span style={{ color: "var(--dc-live)" }}>{r.text}</span>
                        </div>
                    ))}
                </div>
            )}

            <div className="dc-edstatus dc-rule-t">
                <span><Lamp sm tone="live" /> Engine ready</span>
                <span>Ln {caret.line}, Col {caret.col}</span>
                <span className="dc-push">{running.length} {running.length === 1 ? "instance" : "instances"}</span>
                <span>Lua</span>
                <span>UTF-8</span>
            </div>
        </div>
    );
}

/* --------------------------------------------------------------- Accounts */

function AccountsTab({ accounts, launch, onLaunch, onStart, onStop, onStartMany, onStopMany }) {
    const [selected, setSelected] = useState(null);
    const [checked, setChecked] = useState(() => new Set());
    const [query, setQuery] = useState("");

    const visible = accounts.filter((a) => a.name.toLowerCase().includes(query.trim().toLowerCase()));
    const selectedAccount = accounts.find((a) => a.name === selected) || null;
    const bulk = [...checked].map((n) => accounts.find((a) => a.name === n)).filter(Boolean);
    const bulkStopped = bulk.filter((a) => !a.running && !a.busy);
    const bulkRunning = bulk.filter((a) => a.running);

    const toggle = (name, on) =>
        setChecked((prev) => {
            const next = new Set(prev);
            if (on) next.add(name); else next.delete(name);
            return next;
        });

    const status = (a) =>
        a.busy ? `${a.busy}…`
        : !a.running ? "Stopped"
        : a.win ? `Window ${a.win[0]}×${a.win[1]} · ADB ${a.adb}`
        : `VNC ${a.vnc} · ADB ${a.adb}`;

    return (
        <div className="dc-view">
            <div className="dc-accounts dc-rise" style={{ height: "100%" }}>
                <section className="dc-card" style={{ display: "flex", flexDirection: "column", minHeight: 0, maxHeight: 552 }}>
                    <PanelHead
                        icon={I.Users} title="Accounts" count={accounts.length}
                        right={
                            <>
                                <span style={{ position: "relative" }}>
                                    <I.Search style={{ position: "absolute", top: "50%", left: 10, width: 14, height: 14, transform: "translateY(-50%)", color: "var(--dc-ink-3)", pointerEvents: "none" }} />
                                    <input
                                        className="dc-input"
                                        style={{ height: 28, width: 132, padding: "0 10px 0 30px", fontSize: 13, borderRadius: 14 }}
                                        placeholder="Filter"
                                        aria-label="Filter accounts"
                                        value={query}
                                        onChange={(e) => setQuery(e.target.value)}
                                    />
                                </span>
                                <Btn sm><I.UserPlus />Create account</Btn>
                                <Btn solid sm><I.Plus />Add account</Btn>
                            </>
                        }
                    />
                    <ul className="dc-list" style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                        {visible.map((a) => (
                            <li key={a.name}>
                                <div
                                    role="button"
                                    tabIndex={0}
                                    className={`dc-row dc-rule-b dc-acct is-click${selected === a.name ? " is-selected" : ""}`}
                                    onClick={() => setSelected(a.name)}
                                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelected(a.name); } }}
                                >
                                    <input
                                        type="checkbox"
                                        className="dc-check"
                                        checked={checked.has(a.name)}
                                        aria-label={`Select ${a.name}`}
                                        onClick={(e) => e.stopPropagation()}
                                        onChange={(e) => toggle(a.name, e.target.checked)}
                                    />
                                    <span className="dc-acct__initials" aria-hidden="true">{initials(a.name)}</span>
                                    <div className="dc-acct__body">
                                        <div className="dc-acct__title">
                                            <span>{a.name}</span>
                                            <Chip upper tone={a.arch === "arm" ? "accent" : undefined}>{a.arch}</Chip>
                                            <Chip>{a.base}</Chip>
                                            {a.running && a.mode && <Chip tone="live" cap>{a.mode}</Chip>}
                                        </div>
                                        <div className="dc-acct__status">
                                            <Lamp sm tone={a.busy ? "busy" : a.running ? "live" : "off"} pulse={Boolean(a.busy)} />
                                            <span>{status(a)}</span>
                                        </div>
                                    </div>
                                    <div className="dc-acct__buttons" onClick={(e) => e.stopPropagation()}>
                                        {a.running ? (
                                            <>
                                                <IconBtn label="Open viewer" tone="accent"><I.Monitor /></IconBtn>
                                                <IconBtn label="Stop instance" disabled={Boolean(a.busy)} onClick={() => onStop(a.name)}><I.Stop style={{ width: 14, height: 14 }} /></IconBtn>
                                            </>
                                        ) : (
                                            <IconBtn label="Start instance" tone="accent" disabled={Boolean(a.busy)} onClick={() => onStart(a.name)}>
                                                <I.Play style={{ width: 14, height: 14 }} />
                                            </IconBtn>
                                        )}
                                        <IconBtn label="Remove account" tone="danger" disabled={Boolean(a.busy)}><I.Trash /></IconBtn>
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>

                <section className="dc-card" style={{ maxHeight: 552, display: "flex", flexDirection: "column" }}>
                    <PanelHead icon={I.Rocket} title="Launch" />
                    <div className="dc-bay" style={{ overflowY: "auto" }}>
                        <Field label="Mode" hint={launch.mode === "farming" ? "Headless, minimal footprint — built to run by the dozen." : "A visible window with native keyboard and mouse."}>
                            <span className="dc-select">
                                <select className="dc-input" value={launch.mode} onChange={(e) => onLaunch({ ...launch, mode: e.target.value })}>
                                    <option value="gaming">Gaming — playable window</option>
                                    <option value="farming">Farming — headless</option>
                                </select>
                            </span>
                        </Field>
                        <Field label="Graphics" hint="Auto takes the host GPU when one is usable.">
                            <span className="dc-select">
                                <select className="dc-input" value={launch.gpu} onChange={(e) => onLaunch({ ...launch, gpu: e.target.value })}>
                                    <option value="auto">Auto</option>
                                    <option value="host">Host GPU</option>
                                    <option value="soft">Software</option>
                                </select>
                            </span>
                        </Field>
                        <Field label="Place ID" hint="Leave empty to land on the Roblox home screen.">
                            <input
                                className="dc-input dc-mono"
                                style={{ fontSize: 13.5 }}
                                value={launch.place}
                                placeholder="8737899170"
                                spellCheck={false}
                                onChange={(e) => onLaunch({ ...launch, place: e.target.value })}
                            />
                        </Field>

                        <div className="dc-bay__foot dc-rule-t">
                            {bulk.length ? (
                                <>
                                    <Btn solid lg full disabled={!bulkStopped.length} onClick={() => onStartMany(bulkStopped.map((a) => a.name))}>
                                        <I.Play />Launch {bulkStopped.length} {bulkStopped.length === 1 ? "instance" : "instances"}
                                    </Btn>
                                    {bulkRunning.length > 0 && (
                                        <Btn lg full onClick={() => onStopMany(bulkRunning.map((a) => a.name))}>
                                            <I.Stop />Stop {bulkRunning.length} running
                                        </Btn>
                                    )}
                                    <p className="dc-bay__note">
                                        {bulkStopped.length
                                            ? `${bulk.length} selected · ${launch.mode} mode, all at once`
                                            : `${bulk.length} selected · all already running`}
                                    </p>
                                </>
                            ) : (
                                <>
                                    <Btn solid lg full disabled={!selectedAccount || Boolean(selectedAccount?.busy)}
                                        onClick={() => selectedAccount && !selectedAccount.running && onStart(selectedAccount.name)}>
                                        {selectedAccount?.running ? <><I.Monitor />Open viewer</> : <><I.Play />Launch</>}
                                    </Btn>
                                    <p className="dc-bay__note">
                                        {selectedAccount?.busy ? `${selectedAccount.busy} ${selectedAccount.name}…`
                                            : selectedAccount ? (selectedAccount.running ? `${selectedAccount.name} is running here.` : `Boots ${selectedAccount.name} in ${launch.mode} mode.`)
                                            : "Pick an account on the left, or tick several."}
                                    </p>
                                </>
                            )}
                        </div>
                    </div>
                </section>
            </div>
        </div>
    );
}

/* ---------------------------------------------------------------- Farming */

function FarmingTab({ accounts }) {
    const members = accounts.filter((a) => FARM_MEMBERS.includes(a.name));
    const runningHere = members.filter((a) => a.running);
    const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

    return (
        <div className="dc-view">
            <div className="dc-view__inner dc-rise">
                <div>
                    <h2 className="dc-h2">Farming<Chip tone="premium">Premium</Chip></h2>
                    <p className="dc-sub">The console for running many instances unattended.</p>
                </div>

                <div className="dc-stats">
                    <StatTile icon={I.Grid} label="In farm" value={members.length} />
                    <StatTile icon={I.HeartPulse} label="Running here" value={runningHere.length} live={runningHere.length > 0} />
                    <StatTile icon={I.Users} label="Stopped" value={members.length - runningHere.length} />
                    <StatTile icon={I.Users} label="Elsewhere" value={0} />
                </div>

                <section className="dc-card">
                    <PanelHead icon={I.Grid} title="Fleet" count={members.length} right={<Btn sm>Edit members</Btn>} />
                    <ul className="dc-list">
                        {members.map((a) => (
                            <li key={a.name}>
                                <div className="dc-row dc-rule-b">
                                    <Lamp sm tone={a.busy ? "busy" : a.running ? "live" : "off"} pulse={Boolean(a.busy)} />
                                    <span className="dc-row__name">{a.name}</span>
                                    {a.running && a.mode && <Chip tone="live" cap>{a.mode}</Chip>}
                                    <span className="dc-row__meta">{a.busy ? `${a.busy}…` : a.running ? "Running" : "Stopped"}</span>
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>

                <section className="dc-card">
                    <PanelHead icon={I.Clock} title="Schedule" right={<Chip>Not active yet</Chip>} />
                    <div className="dc-pad">
                        <div className="dc-daychips">
                            {DAYS.map((d) => <Chip key={d}>{d}</Chip>)}
                        </div>
                        <p className="dc-bay__note" style={{ textAlign: "left" }}>
                            Start and stop the farm on a clock. The controls arm once the
                            supervisor ships — nothing here pretends to fire yet.
                        </p>
                    </div>
                </section>
            </div>
        </div>
    );
}

function StatTile({ icon: Icon, label, value, live }) {
    return (
        <div className="dc-tile" style={{ cursor: "default" }}>
            <span className="dc-tile__label">{Icon && <Icon />}{label}</span>
            <span className={`dc-tile__value${live ? " is-live" : ""}`}>{value}</span>
        </div>
    );
}

/* -------------------------------------------------------------- Stat Track */

function StatTrackTab({ accounts, enabled, onToggle }) {
    const [open, setOpen] = useState("VelvetOtter912");
    const running = accounts.filter((a) => a.running);
    const tracking = enabled ? accounts.filter((a) => a.running && a.mode === "farming") : [];

    const metrics = (i) => [
        { label: "Gems", value: `${(12.4 + i * 1.7).toFixed(2)}M` },
        { label: "Coins", value: `${(34 + i * 3.2).toFixed(1)}k` },
        { label: "Level", value: `${12 + i}` },
    ];

    return (
        <div className="dc-view">
            <div className="dc-view__inner dc-rise">
                <div>
                    <h2 className="dc-h2">Stat Track<Chip tone="premium">Premium</Chip></h2>
                    <p className="dc-sub">What your accounts are actually earning, from inside the game.</p>
                </div>

                <section className="dc-card">
                    <div className="dc-pad">
                        <div className={`dc-toggle${enabled ? " is-on" : ""}`} role="switch" aria-checked={enabled} tabIndex={0}
                            onClick={() => onToggle(!enabled)}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(!enabled); } }}>
                            <span className="dc-toggle__text">
                                <b>Report stats from every launch</b>
                                <small>Arms at launch — an instance already running keeps its current setting.</small>
                            </span>
                            <span className="dc-toggle__track" />
                        </div>
                    </div>
                </section>

                <div className="dc-stats dc-stats--3">
                    <StatTile icon={I.Users} label="Accounts" value={accounts.length} />
                    <StatTile icon={I.Grid} label="Running" value={running.length} />
                    <StatTile icon={I.HeartPulse} label="Reporting" value={tracking.length} live={tracking.length > 0} />
                </div>

                <section className="dc-card">
                    <PanelHead icon={I.Chart} title="Accounts" count={accounts.length} />
                    <ul className="dc-list">
                        {accounts.slice(0, 6).map((a, i) => {
                            const isTracking = tracking.includes(a);
                            const expanded = open === a.name;
                            return (
                                <li key={a.name}>
                                    <button type="button" className="dc-row dc-rule-b" onClick={() => setOpen(expanded ? null : a.name)}>
                                        <Lamp sm tone={a.running ? "live" : "off"} />
                                        <span className="dc-row__name">{a.name}</span>
                                        {isTracking && <Chip tone="live">Pet Simulator 99</Chip>}
                                        {isTracking ? (
                                            <span className="dc-metrics">
                                                {metrics(i).map((m) => (
                                                    <span key={m.label} className="dc-metric"><b>{m.value}</b><span>{m.label}</span></span>
                                                ))}
                                            </span>
                                        ) : (
                                            <span className="dc-row__meta">{a.running ? "Not reporting" : "Stopped"}</span>
                                        )}
                                    </button>
                                    {expanded && isTracking && (
                                        <dl className="dc-details dc-rise">
                                            <div><dt>Roblox id</dt><dd>84021{330 + i}</dd></div>
                                            <div><dt>In game for</dt><dd>{47 + i * 9} min</dd></div>
                                            <div><dt>Last report</dt><dd>just now</dd></div>
                                            <div><dt>Executor</dt><dd>Omni</dd></div>
                                            <div><dt>Server</dt><dd>3f1a55c0…</dd></div>
                                            <div><dt>Reports</dt><dd>{112 + i * 41}</dd></div>
                                        </dl>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </section>
            </div>
        </div>
    );
}

/* ---------------------------------------------------------------- Network */

const NET_TARGETS = [
    { id: "roblox", label: "Roblox", url: "users.roblox.com", note: "Logins and joins go through this host.", mid: 420 },
    { id: "omni", label: "Omni server", url: "api.omniexecutor.app", note: "Sign-in, your account list and presence.", mid: 140 },
];

function NetworkTab() {
    const jitter = (mid) => Math.round(mid * (0.7 + Math.random() * 0.8));
    const [rows, setRows] = useState(() => NET_TARGETS.map((t) => ({ ...t, ms: jitter(t.mid) })));
    const [keep, setKeep] = useState(true);
    const [checking, setChecking] = useState(false);
    const timers = useRef([]);
    useEffect(() => () => timers.current.forEach(clearTimeout), []);

    const probe = () => {
        setChecking(true);
        timers.current.push(setTimeout(() => {
            setRows(NET_TARGETS.map((t) => ({ ...t, ms: jitter(t.mid) })));
            setChecking(false);
        }, 700));
    };

    return (
        <div className="dc-view">
            <div className="dc-view__inner dc-rise">
                <section className="dc-card">
                    <PanelHead
                        icon={I.Signal} title="Link check"
                        right={
                            <>
                                <span className="dc-silk dc-ink3">{checking ? "checking…" : "just now"}</span>
                                <Btn sm onClick={probe} disabled={checking}><I.Refresh />Check again</Btn>
                            </>
                        }
                    />
                    <ul className="dc-list">
                        {rows.map((t) => {
                            const slow = t.ms > 700;
                            return (
                                <li key={t.id}>
                                    <div className="dc-row dc-rule-b dc-net__row">
                                        <Lamp tone={checking ? "busy" : slow ? "warn" : "live"} pulse={checking} />
                                        <div className="dc-net__label" style={{ flex: 1, minWidth: 0 }}>
                                            <b>{t.label}</b>
                                            <small>{t.note}</small>
                                            <span className="dc-net__url">{t.url}</span>
                                        </div>
                                        <span className="dc-net__ms">
                                            <b style={{ color: slow ? "var(--dc-warn)" : "var(--dc-live)" }}>{checking ? "—" : `${t.ms} ms`}</b>
                                            <span>{checking ? "checking" : slow ? "slow" : "answers"}</span>
                                        </span>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                    <div className="dc-pad" style={{ paddingTop: 0 }}>
                        <div className={`dc-toggle${keep ? " is-on" : ""}`} role="switch" aria-checked={keep} tabIndex={0}
                            onClick={() => setKeep(!keep)}
                            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setKeep(!keep); } }}>
                            <span className="dc-toggle__text">
                                <b>Keep checking</b>
                                <small>Re-run the probes every minute while this tab is open.</small>
                            </span>
                            <span className="dc-toggle__track" />
                        </div>
                    </div>
                </section>

                <section className="dc-card">
                    <PanelHead icon={I.Route} title="Outbound proxy" right={<Chip>Off</Chip>} />
                    <div className="dc-pad">
                        <Field label="Proxy" hint="Instance traffic takes this detour when set. Leave empty to go direct.">
                            <input className="dc-input dc-mono" style={{ fontSize: 13 }} placeholder="host:port:user:pass" spellCheck={false} />
                        </Field>
                    </div>
                </section>
            </div>
        </div>
    );
}

/* --------------------------------------------------------------- Settings */

function SettingsTab({ theme, onTheme }) {
    const [name, setName] = useState("devflaryn");
    const [saved, setSaved] = useState(false);
    const timers = useRef([]);
    useEffect(() => () => timers.current.forEach(clearTimeout), []);

    const touch = (value) => {
        setName(value);
        setSaved(true);
        timers.current.push(setTimeout(() => setSaved(false), 1400));
    };

    return (
        <div className="dc-view">
            <div className="dc-view__inner dc-rise">
                <div className="dc-grid2" style={{ alignItems: "start" }}>
                    <div className="dc-stack">
                        <section className="dc-card">
                            <PanelHead icon={I.User} title="Profile"
                                right={<span className="dc-silk" style={{ color: "var(--dc-live)", opacity: saved ? 1 : 0, transition: "opacity .3s" }}>Saved</span>} />
                            <div className="dc-pad">
                                <Field label="Display name">
                                    <input className="dc-input" value={name} onChange={(e) => touch(e.target.value)} spellCheck={false} />
                                </Field>
                                <Field label="Status">
                                    <input className="dc-input" defaultValue="farming the fleet" spellCheck={false} />
                                </Field>
                            </div>
                        </section>

                        <section className="dc-card">
                            <PanelHead icon={I.Gear} title="Appearance" />
                            <div className="dc-pad">
                                <Field label="Theme" hint="The same sheet, re-pointed — every colour is a token.">
                                    <span className="dc-select">
                                        <select className="dc-input" value={theme} onChange={(e) => onTheme(e.target.value)} aria-label="Theme">
                                            <option value="dark">Night sheet</option>
                                            <option value="light">Daylight sheet</option>
                                        </select>
                                    </span>
                                </Field>
                            </div>
                        </section>

                        <section className="dc-card">
                            <PanelHead icon={I.Cpu} title="Engine" right={<Chip tone="live">Ready</Chip>} />
                            <div className="dc-pad" style={{ gap: 0 }}>
                                <dl className="dc-kv dc-rule-b" style={{ margin: 0 }}><dt>Contract</dt><dd>1.0</dd></dl>
                                <dl className="dc-kv dc-rule-b" style={{ margin: 0 }}><dt>QEMU</dt><dd>Yes</dd></dl>
                                <dl className="dc-kv dc-rule-b" style={{ margin: 0 }}><dt>adb</dt><dd>Yes</dd></dl>
                                <dl className="dc-kv" style={{ margin: 0 }}><dt>Base image</dt><dd>bliss-15</dd></dl>
                            </div>
                        </section>
                    </div>

                    <div className="dc-stack">
                        <section className="dc-card">
                            <PanelHead icon={I.Users} title="Account" right={<Chip tone="premium">Lifetime</Chip>} />
                            <div className="dc-pad" style={{ gap: 0 }}>
                                <dl className="dc-kv dc-rule-b" style={{ margin: 0 }}><dt>Username</dt><dd>devflaryn</dd></dl>
                                <dl className="dc-kv dc-rule-b" style={{ margin: 0 }}><dt>Signed in</dt><dd>dev•••@flaryn.gg</dd></dl>
                                <dl className="dc-kv" style={{ margin: 0 }}><dt>Server</dt><dd>api.omniexecutor.app</dd></dl>
                            </div>
                            <div className="dc-pad" style={{ paddingTop: 0 }}>
                                <Field label="License key" hint="This account is on the Lifetime plan — every key's credits still land.">
                                    <div style={{ display: "flex", gap: 8 }}>
                                        <input className="dc-input dc-mono" style={{ fontSize: 13 }} placeholder="OMNI-XXXX-XXXX-XXXX" spellCheck={false} />
                                        <Btn>Redeem</Btn>
                                    </div>
                                </Field>
                            </div>
                        </section>

                        <section className="dc-card">
                            <PanelHead icon={I.Monitor} title="This device" />
                            <div className="dc-pad" style={{ gap: 0 }}>
                                <dl className="dc-kv dc-rule-b" style={{ margin: 0 }}><dt>Name</dt><dd>DESKTOP-FLARYN</dd></dl>
                                <dl className="dc-kv dc-rule-b" style={{ margin: 0 }}><dt>Platform</dt><dd>Windows 11</dd></dl>
                                <dl className="dc-kv" style={{ margin: 0 }}><dt>Build</dt><dd>auto-updating</dd></dl>
                            </div>
                        </section>

                        <p className="dc-foot-version">Omni Executor · v2.0</p>
                    </div>
                </div>
            </div>
        </div>
    );
}
