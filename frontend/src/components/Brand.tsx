/**
 * Brand — pktFLOW identity in the Foundation visual language.
 *
 * The functional idea of the original mark is preserved: the diagram still
 * says the same thing about what this app does. Only the execution changes —
 * hairline strokes and a concentric survey ring instead of filled shapes,
 * gold as the system channel, and a single ice-blue element marking the
 * live/data part of the diagram.
 */

export function BrandMark({ size = 32, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      className={className}
      aria-hidden="true"
    >
  <circle cx="32" cy="32" r="30" stroke="rgba(216,180,110,.16)"/>
  <circle cx="32" cy="32" r="30" stroke="rgba(216,180,110,.5)" strokeDasharray="1.5 11"/>
  <path d="M13 25 H45" stroke="#f5e2b6" strokeWidth="1.4" strokeLinecap="round"/>
  <path d="M38 18.5 L45 25 L38 31.5" stroke="#f5e2b6" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
  <path d="M51 39 H19" stroke="#8ad8ea" strokeWidth="1.4" strokeLinecap="round"/>
  <path d="M26 32.5 L19 39 L26 45.5" stroke="#8ad8ea" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
  <path d="M13 32 H27" stroke="rgba(216,180,110,.45)" strokeWidth="1" strokeDasharray="2 4"/>
  <path d="M37 32 H51" stroke="rgba(138,216,234,.4)" strokeWidth="1" strokeDasharray="2 4"/>
  <circle cx="13" cy="25" r="1.8" fill="#f5e2b6"/>
  <circle cx="51" cy="39" r="1.8" fill="#8ad8ea"/>
    </svg>
  )
}

/** Full lockup — mark + wordmark. Pass descriptor={null} for tight spots. */
export function BrandLockup({
  markSize = 30,
  className = '',
  descriptor = 'Flow Analytics',
}: {
  markSize?: number
  className?: string
  descriptor?: string | null
}) {
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <BrandMark size={markSize} className="flex-none" />
      <div className="leading-tight min-w-0">
        <div className="flex items-baseline gap-[3px]">
          <span className="font-mono text-[10px] text-gray-400" style={{ letterSpacing: '0.26em' }}>
            pkt
          </span>
          <span className="font-mono text-blue-300" style={{ fontSize: '15px', letterSpacing: '0.2em' }}>
            FLOW
          </span>
        </div>
        {descriptor && (
          <div className="f-lbl mt-[3px]" style={{ letterSpacing: '0.32em' }}>
            {descriptor}
          </div>
        )}
      </div>
    </div>
  )
}

export default BrandLockup
