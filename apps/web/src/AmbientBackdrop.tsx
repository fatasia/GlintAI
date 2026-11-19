/**
 * Ambient studio backdrop: a warm key light under a slow violet aurora, plus a
 * hairline grid and static grain. Deliberately CSS-only (no WebGL or rAF loop)
 * so decoration never competes with preview playback or screenshot capture.
 */
export function AmbientBackdrop() {
  return <div aria-hidden="true" className="glint-ambient">
    <div className="glint-ambient-key" />
    <div className="glint-ambient-aurora-a" />
    <div className="glint-ambient-aurora-b" />
    <div className="glint-ambient-aurora-c" />
    <div className="glint-ambient-grid" />
    <div className="glint-ambient-grain" />
  </div>;
}
