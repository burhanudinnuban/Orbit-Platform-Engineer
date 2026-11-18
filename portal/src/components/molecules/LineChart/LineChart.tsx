import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react'
import type { Point } from '@/features/observability/observability.types'
import { formatClock } from '@/lib/format'

const PAD = { l: 56, r: 10, t: 12, b: 22 }

interface LineChartProps {
  title: string
  points: Point[]
  format: (v: number) => string
  tone?: 'accent' | 'failed' | 'warning' | 'success'
  height?: number
}

/** Responsive single-series line chart rendered as SVG, with a hover tooltip. */
export default function LineChart({
  title,
  points,
  format,
  tone = 'accent',
  height = 150,
}: LineChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(320)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const update = (w: number) => setWidth(Math.max(160, Math.floor(w)))
    update(el.getBoundingClientRect().width)
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w) update(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const data = useMemo(
    () =>
      points
        .filter(
          (p): p is Point =>
            Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])
        )
        .slice()
        .sort((a, b) => a[0] - b[0]),
    [points]
  )

  const geo = useMemo(() => {
    if (data.length === 0) return null
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (const [x, y] of data) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    minY = Math.min(0, minY)
    if (maxY <= minY) maxY = minY + 1
    else maxY += (maxY - minY) * 0.08
    const spanX = maxX - minX || 1
    const innerW = width - PAD.l - PAD.r
    const innerH = height - PAD.t - PAD.b
    const sx = (x: number) => PAD.l + ((x - minX) / spanX) * innerW
    const sy = (y: number) => PAD.t + (1 - (y - minY) / (maxY - minY)) * innerH
    const line = data
      .map(
        (p, i) =>
          `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`
      )
      .join('')
    const first = data[0]!
    const last = data[data.length - 1]!
    const baseY = sy(minY).toFixed(1)
    const area = `${line}L${sx(last[0]).toFixed(1)},${baseY}L${sx(first[0]).toFixed(1)},${baseY}Z`
    return { minX, maxX, minY, maxY, sx, sy, line, area }
  }, [data, width, height])

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    if (!geo || data.length === 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    // Binary search for the nearest point by x.
    let lo = 0
    let hi = data.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (geo.sx(data[mid]![0]) < x) lo = mid + 1
      else hi = mid
    }
    let idx = lo
    if (
      idx > 0 &&
      Math.abs(geo.sx(data[idx - 1]![0]) - x) <
        Math.abs(geo.sx(data[idx]![0]) - x)
    )
      idx -= 1
    setHover(idx)
  }

  const latest = data.length ? data[data.length - 1]![1] : undefined
  const hp = hover !== null ? data[hover] : undefined
  const midY = geo ? (geo.minY + geo.maxY) / 2 : 0

  return (
    <figure className={`chart chart-${tone}`}>
      <figcaption className="chart-head">
        <span className="chart-title">{title}</span>
        <span className="chart-value">
          {latest !== undefined ? format(latest) : '—'}
        </span>
      </figcaption>
      <div className="chart-body" ref={wrapRef}>
        {!geo ? (
          <div className="chart-empty" style={{ height }}>
            No data in this range
          </div>
        ) : (
          <>
            <svg
              width={width}
              height={height}
              className="chart-svg"
              onPointerMove={onMove}
              onPointerLeave={() => setHover(null)}
              role="img"
              aria-label={`${title}: latest ${latest !== undefined ? format(latest) : 'no data'}`}
            >
              {[geo.maxY, midY, geo.minY].map((v, i) => (
                <g key={i}>
                  <line
                    x1={PAD.l}
                    x2={width - PAD.r}
                    y1={geo.sy(v)}
                    y2={geo.sy(v)}
                    className={i === 2 ? 'chart-axis' : 'chart-gridline'}
                  />
                  {i !== 1 ? (
                    <text
                      x={PAD.l - 6}
                      y={geo.sy(v)}
                      className="chart-label"
                      textAnchor="end"
                      dominantBaseline="middle"
                    >
                      {format(v)}
                    </text>
                  ) : null}
                </g>
              ))}
              <text
                x={PAD.l}
                y={height - 6}
                className="chart-label"
                textAnchor="start"
              >
                {formatClock(geo.minX)}
              </text>
              <text
                x={width - PAD.r}
                y={height - 6}
                className="chart-label"
                textAnchor="end"
              >
                {formatClock(geo.maxX)}
              </text>
              <path d={geo.area} className="chart-area" />
              <path d={geo.line} className="chart-line" />
              {data.length === 1 ? (
                <circle
                  cx={geo.sx(data[0]![0])}
                  cy={geo.sy(data[0]![1])}
                  r={3}
                  className="chart-dot"
                />
              ) : null}
              {hp ? (
                <g>
                  <line
                    x1={geo.sx(hp[0])}
                    x2={geo.sx(hp[0])}
                    y1={PAD.t}
                    y2={height - PAD.b}
                    className="chart-cursor"
                  />
                  <circle
                    cx={geo.sx(hp[0])}
                    cy={geo.sy(hp[1])}
                    r={3.5}
                    className="chart-dot"
                  />
                </g>
              ) : null}
            </svg>
            {hp ? (
              <div
                className="chart-tip"
                style={{
                  left: Math.min(Math.max(geo.sx(hp[0]), 64), width - 64),
                  top: 4,
                }}
              >
                <strong>{format(hp[1])}</strong>
                <span>{formatClock(hp[0], true)}</span>
              </div>
            ) : null}
          </>
        )}
      </div>
    </figure>
  )
}
