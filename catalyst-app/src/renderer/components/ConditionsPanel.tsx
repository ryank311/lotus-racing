// CONDITIONS — a pit-wall meteorological instrument cluster for the Analysis
// page. Each selected session becomes an instrument card whose accent colour is
// driven by air temperature (a thermal ramp from ice-cyan → red), with a custom
// wind-compass gauge and the session's best lap + Δ vs the fastest session so
// pace-vs-conditions correlation is legible at a glance.

import { useState } from 'react'
import { msToLap } from '../api'
import { useUnits } from '../units'
import type { AnalysisData } from '../../garmin/analysisData'

type SessionConditions = AnalysisData['sessions'][number]

// ── thermal colour ramp ─────────────────────────────────────────────────────
// Cold → hot, anchored to the app palette. Interpolated in sRGB; close enough
// for an accent and keeps the stops recognisably "instrument".
const THERMAL_STOPS: Array<[number, [number, number, number]]> = [
  [0.0, [125, 211, 252]], // --cyan   (cold)
  [0.32, [93, 209, 127]], // --green
  [0.6, [245, 166, 35]],  // --amber
  [0.82, [255, 94, 58]],  // --signal
  [1.0, [255, 71, 87]],   // --red    (hot)
]

function thermalColor(t01: number): string {
  const t = Math.max(0, Math.min(1, t01))
  for (let i = 0; i < THERMAL_STOPS.length - 1; i++) {
    const [a, ca] = THERMAL_STOPS[i]
    const [b, cb] = THERMAL_STOPS[i + 1]
    if (t >= a && t <= b) {
      const f = b === a ? 0 : (t - a) / (b - a)
      const c = ca.map((v, k) => Math.round(v + (cb[k] - v) * f))
      return `rgb(${c[0]}, ${c[1]}, ${c[2]})`
    }
  }
  return 'rgb(245, 166, 35)'
}

const COMPASS_16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
function compass(deg: number | null): string {
  if (deg == null || Number.isNaN(deg)) return '—'
  return COMPASS_16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16]
}

// ── wind compass gauge ──────────────────────────────────────────────────────
// 16 ticks (cardinals longer), an N marker, and a needle pointing in the
// wind-FROM direction with the session's thermal colour. Speed sits in the hub.
function WindCompass({ deg, speed, unit, color }: { deg: number | null; speed: number | null; unit: string; color: string }) {
  const C = 50
  const hasWind = speed != null && !Number.isNaN(speed)
  const hasDir = deg != null && !Number.isNaN(deg)

  const ticks = Array.from({ length: 16 }, (_, i) => {
    const a = (i * 22.5 - 90) * (Math.PI / 180)
    const cardinal = i % 4 === 0
    const r0 = cardinal ? 33 : 37
    const r1 = 42
    return {
      x1: C + Math.cos(a) * r0, y1: C + Math.sin(a) * r0,
      x2: C + Math.cos(a) * r1, y2: C + Math.sin(a) * r1,
      cardinal,
    }
  })

  return (
    <svg className="cond-compass" viewBox="0 0 100 100" role="img" aria-label="wind direction">
      <circle cx={C} cy={C} r="44" className="cond-compass-ring" />
      <circle cx={C} cy={C} r="44" className="cond-compass-ring-inner" />
      {ticks.map((t, i) => (
        <line key={i} x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
          className={t.cardinal ? 'cond-tick cond-tick-card' : 'cond-tick'} />
      ))}
      <text x={C} y="16" className="cond-compass-n">N</text>

      {hasDir && (
        <g style={{ transform: `rotate(${deg}deg)`, transformOrigin: '50px 50px' }} className="cond-needle">
          {/* arrow head points toward the wind source (out of the NE = points NE) */}
          <path d="M50 12 L45 30 L50 25 L55 30 Z" fill={color} />
          <line x1={C} y1="25" x2={C} y2="68" stroke={color} strokeWidth="1.4" opacity="0.5" />
        </g>
      )}

      <circle cx={C} cy={C} r="17" className="cond-hub" />
      <text x={C} y={hasWind ? 47 : 53} className="cond-hub-val" fill={color}>
        {hasWind ? speed!.toFixed(hasWind && speed! >= 100 ? 0 : 1) : '—'}
      </text>
      {hasWind && <text x={C} y="58" className="cond-hub-unit">{unit}</text>}
    </svg>
  )
}

function fmtDateTime(start: string | null): { date: string; time: string } {
  if (!start) return { date: '—', time: '' }
  // session_start is an ISO-ish string; slice rather than Date-parse to avoid TZ shifts.
  return { date: start.slice(5, 10), time: start.slice(11, 16) }
}

export function ConditionsPanel({ sessions }: { sessions: SessionConditions[] }) {
  const { tempFromC, tempUnit, speedFromMps, speedUnit } = useUnits()
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState(false)

  // Only meaningful if at least one session has weather data.
  const withWeather = sessions.filter(s => s.tempC != null || s.weather || s.windMps != null)
  if (withWeather.length === 0) return null

  const temps = sessions.map(s => s.tempC).filter((t): t is number => t != null)
  const minT = temps.length ? Math.min(...temps) : 0
  const maxT = temps.length ? Math.max(...temps) : 0
  const span = maxT - minT
  // Normalise a temp to 0..1 across the selected sessions' range. With a single
  // temp (or no spread) everything lands mid-ramp so the accent stays sensible.
  const norm = (t: number | null): number => {
    if (t == null) return 0.5
    if (span < 0.5) return 0.5
    return (t - minT) / span
  }

  // Identify the fastest and slowest sessions by best lap — these two frame the
  // pace-vs-conditions story, so they're the summary tiles shown by default.
  const withLaps = sessions.filter(s => s.bestLapMs != null && s.bestLapMs > 0)
  const fastest = withLaps.length ? Math.min(...withLaps.map(s => s.bestLapMs!)) : null
  const fastSg = withLaps.length
    ? withLaps.reduce((a, b) => (a.bestLapMs! <= b.bestLapMs! ? a : b)).sg : null
  const slowSg = withLaps.length > 1
    ? withLaps.reduce((a, b) => (a.bestLapMs! >= b.bestLapMs! ? a : b)).sg : null

  // Sort newest-first to match the session chips ordering above.
  const ordered = [...sessions].sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''))

  // Summary view: fastest first, then slowest. Everything else lives behind the
  // expander. Dedupe so a single-session selection doesn't double up.
  const summarySgs = [fastSg, slowSg].filter((v, i, arr): v is string => !!v && arr.indexOf(v) === i)
  const summary = summarySgs.length
    ? summarySgs.map(sg => ordered.find(s => s.sg === sg)!).filter(Boolean)
    : ordered.slice(0, 1)
  const visible = expanded ? ordered : summary
  const hiddenCount = ordered.length - summary.length

  const rangeLabel = temps.length
    ? span < 0.5
      ? `${tempFromC(minT).toFixed(1)}${tempUnit}`
      : `${tempFromC(minT).toFixed(1)}–${tempFromC(maxT).toFixed(1)}${tempUnit}`
    : 'no weather data'

  const badgeFor = (sg: string): 'FASTEST' | 'SLOWEST' | null =>
    sg === fastSg ? 'FASTEST' : sg === slowSg ? 'SLOWEST' : null

  return (
    <div className="chart-card cond-card cond-card-summary" style={{ marginBottom: 18 }}>
      <div className="card-corner-marks"><i /></div>
      <div className="chart-card-header" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
        <span className="channel-tag">CONDITIONS</span>
        <span className="meta">{rangeLabel} · {open ? '▲ collapse' : '▼ expand'}</span>
      </div>

      {open && (
        <div className="cond-body">
          {/* Thermal scale — every session plotted by temperature along a
              cold→hot gradient. The instrument-scale reading of the whole set. */}
          {temps.length > 1 && span >= 0.5 && (
            <div className="cond-scale">
              <span className="cond-scale-end">{tempFromC(minT).toFixed(0)}°</span>
              <div className="cond-scale-track">
                {ordered.filter(s => s.tempC != null).map(s => (
                  <span
                    key={s.sg}
                    className="cond-scale-dot"
                    style={{
                      left: `${norm(s.tempC) * 100}%`,
                      background: thermalColor(norm(s.tempC)),
                      boxShadow: `0 0 7px ${thermalColor(norm(s.tempC))}`,
                    }}
                    title={`${tempFromC(s.tempC!).toFixed(1)}${tempUnit}`}
                  />
                ))}
              </div>
              <span className="cond-scale-end">{tempFromC(maxT).toFixed(0)}°</span>
            </div>
          )}

          <div className="cond-cards">
            {visible.map((s, i) => {
              const accent = thermalColor(norm(s.tempC))
              const { date, time } = fmtDateTime(s.start)
              const badge = badgeFor(s.sg)
              const isFastest = fastest != null && s.bestLapMs === fastest
              const delta = fastest != null && s.bestLapMs != null && s.bestLapMs > 0
                ? (s.bestLapMs - fastest) / 1000
                : null
              return (
                <div
                  key={s.sg}
                  className="cond-tile"
                  style={{ '--accent': accent, animationDelay: `${i * 50}ms` } as React.CSSProperties}
                >
                  <div className="cond-tile-rail" />
                  <div className="cond-tile-head">
                    <span className="cond-dot" />
                    <span className="cond-date">{date}</span>
                    {badge && <span className={`cond-badge cond-badge-${badge.toLowerCase()}`}>{badge}</span>}
                    <span className="cond-time">{time}</span>
                  </div>

                  <div className="cond-tile-main">
                    <div className="cond-temp-block">
                      <div className="cond-temp">
                        {s.tempC != null ? tempFromC(s.tempC).toFixed(1) : '—'}
                        <span className="cond-temp-deg">{tempUnit}</span>
                      </div>
                      <div className="cond-temp-label">air temp</div>
                    </div>
                    <WindCompass
                      deg={s.windDeg}
                      speed={s.windMps != null ? speedFromMps(s.windMps) : null}
                      unit={speedUnit}
                      color={accent}
                    />
                  </div>

                  <div className="cond-tile-sub">
                    <span className="cond-weather">{(s.weather ?? 'unknown').toUpperCase()}</span>
                    <span className="cond-sub-metrics">
                      {s.humidityPct != null && <span>{Math.round(s.humidityPct)}% RH</span>}
                      {s.windMps != null && <span>{compass(s.windDeg)}</span>}
                    </span>
                  </div>

                  <div className="cond-tile-foot">
                    <span className="cond-lap">{msToLap(s.bestLapMs)}</span>
                    {isFastest ? (
                      <span className="cond-delta cond-delta-best">FASTEST</span>
                    ) : delta != null ? (
                      <span className="cond-delta">+{delta.toFixed(3)}s</span>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>

          {hiddenCount > 0 && (
            <button className="cond-expand" onClick={() => setExpanded(e => !e)}>
              {expanded ? '▲ show summary' : `▾ all ${ordered.length} sessions`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
