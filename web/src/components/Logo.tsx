/*
 * The AVAL lockup (figure + wordmark). Until the vector arrives this is a
 * transparent PNG of white art; light theme inverts it to black via CSS.
 */
export default function Logo({ className = '', label = 'AVAL' }: { className?: string; label?: string }) {
  return <img src="/logo-lockup.png" alt={label} className={`logo ${className}`} draggable={false} />
}
