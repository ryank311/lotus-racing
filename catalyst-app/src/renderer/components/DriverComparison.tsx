// DRIVER COMPARISON — you against other drivers on the same layout: headline
// times, where the lap time goes split by split, and each corner on everyone's
// fastest lap. Driver colours match the overlaid chart and map lines.

import { useMemo, useState } from 'react'
import { msToLap } from '../api'
import { driverColor } from './chartSeries'
import type { ComparisonData, CornerComparisonCell, DriverSummary } from '../../garmin/analysisData'
import './compare.css'

type SegmentBasis = 'bestLap' | 'best'
type CornerMetric = 'apex' | 'entry' | 'exit' | 'brake'

const CORNER_METRICS: Array<{ key: CornerMetric; label: string; hint: string }> = [
  { key: 'apex', label: 'V-min', hint: 'Minimum speed in the corner' },
  { key: 'entry', label: 'Brake point', hint: 'Speed where braking starts' },
  { key: 'exit', label: '+100 m', hint: 'Speed 100 m after the minimum' },
  { key: 'brake', label: 'Brakes at', hint: 'Metres before the apex where braking starts' },
]

// Signed gap to you, timing-screen style: + is slower than you.
function gap(ms: number | null | undefined, reference: number | null | undefined): string | null {
  if (ms == null || reference == null) return null
  const d = (ms - reference) / 1000
  return `${d > 0 ? '+' : d < 0 ? '−' : '±'}${Math.abs(d).toFixed(3)}`
}

const seconds = (s: number) => `${s.toFixed(2)} s`

function cornerValue(cell: CornerComparisonCell | null, metric: CornerMetric, apexM: number): number | null {
  if (!cell) return null
  if (metric === 'brake') return cell.brakeOnsetM == null ? null : apexM - cell.brakeOnsetM
  return cell[metric]
}

export function DriverComparisonPanel({ comparison, speedUnit, onEdit, onRemoveDriver, onHoverRef, onFocusRef }: {
  comparison: ComparisonData
  speedUnit: string
  onEdit: () => void
  onRemoveDriver: (name: string) => void
  onHoverRef?: (ref: string | null) => void
  onFocusRef?: (ref: string) => void
}) {
  const [open, setOpen] = useState(true)
  const [basis, setBasis] = useState<SegmentBasis>('bestLap')
  const [metric, setMetric] = useState<CornerMetric>('apex')
  const [you, ...others] = comparison.drivers

  return (
    <div className="chart-card driver-compare-card">
      <div className="card-corner-marks"><i /></div>
      <div className="chart-card-header">
        <span className="channel-tag">DRIVER COMPARISON</span>
        <span className="meta driver-compare-head-actions">
          <button type="button" className="driver-compare-link" onClick={onEdit}>Edit drivers</button>
          <button type="button" className="driver-compare-link" aria-expanded={open} onClick={() => setOpen(o => !o)}>
            {open ? '▲ collapse' : '▼ expand'}
          </button>
        </span>
      </div>

      {open && <div className="driver-compare-body">
        <ul className="driver-compare-summary">
          {others.map(driver => <li key={driver.index}><Headline you={you} them={driver} segments={comparison.segments} /></li>)}
        </ul>

        <div className="driver-compare-table-wrap">
          <table className="driver-compare-table">
            <thead>
              <tr>
                <th>Driver</th>
                <th className="num">Best lap</th>
                <th className="num" title="Sum of each driver's plausible best split">Theoretical</th>
                <th className="num" title="Mean of representative laps">Average</th>
                <th className="num">Top speed</th>
                <th className="num">Laps</th>
                <th><span className="loading-sr-only">Remove</span></th>
              </tr>
            </thead>
            <tbody>
              {comparison.drivers.map(driver => (
                <tr key={driver.index}>
                  <td>
                    <span className="driver-name">
                      <i className="driver-dot" style={{ background: driverColor(driver.index) }} />
                      <strong>{driver.name}</strong>
                    </span>
                    <small>{driver.vehicle} · {driver.sessions.length} session{driver.sessions.length === 1 ? '' : 's'}</small>
                  </td>
                  <TimeCell ms={driver.bestLap?.durationMs} reference={driver.self ? null : you.bestLap?.durationMs} />
                  <TimeCell ms={driver.theoreticalBestMs} reference={driver.self ? null : you.theoreticalBestMs} />
                  <TimeCell ms={driver.avgLapMs} reference={driver.self ? null : you.avgLapMs} />
                  <td className="num">{driver.topSpeed == null ? '—' : `${driver.topSpeed.toFixed(1)}`}<small>{driver.topSpeed == null ? '' : speedUnit}</small></td>
                  <td className="num">{driver.lapCount}{driver.excludedLapCount > 0 && <small title="Laps Garmin flagged invalid or the driver excluded">+{driver.excludedLapCount} hidden</small>}</td>
                  <td>{!driver.self && (
                    <button type="button" className="driver-remove" aria-label={`Stop comparing with ${driver.name}`} title="Remove driver"
                      onClick={() => onRemoveDriver(driver.name)}>×</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="driver-compare-note">Gaps are to you; + is slower. Every driver uses the same lap filter.</p>
        </div>

        {comparison.segments.length > 0 && (
          <section className="driver-compare-section">
            <div className="driver-compare-section-head">
              <div>
                <span>Where the time goes</span>
                <small>{basis === 'bestLap' ? 'Each split of everyone’s fastest lap' : 'Each driver’s best time in each split'}</small>
              </div>
              <div className="chart-mode-toggle" role="group" aria-label="Split comparison basis">
                <button type="button" className={basis === 'bestLap' ? 'active' : ''} aria-pressed={basis === 'bestLap'} onClick={() => setBasis('bestLap')}>Fastest laps</button>
                <button type="button" className={basis === 'best' ? 'active' : ''} aria-pressed={basis === 'best'} onClick={() => setBasis('best')}>Split bests</button>
              </div>
            </div>
            <SegmentBars comparison={comparison} basis={basis} onHoverRef={onHoverRef} onFocusRef={onFocusRef} />
          </section>
        )}

        {comparison.corners.length > 0 && (
          <section className="driver-compare-section">
            <div className="driver-compare-section-head">
              <div>
                <span>Corners</span>
                <small>Everyone’s fastest lap · {CORNER_METRICS.find(m => m.key === metric)!.hint.toLowerCase()}</small>
              </div>
              <div className="chart-mode-toggle" role="group" aria-label="Corner metric">
                {CORNER_METRICS.map(m => (
                  <button key={m.key} type="button" className={metric === m.key ? 'active' : ''} aria-pressed={metric === m.key}
                    title={m.hint} onClick={() => setMetric(m.key)}>{m.label}</button>
                ))}
              </div>
            </div>
            <CornerTable comparison={comparison} metric={metric} speedUnit={speedUnit} onHoverRef={onHoverRef} onFocusRef={onFocusRef} />
          </section>
        )}
      </div>}
    </div>
  )
}

function TimeCell({ ms, reference }: { ms: number | null | undefined; reference: number | null | undefined }) {
  const g = gap(ms, reference)
  const faster = ms != null && reference != null && ms < reference
  return (
    <td className="num">
      {msToLap(ms)}
      {g && <small className={faster ? 'is-ahead' : 'is-behind'}>{g}</small>}
    </td>
  )
}

// "Alex's fastest lap is 0.54 s quicker than yours. Alex gains most in S4
// (0.31 s) and S2 (0.18 s)."
function Headline({ you, them, segments }: { you: DriverSummary; them: DriverSummary; segments: ComparisonData['segments'] }) {
  const mine = you.bestLap?.durationMs, theirs = them.bestLap?.durationMs
  if (mine == null || theirs == null) return <>{them.name} has no valid laps in these sessions.</>
  const d = Math.abs(theirs - mine) / 1000
  const theyLead = theirs < mine
  const diffs = segments.flatMap(s => {
    const a = s.bestLap[0], b = s.bestLap[them.index]
    return a == null || b == null ? [] : [{ id: s.id, gain: a - b }]
  })
  const theirGains = diffs.filter(x => x.gain > 0.02).sort((a, b) => b.gain - a.gain).slice(0, 2)
  const yourGains = diffs.filter(x => x.gain < -0.02).sort((a, b) => a.gain - b.gain).slice(0, 2)
  const list = (xs: typeof diffs) => xs.map(x => `${x.id} (${Math.abs(x.gain).toFixed(2)} s)`).join(' and ')
  return (
    <>
      <i className="driver-dot" style={{ background: driverColor(them.index) }} />
      <span>
        {d < 0.0005 ? <>You and <strong>{them.name}</strong> have the same best lap.</>
          : theyLead ? <><strong>{them.name}</strong>’s fastest lap is <strong>{d.toFixed(3)} s</strong> quicker than yours.</>
          : <>Your fastest lap is <strong>{d.toFixed(3)} s</strong> quicker than <strong>{them.name}</strong>’s.</>}
        {theirGains.length > 0 && <> {them.name} gains most in {list(theirGains)}.</>}
        {yourGains.length > 0 && <> You gain in {list(yourGains)}.</>}
      </span>
    </>
  )
}

// One row per split; one bar per compared driver. A bar grows left when you
// are faster in that split and right when they are.
function SegmentBars({ comparison, basis, onHoverRef, onFocusRef }: {
  comparison: ComparisonData
  basis: SegmentBasis
  onHoverRef?: (ref: string | null) => void
  onFocusRef?: (ref: string) => void
}) {
  const others = comparison.drivers.slice(1)
  const rows = useMemo(() => comparison.segments.map(s => {
    const values = s[basis]
    return { id: s.id, mine: values[0], diffs: others.map(d => (values[0] == null || values[d.index] == null ? null : values[0] - values[d.index]!)) }
  }), [comparison.segments, basis, others])
  // The lap total uses the headline times (fastest laps or theoretical
  // bests) so it matches the table exactly; summed splits can differ by a
  // millisecond of interpolation.
  const [you] = comparison.drivers
  const headline = (d: DriverSummary) => (basis === 'bestLap' ? d.bestLap?.durationMs : d.theoreticalBestMs) ?? null
  const total = others.map(d => {
    const mine = headline(you), theirs = headline(d)
    return mine == null || theirs == null ? null : (mine - theirs) / 1000
  })
  const scale = Math.max(0.05, ...rows.flatMap(r => r.diffs.map(d => Math.abs(d ?? 0))))

  return (
    <div className="segment-bars" onMouseLeave={() => onHoverRef?.(null)}>
      <div className="segment-bars-axis" aria-hidden="true">
        <span>◀ you’re faster</span><span>they’re faster ▶</span>
      </div>
      {rows.map(row => (
        <button type="button" key={row.id} className="segment-bar-row"
          onMouseEnter={() => onHoverRef?.(row.id)} onFocus={() => onHoverRef?.(row.id)}
          onClick={() => onFocusRef?.(row.id)} title={`View ${row.id} on the map`}>
          <span className="segment-bar-id">{row.id}</span>
          <span className="segment-bar-time">{row.mine == null ? '—' : seconds(row.mine)}</span>
          <span className="segment-bar-tracks">
            {others.map((driver, i) => {
              const d = row.diffs[i]
              const pct = d == null ? 0 : Math.min(40, Math.abs(d) / scale * 40)
              const label = d == null ? `${driver.name}: no time` : Math.abs(d) < 0.005 ? `${driver.name}: even`
                : d > 0 ? `${driver.name} faster by ${d.toFixed(2)} s` : `You faster than ${driver.name} by ${(-d).toFixed(2)} s`
              return (
                <span key={driver.index} className="segment-bar-track" aria-label={label} title={label}>
                  {d != null && <i style={{
                    background: driverColor(driver.index),
                    width: `${pct}%`,
                    ...(d > 0 ? { left: '50%' } : { right: '50%' }),
                  }} />}
                  {d != null && Math.abs(d) >= 0.005 && <em style={d > 0 ? { left: `calc(50% + ${pct}% + 4px)` } : { right: `calc(50% + ${pct}% + 4px)` }}>{Math.abs(d).toFixed(2)}</em>}
                </span>
              )
            })}
          </span>
        </button>
      ))}
      <div className="segment-bar-row is-total">
        <span className="segment-bar-id">Lap</span>
        <span className="segment-bar-time" />
        <span className="segment-bar-totals">
          {others.map((driver, i) => {
            const t = total[i]
            return (
              <span key={driver.index}>
                <i className="driver-dot" style={{ background: driverColor(driver.index) }} />
                {t == null ? `${driver.name}: incomplete splits`
                  : Math.abs(t) < 0.0005 ? `Even with ${driver.name}`
                  : t > 0 ? `${driver.name} ${t.toFixed(3)} s faster` : `You ${(-t).toFixed(3)} s faster than ${driver.name}`}
              </span>
            )
          })}
        </span>
      </div>
    </div>
  )
}

function CornerTable({ comparison, metric, speedUnit, onHoverRef, onFocusRef }: {
  comparison: ComparisonData
  metric: CornerMetric
  speedUnit: string
  onHoverRef?: (ref: string | null) => void
  onFocusRef?: (ref: string) => void
}) {
  const unit = metric === 'brake' ? 'm' : speedUnit
  const fmt = (v: number) => (metric === 'brake' ? v.toFixed(0) : v.toFixed(1))
  return (
    <div className="driver-compare-table-wrap">
      <table className="driver-compare-table corner-compare-table" onMouseLeave={() => onHoverRef?.(null)}>
        <thead>
          <tr>
            <th>Corner</th>
            {comparison.drivers.map(d => (
              <th key={d.index} className="num">
                <span className="driver-name is-head"><i className="driver-dot" style={{ background: driverColor(d.index) }} />{d.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {comparison.corners.map(row => {
            const values = row.drivers.map(cell => cornerValue(cell, metric, row.apexM))
            const known = values.filter((v): v is number => v != null)
            // Higher corner speed is better; braking point has no winner.
            const top = metric === 'brake' || known.length < 2 ? null : Math.max(...known)
            const mine = values[0]
            return (
              <tr key={row.turn} onMouseEnter={() => onHoverRef?.(row.turn)} onClick={() => onFocusRef?.(row.turn)} title={`View ${row.turn} on the map`}>
                <td><strong>{row.turn}</strong>{row.name && <small>{row.name}</small>}</td>
                {values.map((v, i) => {
                  const diff = i > 0 && v != null && mine != null ? v - mine : null
                  const lead = top != null && v === top
                  return (
                    <td key={i} className="num">
                      <span className={lead ? 'is-top' : ''} style={lead ? { color: driverColor(i) } : undefined}>{v == null ? '—' : fmt(v)}</span>
                      {diff != null && Math.abs(diff) >= (metric === 'brake' ? 1 : 0.1) && (
                        <small title={metric === 'brake' ? `${Math.abs(diff).toFixed(0)} m ${diff > 0 ? 'earlier' : 'later'} than you` : `${Math.abs(diff).toFixed(1)} ${speedUnit} ${diff > 0 ? 'faster' : 'slower'} than you`}>
                          {metric === 'brake' ? `${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(0)}` : `${diff > 0 ? '+' : '−'}${Math.abs(diff).toFixed(1)}`}
                        </small>
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="driver-compare-note">
        {metric === 'brake' ? 'Metres before the apex' : unit} · small numbers: difference from you{metric === 'brake' ? ' (+ = brakes earlier)' : ''} · click a corner to view it on the map.
      </p>
    </div>
  )
}
