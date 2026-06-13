/**
 * Sparkline — a tiny static inline-SVG trend line (PORTAL §5.2; §24.69 D9).
 *
 * No chart library (the repo has zero by convention): a single polyline over a
 * normalized series in a fixed viewBox. Deterministic — no animation, no
 * randomness — so Playwright visual baselines are stable. The stroke inherits
 * `currentColor`, so the parent's text color drives it. `aria-hidden` because
 * the numeric value it accompanies is the real, screen-reader-visible signal.
 */
export function Sparkline({
  values,
  width = 72,
  height = 18,
  className,
}: {
  values: number[]
  width?: number
  height?: number
  className?: string
}) {
  if (values.length === 0) return null
  const max = Math.max(...values, 0)
  const pad = 1 // keep the 1px stroke off the viewBox edges
  const usable = height - pad * 2
  const stepX = values.length > 1 ? width / (values.length - 1) : 0
  const points = values
    .map((v, i) => {
      const x = i * stepX
      // All-zero series → a flat baseline at the bottom (an honest "no spend").
      const y = max > 0 ? pad + (1 - v / max) * usable : height - pad
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      className={className}
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
