/**
 * Sparkline / MultiSparkline — tiny static inline-SVG trend lines (PORTAL §5.2;
 * §24.69 D9).
 *
 * No chart library (the repo has zero by convention): polylines over a
 * normalized series in a fixed viewBox. Deterministic — no animation, no
 * randomness — so Playwright visual baselines are stable. Stroke inherits
 * `currentColor`, so a text-color class on the element (or per series) drives
 * the line color. `aria-hidden` because the numbers they accompany are the
 * real, screen-reader-visible signal. Fluid by default (`w-full`) — the `width`
 * prop is only the viewBox coordinate system for the point math.
 */
const PAD = 1 // keep the 1px stroke off the viewBox edges

/** Map a series to an SVG `points` string against a shared y-`max`. All-zero (or
 * max 0) → a flat baseline at the bottom (an honest "no spend"). */
function linePoints(values: number[], max: number, width: number, height: number): string {
  if (values.length === 0) return ''
  const usable = height - PAD * 2
  const stepX = values.length > 1 ? width / (values.length - 1) : 0
  return values
    .map((v, i) => {
      const x = i * stepX
      const y = max > 0 ? PAD + (1 - v / max) * usable : height - PAD
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')
}

function Line({ points, className }: { points: string; className?: string }) {
  return (
    <polyline
      points={points}
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinejoin="round"
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
      className={className}
    />
  )
}

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
  const points = linePoints(values, Math.max(...values, 0), width, height)
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ height }}
      className={['block w-full', className].filter(Boolean).join(' ')}
    >
      <Line points={points} />
    </svg>
  )
}

export interface SparkSeries {
  values: number[]
  /** A text-color class (e.g. `text-primary`) — `currentColor` drives the stroke. */
  className?: string
}

/**
 * Several series overlaid in one chart on a SHARED y-scale, so the lines are
 * directly comparable (a class spending 10× another sits 10× higher). Each
 * series carries its own color class.
 */
export function MultiSparkline({
  series,
  width = 240,
  height = 56,
  className,
}: {
  series: SparkSeries[]
  width?: number
  height?: number
  className?: string
}) {
  const max = Math.max(0, ...series.flatMap((s) => s.values))
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ height }}
      className={['block w-full', className].filter(Boolean).join(' ')}
    >
      {series.map((s, i) => (
        <Line key={i} points={linePoints(s.values, max, width, height)} className={s.className} />
      ))}
    </svg>
  )
}
