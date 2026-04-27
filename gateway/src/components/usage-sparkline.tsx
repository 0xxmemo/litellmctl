interface UsageSparklineProps {
  /** Per-hour request counts, oldest → newest. */
  buckets: number[]
  width?: number
  height?: number
  className?: string
}

export function UsageSparkline({
  buckets,
  width = 96,
  height = 22,
  className,
}: UsageSparklineProps) {
  const total = buckets.reduce((a, b) => a + b, 0)
  const max = buckets.reduce((m, v) => (v > m ? v : m), 0)
  const gap = 1
  const barWidth = (width - gap * (buckets.length - 1)) / buckets.length

  const title = total === 0
    ? 'No requests in the last 24h'
    : `${total} request${total === 1 ? '' : 's'} in the last 24h`

  if (total === 0) {
    return (
      <div
        className={className}
        style={{ width, height }}
        title={title}
        aria-label={title}
      >
        <div
          style={{
            width: '100%',
            height: 1,
            marginTop: height / 2,
            background: 'currentColor',
            opacity: 0.15,
          }}
        />
      </div>
    )
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={title}
      className={className}
    >
      <title>{title}</title>
      {buckets.map((v, i) => {
        const h = max > 0 ? Math.max(1, (v / max) * height) : 0
        const x = i * (barWidth + gap)
        const y = height - h
        const opacity = v === 0 ? 0.18 : 0.55 + 0.45 * (v / max)
        return (
          <rect
            key={i}
            x={x}
            y={v === 0 ? height - 1 : y}
            width={barWidth}
            height={v === 0 ? 1 : h}
            fill="currentColor"
            opacity={opacity}
            rx={0.5}
          />
        )
      })}
    </svg>
  )
}
