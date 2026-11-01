// Session Review: this session's PDR video beside the car data for one lap
// (against the session's fastest), the driver's inputs through each corner,
// and attaching or re-syncing videos.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, msToLap } from '../api'
import { NavLink } from '../navigation'
import { LineChart, type LineSeries } from './Charts'
import { PALETTE } from './chartTheme'
import { LapVideo, type LapVideoOption } from './LapVideo'
import { channelPoints, cornerInputs, traceKey, type CarChannel } from './carData'
import { UploadQueue, VideoPickerButton, VideoSyncControls } from './VideoImport'
import { onVideoImported } from '../videoUploads'
import type { SessionCarData, SessionVideo } from '../../shared/pdr'
import './video.css'
import './catalystImport.css'

const CHARTS: Array<{ channel: CarChannel; label: string; unit: string; range?: [number, number]; zero?: boolean }> = [
  { channel: 'speed', label: 'SPEED', unit: '' },
  { channel: 'throttle', label: 'THROTTLE', unit: '%', range: [0, 100] },
  { channel: 'brake', label: 'BRAKE', unit: 'bar' },
  { channel: 'gear', label: 'GEAR', unit: '' },
  { channel: 'steering', label: 'STEERING', unit: '°', zero: true },
]

const fmt = (v: number | null, unit = '', places = 0) => (v == null ? '—' : `${v.toFixed(places)}${unit}`)

export function SessionVideoPanel({ sessionGuid }: { sessionGuid: string }) {
  const [data, setData] = useState<SessionCarData | null>(null)
  const [error, setError] = useState('')
  const [lap, setLap] = useState<string | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [xRange, setXRange] = useState<[number, number] | null>(null)
  const load = useCallback(async () => {
    try { setData(await api.getSessionCarData(sessionGuid)); setError('') } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [sessionGuid])
  useEffect(() => {
    setData(null); setLap(null); setHover(null)
    void load()
    return onVideoImported(result => { if (result.video.sessionGuid === sessionGuid) void load() })
  }, [sessionGuid, load])

  const lapInfo = useMemo(() => new Map((data?.laps ?? []).map(l => [l.lapIdx, l])), [data])
  const options = useMemo<LapVideoOption[]>(() => (data?.traces ?? [])
    .filter(t => lapInfo.has(t.lapIdx) && t.videoT.some(v => v != null))
    .map(t => { const info = lapInfo.get(t.lapIdx)!; return { key: traceKey(t), trace: t, label: `${info.isBest ? '★ ' : ''}${info.label} · ${msToLap(info.durationMs)}` } }), [data, lapInfo])
  const current = options.find(o => o.key === lap) ?? options.find(o => lapInfo.get(o.trace.lapIdx)?.isBest) ?? options[0]
  const best = options.find(o => lapInfo.get(o.trace.lapIdx)?.isBest)
  const series = (channel: CarChannel): LineSeries[] => [
    ...(best && current && best.key !== current.key ? [{ id: 'best', label: `★ ${lapInfo.get(best.trace.lapIdx)?.label} (fastest)`, ...channelPoints(best.trace, channel), color: PALETTE.cyan, width: 1.4, opacity: 0.75 }] : []),
    ...(current ? [{ id: 'lap', label: lapInfo.get(current.trace.lapIdx)?.label ?? 'Lap', ...channelPoints(current.trace, channel), color: PALETTE.signal, width: 2.2, opacity: 1 }] : []),
  ]
  // Catalyst videos have no car channels: only the charts with data show.
  const hasData = (channel: CarChannel) => [current, best].some(o => o && channelPoints(o.trace, channel).xs.length > 0)
  const charts = CHARTS.filter(c => hasData(c.channel))
  const hasInputs = hasData('throttle') || hasData('brake')
  const inputs = useMemo(() => current && data && hasInputs ? cornerInputs(current.trace, data.corners) : [], [current, data, hasInputs])
  const bestInputs = useMemo(() => best && data && hasInputs && best.key !== current?.key ? new Map(cornerInputs(best.trace, data.corners).map(c => [c.turn, c])) : null, [best, current, data, hasInputs])
  const replace = (video: SessionVideo) => { setData(d => d ? { ...d, attached: d.attached.map(v => (v.id === video.id ? video : v)) } : d); void load() }
  const synced = data?.attached.filter(v => v.offsetS != null) ?? []
  const optimal = data?.attached.filter(v => v.source === 'catalyst-optimal') ?? []

  return <section className="review-panel review-video">
    <div className="review-section-heading">
      <div><span className="review-eyebrow">Video</span><h2>Video & car data</h2></div>
      <VideoPickerButton sessionGuid={sessionGuid} className="btn ghost">Attach PDR video</VideoPickerButton>
    </div>
    {error && <p className="loss" role="alert">{error}</p>}
    {!data && !error && <p className="muted">Loading…</p>}
    {data && !data.attached.length && <p className="muted">Import this session’s video from the Garmin Catalyst on the <NavLink to="/import">Import</NavLink> page to watch any lap beside its charts, or attach the Corvette PDR video recorded during it to add throttle, brake, gear and steering. Imported videos are matched to their sessions automatically.</p>}
    <UploadQueue compact />
    {data && synced.length > 0 && !options.length && <p className="muted">The attached video does not cover a complete valid lap of this session.</p>}
    {current && <>
      <div className="review-video-grid">
        <LapVideo options={options} selected={current.key} onSelect={setLap} hoverDistanceM={hover} onHoverDistance={setHover} />
        <div className="review-video-charts">
          {charts.map(c => <div key={c.channel} className="review-video-chart">
            <span className="channel-tag">{c.label}{c.channel === 'speed' ? ` · ${data!.speedUnit}` : c.unit ? ` · ${c.unit}` : ''}</span>
            <LineChart series={series(c.channel)} height={118} yUnit={c.channel === 'speed' ? data!.speedUnit : c.unit} yRange={c.range} zeroLine={c.zero}
              onHoverX={setHover} hoverX={hover} xRange={xRange} onXRangeChange={setXRange} />
          </div>)}
          {best && best.key !== current.key && <p className="muted small">Orange: the lap in the video · cyan: this session’s fastest lap.</p>}
        </div>
      </div>
      {inputs.length > 0 && <details className="review-video-inputs" open>
        <summary><span className="review-eyebrow">Driver inputs by corner</span> <span className="muted small">{lapInfo.get(current.trace.lapIdx)?.label}{bestInputs ? ' · fastest lap in brackets' : ''}</span></summary>
        <div className="review-table-wrap"><table className="tbl">
          <thead><tr><th>Corner</th><th title="Distance before the apex where braking starts">Brake on</th><th>Peak brake</th><th title="Time between releasing the brake and 20% throttle">Coast</th><th title="Distance from the apex to 20% throttle (negative = before the apex)">Throttle on</th><th>Lowest gear</th><th>Max steering</th></tr></thead>
          <tbody>{inputs.map(c => {
            const b = bestInputs?.get(c.turn)
            const pair = (v: string, ref?: string) => <>{v}{ref != null && ref !== v ? <span className="muted"> ({ref})</span> : null}</>
            return <tr key={c.turn}>
              <td>{c.turn}{c.name ? ` · ${c.name}` : ''}</td>
              <td>{pair(c.brakeOnM == null ? 'no braking' : `${c.brakeOnM} m`, b ? (b.brakeOnM == null ? 'no braking' : `${b.brakeOnM} m`) : undefined)}</td>
              <td>{pair(fmt(c.peakBrake, ' bar'), b ? fmt(b.peakBrake, ' bar') : undefined)}</td>
              <td>{pair(fmt(c.coastS, ' s', 2), b ? fmt(b.coastS, ' s', 2) : undefined)}</td>
              <td>{pair(c.throttleOnM == null ? '—' : `${c.throttleOnM > 0 ? '+' : ''}${c.throttleOnM} m`, b ? (b.throttleOnM == null ? '—' : `${b.throttleOnM > 0 ? '+' : ''}${b.throttleOnM} m`) : undefined)}</td>
              <td>{pair(fmt(c.minGear), b ? fmt(b.minGear) : undefined)}</td>
              <td>{pair(fmt(c.maxSteering, '°'), b ? fmt(b.maxSteering, '°') : undefined)}</td>
            </tr>
          })}</tbody>
        </table></div>
      </details>}
    </>}
    {optimal.map(v => <details key={v.id} className="review-video-files catalyst-optimal">
      <summary><span className="review-eyebrow">Garmin optimal lap</span> <span className="muted small">Garmin’s render of your best segments, joined into one lap</span></summary>
      <video controls preload="metadata" src={api.videoUrl(v.id)} />
    </details>)}
    {data && data.attached.length > 0 && <details className="review-video-files">
      <summary><span className="review-eyebrow">Attached videos</span> <span className="muted small">{data.attached.length} · sync and files</span></summary>
      {data.attached.map(v => <div key={v.id} className="video-card">
        <div className="video-card-head"><div><strong>{v.fileName}</strong><span className="muted small">laps {v.laps.map(i => `L${i + 1}`).join(', ') || '—'}</span></div>
          <NavLink className="btn ghost small" to="/import">Manage on Import</NavLink></div>
        <VideoSyncControls video={v} onChange={replace} />
      </div>)}
    </details>}
  </section>
}
