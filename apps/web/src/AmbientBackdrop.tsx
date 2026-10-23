/**
 * Ambient aurora built from layered gradients and an SVG grain tile.
 * It is a shader-like approximation, deliberately not WebGL: decoration must
 * not burn a full-screen rAF loop or block automated screenshots.
 */
export function AmbientBackdrop() {
  return <div aria-hidden="true" style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", overflow: "hidden", background: "#08090b" }}>
    <style>{`
      .glint-ambient-a, .glint-ambient-b, .glint-ambient-sweep, .glint-ambient-grain { position: absolute; pointer-events: none; }
      .glint-ambient-a { width: 72vw; height: 64vh; left: 32%; top: -28%; background: radial-gradient(closest-side, rgba(92,116,255,.36), rgba(92,116,255,0)); filter: blur(44px); animation: glint-ambient-a 26s ease-in-out infinite alternate; }
      .glint-ambient-b { width: 58vw; height: 58vh; left: -16%; top: 34%; background: radial-gradient(closest-side, rgba(168,85,247,.20), rgba(168,85,247,0)); filter: blur(54px); animation: glint-ambient-b 34s ease-in-out infinite alternate; }
      .glint-ambient-sweep { inset: -35%; background: conic-gradient(from 120deg at 50% 50%, transparent 0 56%, rgba(124,140,255,.10) 68%, transparent 80%); mix-blend-mode: screen; animation: glint-ambient-spin 48s linear infinite; }
      .glint-ambient-grain { inset: 0; opacity: .045; mix-blend-mode: overlay; background-size: 180px 180px; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.6'/%3E%3C/svg%3E"); }
      @keyframes glint-ambient-a { from { transform: translate3d(-4%, 0, 0) scale(1); } to { transform: translate3d(6%, 4%, 0) scale(1.12); } }
      @keyframes glint-ambient-b { from { transform: translate3d(0, 2%, 0) scale(1.05); } to { transform: translate3d(5%, -5%, 0) scale(1); } }
      @keyframes glint-ambient-spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .glint-ambient-a, .glint-ambient-b, .glint-ambient-sweep { animation: none; } }
      @media (max-width: 640px) { .glint-ambient-a, .glint-ambient-b { filter: blur(28px); } .glint-ambient-sweep { display: none; } }
      @media (update: slow) { .glint-ambient-a, .glint-ambient-b { animation: none; filter: blur(28px); } .glint-ambient-sweep { display: none; } }
    `}</style>
    <div className="glint-ambient-a" />
    <div className="glint-ambient-b" />
    <div className="glint-ambient-sweep" />
    <div className="glint-ambient-grain" />
  </div>;
}
