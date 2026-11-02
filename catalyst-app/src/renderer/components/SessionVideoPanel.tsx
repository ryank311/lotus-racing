// Session Review: this session's video beside its distance charts. Pick a
// lap (or the optimal lap, cut from the session's fastest pass through each
// segment) and another to compare it with, side by side or overlaid; the
// charts show both, and every chart, the lap strip and the corners explorer
// move the video. PDR videos add throttle, brake, gear and steering, and
// each lap's tyre pressures and temperatures.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, msToLap } from '../api'
import { NavLink } from '../navigation'
import { LineChart, type LineSeries } from './Charts'
import { PALETTE } from './chartTheme'
import { VideoDeck, type DeckLap } from './VideoDeck'
import { channelPoints, cornerInputs, gapSeries, stitchOptimalLap, traceKey, type CarChannel } from './carData'
import { UploadQueue, VideoPickerButton, VideoSyncControls } from './VideoImport'
import { TyreTable, TyreTrendCharts, hasTyreData } from './TyreTable'
import { onVideoImported } from '../videoUploads'
import type { SessionCarData, SessionVideo } from '../../shared/pdr'
import type { TrackCorner } from '../../garmin/trackYaml'
import { requestVideoRange } from '../videoBus'
import './video.css'

const CHARTS: Array<{ channel: CarChannel; label: string; unit: string; range?: [number, number]; zero?: boolean }> = [
  { channel: 'throttle', label: 'THROTTLE', unit: '%', range: [0, 100] },
  { channel: 'brake', label: 'BRAKE', unit: '%' },
  { channel: 'gear', label: 'GEAR', unit: '' },
  { channel: 'steering', label: 'STEERING', unit: '°', zero: true },
]

const fmt = (v: number | null, unit = '', places = 0) => (v == null ? '—' : `${v.toFixed(places)}${unit}`)
const OPTIMAL = 'optimal'

export function SessionVideoPanel({ sessionGuid }: { sessionGuid: string }) {
  const [data, setData] = useState<SessionCarData | null>(null)
  const [error, setError] = useState('')
  const [lap, setLap] = useState<string | null>(null)
  const [compare, setCompare] = useState<string | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [xRange, setXRange] = useState<[number, number] | null>(null)
  const load = useCallback(async () => {
    try { setData(await api.getSessionCarData(sessionGuid)); setError('') } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [sessionGuid])
  useEffect(() => {
    setData(null); setLap(null); setCompare(null); setHover(null)
    void load()
    return onVideoImported(result => { if (result.video.sessionGuid === sessionGuid) void load() })
  }, [sessionGuid, load])

  const lapInfo = useMemo(() => new Map((data?.laps ?? []).map(l => [l.lapIdx, l])), [data])
  const plain = useMemo<DeckLap[]>(() => (data?.traces ?? [])
    .filter(t => lapInfo.has(t.lapIdx) && t.videoT.some(v => v != null))
    .map(t => {
      const info = lapInfo.get(t.lapIdx)!
      return { key: traceKey(t), trace: t, short: info.label, color: '', label: `${info.isBest ? '★ ' : ''}${info.label} · ${msToLap(info.durationMs)}` }
    }), [data, lapInfo])
  // The optimal lap: each of Garmin's segments from the lap that was fastest
  // through it, cut together from this session's video.
  const stitched = useMemo(() => stitchOptimalLap(plain.map(o => o.trace), data?.splits ?? []), [plain, data])
  const fastestKey = plain.find(o => lapInfo.get(o.trace.lapIdx)?.isBest)?.key ?? null
  const primaryKey = lap && (lap === OPTIMAL ? stitched : plain.some(o => o.key === lap)) ? lap : fastestKey ?? plain[0]?.key ?? null
  // The charts' reference: the lap you compare with, else the fastest lap,
  // else (on the fastest) the optimal lap, to show where it lost time.
  const referenceKey = compare ?? (primaryKey !== fastestKey ? fastestKey : stitched && primaryKey !== OPTIMAL ? OPTIMAL : null)
  const laps = useMemo<DeckLap[]>(() => {
    const colour = (key: string) => (key === primaryKey ? PALETTE.signal : key === referenceKey ? PALETTE.cyan : PALETTE.purple)
    const all = stitched
      ? [{ key: OPTIMAL, trace: stitched.trace, pieces: stitched.pieces, short: 'Optimal', color: '', label: `◆ Optimal · ${msToLap(Math.round(stitched.timeS * 1000))} · from ${stitched.laps.map(i => lapInfo.get(i)?.label ?? `L${i + 1}`).join(', ')}` }, ...plain]
      : plain
    return all.map(l => ({ ...l, color: colour(l.key) }))
  }, [plain, stitched, lapInfo, primaryKey, referenceKey])
  const current = laps.find(l => l.key === primaryKey) ?? null
  const reference = referenceKey ? laps.find(l => l.key === referenceKey) ?? null : null

  const corners = data?.corners ?? []
  const chartCorners = useMemo<TrackCorner[]>(() => corners.map(c => ({ turn: c.turn, name: c.name, apex_idx: c.apexM, dist_idx_start: c.startM, dist_idx_end: c.endM })), [corners])
  const totalM = useMemo(() => Math.max(0, ...(data?.splits ?? []).map(s => s.endM), ...plain.map(l => l.trace.dist[l.trace.dist.length - 1] ?? 0)), [data, plain])

  const series = (channel: CarChannel): LineSeries[] => [
    ...(reference ? [{ id: 'ref', label: reference.short, ...channelPoints(reference.trace, channel), color: reference.color, width: 1.4, opacity: 0.8 }] : []),
    ...(current ? [{ id: 'lap', label: current.short, ...channelPoints(current.trace, channel), color: current.color, width: 2.2, opacity: 1 }] : []),
  ]
  // Time gap of the shown lap behind the reference (positive = slower).
  const gap = useMemo<LineSeries[]>(() => {
    if (!current || !reference) return []
    const { xs, ys } = gapSeries(reference, current)
    return [{ id: 'gap', label: `${current.short} vs ${reference.short}`, xs, ys, color: current.color, width: 2, opacity: 1 }]
  }, [current, reference])
  const hasData = (channel: CarChannel) => [current, reference].some(o => o && channelPoints(o.trace, channel).xs.length > 0)
  const carCharts = CHARTS.filter(c => hasData(c.channel))
  const hasInputs = hasData('throttle') || hasData('brake')
  // Corner inputs time the coast between pedals: not across the optimal lap's cuts.
  const inputs = useMemo(() => current && !current.pieces && hasInputs ? cornerInputs(current.trace, corners) : [], [current, corners, hasInputs])
  const refInputs = useMemo(() => reference && !reference.pieces && hasInputs ? new Map(cornerInputs(reference.trace, corners).map(c => [c.turn, c])) : null, [reference, corners, hasInputs])
  const replace = (video: SessionVideo) => { setData(d => d ? { ...d, attached: d.attached.map(v => (v.id === video.id ? video : v)) } : d); void load() }
  const synced = data?.attached.filter(v => v.offsetS != null) ?? []
  const playable = useMemo(() => new Set(plain.map(l => l.trace.lapIdx)), [plain])
  const showTyres = !!data && hasTyreData(data.lapStats)
  const chart = (key: string, label: string, unit: string, list: LineSeries[], extra: { range?: [number, number]; zero?: boolean; height?: number } = {}) =>
    <div key={key} className="review-video-chart">
      <span className="channel-tag">{label}{unit ? ` · ${unit}` : ''}</span>
      <LineChart series={list} height={extra.height ?? 132} yUnit={unit} yRange={extra.range} zeroLine={extra.zero} corners={chartCorners}
        onHoverX={setHover} hoverX={hover} xRange={xRange} onXRangeChange={setXRange} />
    </div>

  return <section className="review-panel review-video" id="session-video">
    <div className="review-section-heading">
      <div><span className="review-eyebrow">Video</span><h2>Lap video</h2></div>
      <VideoPickerButton sessionGuid={sessionGuid} className="btn ghost small">Attach PDR video</VideoPickerButton>
    </div>
    {error && <p className="loss" role="alert">{error}</p>}
    {!data && !error && <p className="muted">Loading…</p>}
    {data && !data.attached.length && <p className="muted">Import this session’s video from the Garmin Catalyst on the <NavLink to="/import">Import</NavLink> page to watch any lap beside its charts, or attach the Corvette PDR video recorded during it to add throttle, brake, gear, steering and tyre pressures and temperatures. Imported videos are matched to their sessions automatically.</p>}
    <UploadQueue compact only="pdr" />
    {data && synced.length > 0 && !plain.length && <p className="muted">The attached video does not cover a complete valid lap of this session.</p>}
    {current && data && <>
      <div className="review-video-layout">
        <VideoDeck laps={laps} primary={current.key} onPrimary={setLap} compare={reference && compare ? reference.key : null} onCompare={setCompare}
          hoverDistanceM={hover} onHoverDistance={setHover} corners={corners} totalM={totalM} speedUnit={data.speedUnit} defaultMode="side" />
        <div className="review-video-charts">
          {chart('speed', 'SPEED', data.speedUnit, series('speed'), { height: 150 })}
          {gap.length > 0 && chart('gap', `GAP · ${current.short} vs ${reference!.short}`, 's', gap, { zero: true })}
          {carCharts.map(c => chart(c.channel, c.label, c.unit, series(c.channel), { range: c.range, zero: c.zero }))}
          <p className="muted small review-video-key">
            <i style={{ background: current.color }} /> {current.short}
            {reference && <> · <i style={{ background: reference.color }} /> {reference.short}{compare ? '' : reference.key === OPTIMAL ? ' (best of each segment)' : ' (fastest)'}</>}
            {gap.length > 0 && ' · gap above zero: losing time'}
            {!carCharts.length && ' · throttle, brake and steering appear with a PDR video'}
          </p>
        </div>
      </div>
      {inputs.length > 0 && <details className="review-video-inputs" open>
        <summary><span className="review-eyebrow">Driver inputs by corner</span> <span className="muted small">{current.short}{refInputs ? ` · ${reference!.short} in brackets` : ''} · click a corner to watch it</span></summary>
        <div className="review-table-wrap"><table className="tbl">
          <thead><tr><th>Corner</th><th title="Distance before the apex where braking starts">Brake on</th><th>Peak brake</th><th title="Time between releasing the brake and 20% throttle">Coast</th><th title="Distance from the apex to 20% throttle (negative = before the apex)">Throttle on</th><th>Lowest gear</th><th>Max steering</th></tr></thead>
          <tbody>{inputs.map(c => {
            const b = refInputs?.get(c.turn)
            const corner = corners.find(k => k.turn === c.turn)
            const pair = (v: string, ref?: string) => <>{v}{ref != null && ref !== v ? <span className="muted"> ({ref})</span> : null}</>
            return <tr key={c.turn}>
              <td>{corner
                ? <button type="button" className="deck-link" title="Play this corner in the video"
                  onClick={() => requestVideoRange({ startM: corner.startM, endM: corner.endM, label: `${c.turn}${c.name ? ` · ${c.name}` : ''}`, play: true })}>▶ {c.turn}{c.name ? ` · ${c.name}` : ''}</button>
                : <>{c.turn}{c.name ? ` · ${c.name}` : ''}</>}</td>
              <td>{pair(c.brakeOnM == null ? 'no braking' : `${c.brakeOnM} m`, b ? (b.brakeOnM == null ? 'no braking' : `${b.brakeOnM} m`) : undefined)}</td>
              <td>{pair(fmt(c.peakBrake, '%'), b ? fmt(b.peakBrake, '%') : undefined)}</td>
              <td>{pair(fmt(c.coastS, ' s', 2), b ? fmt(b.coastS, ' s', 2) : undefined)}</td>
              <td>{pair(c.throttleOnM == null ? '—' : `${c.throttleOnM > 0 ? '+' : ''}${c.throttleOnM} m`, b ? (b.throttleOnM == null ? '—' : `${b.throttleOnM > 0 ? '+' : ''}${b.throttleOnM} m`) : undefined)}</td>
              <td>{pair(fmt(c.minGear), b ? fmt(b.minGear) : undefined)}</td>
              <td>{pair(fmt(c.maxSteering, '°'), b ? fmt(b.maxSteering, '°') : undefined)}</td>
            </tr>
          })}</tbody>
        </table></div>
      </details>}
    </>}
    {showTyres && data && <details className="review-video-tyres" open>
      <summary><span className="review-eyebrow">Tyres and fluids by lap</span> <span className="muted small">from the car’s tyre pressure sensors · at the end of each lap{playable.size ? ' · click a lap to watch it' : ''}</span></summary>
      <TyreTrendCharts stats={data.lapStats} laps={data.laps} pressureUnit={data.pressureUnit} tempUnit={data.tempUnit} />
      <TyreTable stats={data.lapStats} laps={data.laps} pressureUnit={data.pressureUnit} tempUnit={data.tempUnit}
        currentLapIdx={current && !current.pieces ? current.trace.lapIdx : null} playable={playable}
        onPick={lapIdx => { const pick = plain.find(l => l.trace.lapIdx === lapIdx); if (pick) setLap(pick.key) }} />
    </details>}
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
