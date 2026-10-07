/*
 * The AVAL lockup (figure + wordmark), from the brand files aval_black.svg and
 * aval_white.svg. Those SVGs wrap a raster, so the art ships as two trimmed
 * transparent PNGs; CSS shows the one that matches the theme, with no flash.
 */
export default function Logo({ className = '', label = 'AVAL' }: { className?: string; label?: string }) {
  return (
    <span className={`logo ${className}`} role="img" aria-label={label}>
      <img src="/logo-lockup.png" alt="" className="logo__dark" draggable={false} />
      <img src="/logo-lockup-light.png" alt="" className="logo__light" draggable={false} />
    </span>
  )
}
