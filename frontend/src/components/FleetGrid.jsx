import { useMemo } from "react";

// The signature: a lattice of instance tiles behind the hero. Most sit idle;
// a scattered few glow magenta (running) or pulse violet (booting) — the fleet
// the product actually runs. Pure CSS animation, disabled under reduced motion.
export default function FleetGrid({ cols = 22, rows = 9 }) {
    const cells = useMemo(() => {
        const total = cols * rows;
        const out = [];
        for (let i = 0; i < total; i++) {
            const r = Math.random();
            let cls = "cell";
            if (r > 0.90)      cls += " is-live";
            else if (r > 0.83) cls += ` is-boot d${(i % 3) + 1}`;
            out.push(cls);
        }
        return out;
    }, [cols, rows]);

    return (
        <div className="fleet" aria-hidden="true">
            <div className="fleet__grid" style={{ "--cols": cols }}>
                {cells.map((c, i) => <div key={i} className={c} />)}
            </div>
        </div>
    );
}
