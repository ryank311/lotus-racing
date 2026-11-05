// 3D Replay: one lap driven by the car on a 3D model of the track (USGS
// lidar terrain, NAIP aerial photo, the road on the Garmin mean line; or a
// user-supplied track model such as a converted Assetto Corsa track), seen
// from the driver's seat or a chase camera, with an optional ghost lap, the
// car's inputs and the onboard video picture in picture.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, msToLap } from '../api'
import { NavLink, useNavigation, useRoute } from '../navigation'
import { routeUrl, segment } from '../routes'
import { useResource } from '../useResource'
import { startLabel } from '../components/reviewTimeline'
import { SPEED_RAMP } from '../components/chartTheme'
import { presetFor, trackModelFor, type CarModel, type CarModelFit, type ReplayLap, type ReplayLapInfo, type ReplayLapRef, type ReplayScene } from '../../shared/replay'
import { speedFromMps, speedUnitLabel } from '../../shared/units'
import type { DbSessionRow } from '../../shared/types'
import { ReplayEngine, type ReplayView } from '../replay/engine'
import { LapPath } from '../replay/lapPath'
import { buildModelWorld, buildWorld, type BuiltWorld, type TerrainData } from '../replay/world'
import { trackModelLabel } from '../replay/acTrack'
import { parseGlb } from '../replay/car'
import { shortTrackName } from '../replay/geo'
import { REPLAY_DEBUG } from '../replay/debug'
import { ReplayHud, clock, useFrame } from '../replay/Hud'
import '../replay/replay.css'

const RATES = [0.25, 0.5, 1, 2]
// The cameras, in the order C cycles them.
const VIEWS = ['chase', 'driver', 'garmin'] as const
const VIEW_NAMES: Record<string, string> = { chase: 'Chase', driver: 'Driver', garmin: 'Garmin' }
const nextView = (view: ReplayView): ReplayView => VIEWS[(VIEWS.indexOf(view as typeof VIEWS[number]) + 1) % VIEWS.length]
const lapValue = (ref: ReplayLapRef) => `${ref.sessionGuid}:${ref.lap}`
const MODEL_CHOICE = 'catalyst:replay-model:'
// Which track to draw when a track model matches: 'public' or 'model'.
const TRACK_CHOICE = 'catalyst:replay-track'

// The last terrain and car model bytes stay in memory while the app is open,
// so changing laps, layouts of the same circuit or sessions does not refetch.
let terrainCache: { key: string; data: Omit<TerrainData, 'sample'> } | null = null
const modelBytes = new Map<string, ArrayBuffer>()
// Track model files (the shared base and each layout's), by "id/file".
const trackFiles = new Map<string, Promise<ArrayBuffer>>()
function trackFile(id: string, file: string): Promise<ArrayBuffer> {
  const key = `${id}/${file}`
  let bytes = trackFiles.get(key)
  if (!bytes) {
    if (![...trackFiles.keys()].some(k => k.startsWith(`${id}/`))) trackFiles.clear()
    bytes = api.getTrackModelFile(id, file)
    bytes.catch(() => trackFiles.delete(key))
    trackFiles.set(key, bytes)
  }
  return bytes
}

function readTrackChoice(): 'public' | 'model' {
  try { return localStorage.getItem(TRACK_CHOICE) === 'public' ? 'public' : 'model' } catch { return 'model' }
}
function saveTrackChoice(value: 'public' | 'model') {
  try { localStorage.setItem(TRACK_CHOICE, value) } catch { /* optional */ }
}

function readChoice(key: string | null): string | null {
  try { return key ? localStorage.getItem(MODEL_CHOICE + key) : null } catch { return null }
}
function saveChoice(key: string | null, value: string | null) {
  try { if (key) value ? localStorage.setItem(MODEL_CHOICE + key, value) : localStorage.removeItem(MODEL_CHOICE + key) } catch { /* optional */ }
}

function sessionGroups(rows: DbSessionRow[]) {
  const groups = new Map<string, DbSessionRow[]>()
  for (const s of [...rows].sort((a, b) => (b.session_start ?? '').localeCompare(a.session_start ?? ''))) {
    const label = [s.track_name || 'Unknown track', s.track_configuration_name || 'Unknown layout'].join(' · ')
    groups.set(label, [...(groups.get(label) ?? []), s])
  }
  return [...groups.entries()]
}

type WorldStatus = { step: string; building: boolean; error?: string }

export function Replay({ refreshTick }: { refreshTick: number }) {
  const { id, params } = useRoute(), { go, query } = useNavigation()
  const catalogue = useResource(() => api.listSessions(), '', refreshTick)
  const sessions = useMemo(() => (catalogue.data ?? []).filter(s => s.lap_count > 0 && s.details_loaded), [catalogue.data])

  // No session chosen: the most recent one with laps.
  useEffect(() => {
    if (id || !catalogue.data) return
    const latest = [...sessions].sort((a, b) => (b.session_start ?? '').localeCompare(a.session_start ?? ''))[0]
    if (latest) go(routeUrl(`/replay/${segment(latest.session_guid)}`, { view: params.get('view') }), { replace: true })
  }, [id, catalogue.data, sessions, go, params])

  const sceneResource = useResource(() => (id ? api.getReplayScene(id) : Promise.resolve(null)), id ?? '')
  const scene = sceneResource.data ?? null

  // The lap: ?lap=<index|optimal>, else the session's best.
  const lapParam = params.get('lap')
  const lapInfo = useMemo(() => {
    if (!scene) return null
    const wanted = lapParam == null ? null : lapParam === 'optimal' ? 'optimal' : Number(lapParam)
    return scene.laps.find(l => l.lap === wanted) ?? scene.laps.find(l => l.isBest) ?? scene.laps[0] ?? null
  }, [scene, lapParam])

  const lapMissing = !!scene && lapParam != null && lapInfo != null && String(lapInfo.lap) !== lapParam
  // The ghost: ?ghost=<session>:<lap> or none; by default the session's
  // best, unless that is the lap being watched.
  const ghostOptions = useMemo(() => {
    if (!scene) return [] as Array<{ group: string; laps: ReplayLapInfo[] }>
    const own = scene.laps.filter(l => !lapInfo || l.lap !== lapInfo.lap)
    return [
      { group: 'This session', laps: own },
      { group: 'Other sessions, fastest first', laps: scene.ghostCandidates.filter((l, i, all) => l.sessionGuid !== scene.sessionGuid && all.findIndex(o => lapValue(o) === lapValue(l)) === i) },
    ].filter(g => g.laps.length)
  }, [scene, lapInfo])
  const ghostParam = params.get('ghost')
  const ghostInfo = useMemo(() => {
    if (!scene || !lapInfo || ghostParam === 'none') return null
    if (ghostParam) {
      const [guid, lap] = [ghostParam.slice(0, ghostParam.lastIndexOf(':')), ghostParam.slice(ghostParam.lastIndexOf(':') + 1)]
      const ref = { sessionGuid: guid, lap: lap === 'optimal' ? 'optimal' as const : Number(lap) }
      return [...scene.laps, ...scene.ghostCandidates].find(l => l.sessionGuid === ref.sessionGuid && l.lap === ref.lap)
        ?? { ...ref, durationMs: 0, label: `${ref.lap === 'optimal' ? 'Optimal' : `L${Number(ref.lap) + 1}`}`, isBest: false, hasVideo: false }
    }
    const best = scene.laps.find(l => l.isBest)
    return best && best.lap !== lapInfo.lap ? best : null
  }, [scene, lapInfo, ghostParam])

  const viewParam = params.get('view')
  const view: ReplayView = viewParam === 'driver' || viewParam === 'garmin' ? viewParam : 'chase'
  const [debugOrbit, setDebugOrbit] = useState(false)

  const lapKey = id && lapInfo ? `${id}|${lapValue(lapInfo)}` : ''
  const lapResource = useResource<ReplayLap | null>(() => (id && lapInfo ? api.getReplayLap(id, { sessionGuid: lapInfo.sessionGuid, lap: lapInfo.lap }) : Promise.resolve(null)), lapKey)
  const ghostKey = id && ghostInfo ? `${id}|${lapValue(ghostInfo)}` : ''
  const ghostResource = useResource<ReplayLap | null>(() => (id && ghostInfo ? api.getReplayLap(id, { sessionGuid: ghostInfo.sessionGuid, lap: ghostInfo.lap }) : Promise.resolve(null)), ghostKey)
  const lapData = lapResource.data ?? null

  // ── Engine ─────────────────────────────────────────────────────────────
  const stageRef = useRef<HTMLDivElement>(null)
  const [engine, setEngine] = useState<ReplayEngine | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [contextLost, setContextLost] = useState(false)
  useEffect(() => {
    let created: ReplayEngine
    try { created = new ReplayEngine(stageRef.current!) } catch (error) {
      setEngineError(`3D graphics are unavailable in this browser (${error instanceof Error ? error.message : String(error)}).`)
      return
    }
    created.onContextLost = setContextLost
    if (REPLAY_DEBUG) (window as unknown as { replay: ReplayEngine }).replay = created
    setEngine(created)
    return () => { created.dispose(); setEngine(null) }
  }, [])

  // ── World (once per layout) ────────────────────────────────────────────
  const [world, setWorld] = useState<BuiltWorld | null>(null)
  const [worldStatus, setWorldStatus] = useState<WorldStatus>({ step: 'Loading the session', building: false })
  const latestLap = useRef<ReplayLap | null>(null)
  latestLap.current = lapData
  // A track model for this layout (a converted sim track), when the server has one.
  const trackModels = useResource(() => api.listTrackModels().catch(() => []), '', refreshTick)
  const trackMatch = useMemo(() => (scene ? trackModelFor(trackModels.data ?? [], scene.track) : null), [scene, trackModels.data])
  const [trackChoice, setTrackChoice] = useState<'public' | 'model'>(readTrackChoice)
  const useTrackModel = !!trackMatch && trackChoice === 'model'
  const chooseTrack = (value: 'public' | 'model') => { setTrackChoice(value); saveTrackChoice(value) }
  // Wait for the listing before building, so a model track is not built twice.
  const trackSource = !trackModels.data && !trackModels.error ? null : useTrackModel ? `${trackMatch!.model.id}:${trackMatch!.layout.files.join(',')}:${trackMatch!.model.updatedAt}` : 'public'
  const trackKey = scene && trackSource ? `${scene.track.meanLineGuid}|${trackSource}` : ''
  const haveLap = !!lapData
  const [worldAttempt, setWorldAttempt] = useState(0)
  useEffect(() => {
    if (!engine || !scene || !haveLap || !trackKey) return
    let cancelled = false
    const track = scene.track
    const match = useTrackModel ? trackMatch : null
    const name = shortTrackName(track.trackName)
    setWorld(null)
    engine.setWorld(null)
    setWorldStatus({ step: `Loading ${name} terrain`, building: false })
    const status = (step: string) => { if (!cancelled) setWorldStatus({ step, building: false }) }
    void (async () => {
      let terrain: TerrainData | null = null
      let terrainError: string | null = null
      try {
        const info = await api.getTerrain(track.area, state => {
          if (!cancelled && state === 'building') setWorldStatus({ step: `Building ${name} terrain from USGS elevation data…`, building: true })
        })
        if (cancelled) return
        if (terrainCache?.key !== info.key) {
          status('Downloading elevation and aerial photo')
          const [grid, image] = await Promise.all([
            api.getTerrainGrid(info.key),
            info.imagery ? api.getTerrainImage(info.key).catch(() => null) : Promise.resolve(null),
          ])
          terrainCache = { key: info.key, data: { info, grid, image } }
        }
        terrain = { ...terrainCache!.data, info, sample: latLon => api.sampleTerrain(info.key, latLon) }
      } catch (error) {
        terrainError = error instanceof Error ? error.message : String(error)
        console.warn('[replay] terrain unavailable:', terrainError)
      }
      if (cancelled) return
      const maxAnisotropy = engine.renderer.capabilities.getMaxAnisotropy()
      // The track model when chosen; public data without one or when it fails.
      let modelError: string | null = null
      const buildPublic = async (): Promise<BuiltWorld> => {
        try {
          return await buildWorld(track, terrain, latestLap.current!, maxAnisotropy, status)
        } catch (error) {
          if (!terrain) throw error
          console.warn('[replay] terrain build failed, using flat ground:', error)
          terrainError = error instanceof Error ? error.message : String(error)
          return buildWorld(track, null, latestLap.current!, maxAnisotropy, status)
        }
      }
      let built: BuiltWorld
      if (match) {
        try {
          built = await buildModelWorld(track, terrain, { model: match.model, layout: match.layout, getFile: trackFile }, maxAnisotropy, status)
        } catch (error) {
          if (cancelled) return
          modelError = error instanceof Error ? error.message : String(error)
          console.warn('[replay] track model unusable, using public data:', error)
          built = await buildPublic()
          built.note = `The ${trackModelLabel(match.model)} track could not be loaded (${modelError}); showing public data.`
        }
      } else built = await buildPublic()
      if (cancelled) { built.dispose(); return }
      if (terrainError && built.note && !modelError) built.note += ` (${terrainError})`
      engine.setWorld(built)
      setWorld(built)
      setWorldStatus({ step: '', building: false })
    })().catch(error => { if (!cancelled) setWorldStatus({ step: '', building: false, error: error instanceof Error ? error.message : String(error) }) })
    return () => { cancelled = true }
    // The world depends on the layout only; a new lap reuses it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, trackKey, haveLap, worldAttempt])

  // ── Laps ───────────────────────────────────────────────────────────────
  const lapPath = useMemo(() => (lapData && world && scene ? new LapPath(lapData, world.frame, scene.track.totalDistM) : null), [lapData, world, scene])
  const ghostData = ghostInfo ? ghostResource.data ?? null : null
  const ghostPath = useMemo(() => (ghostData && world && scene ? new LapPath(ghostData, world.frame, scene.track.totalDistM) : null), [ghostData, world, scene])
  useEffect(() => { engine?.setLap(lapPath); engine?.seek(0) }, [engine, lapPath])
  useEffect(() => { engine?.setGhost(ghostPath) }, [engine, ghostPath])
  useEffect(() => { engine?.setView(debugOrbit ? 'orbit' : view) }, [engine, view, debugOrbit])
  const [lines, setLines] = useState({ racing: true, ghost: true })
  useEffect(() => { engine?.setLines(lines.racing, lines.ghost) }, [engine, lines])
  const [rate, setRate] = useState(1)
  useEffect(() => { engine?.setRate(rate) }, [engine, rate])

  // ── Car model ──────────────────────────────────────────────────────────
  const [modelsRevision, setModelsRevision] = useState(0)
  const modelsResource = useResource(() => api.listCarModels(), '', `${refreshTick}:${modelsRevision}`)
  const models = modelsResource.data ?? []
  const vehicleKey = scene?.vehicle.key ?? null
  const preset = useMemo(() => presetFor(vehicleKey), [vehicleKey])
  const matching = useMemo(() => models.filter(m => vehicleKey && m.matches.includes(vehicleKey)).sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt)), [models, vehicleKey])
  const [choice, setChoice] = useState<string | null>(null)
  useEffect(() => setChoice(readChoice(vehicleKey)), [vehicleKey])
  // Several models can match a car: the newest, unless one was picked here.
  const model = choice === 'placeholder' ? null : models.find(m => m.id === choice) ?? matching[0] ?? null
  const [fitDraft, setFitDraft] = useState<CarModelFit | null>(null)
  const [modelStatus, setModelStatus] = useState<string>('')
  const fit = fitDraft ?? model?.fit ?? null
  useEffect(() => setFitDraft(null), [model?.id])
  useEffect(() => {
    if (!engine || !scene) return
    if (!model) { engine.setCar(preset, null, null); setModelStatus(''); return }
    let cancelled = false
    setModelStatus(`Loading ${model.name}…`)
    void (async () => {
      let bytes = modelBytes.get(model.id)
      if (!bytes) {
        bytes = await api.getCarModel(model.id)
        modelBytes.clear()
        modelBytes.set(model.id, bytes)
      }
      const root = await parseGlb(bytes)
      if (cancelled) return
      engine.setCar(preset, root, model.fit)
      setModelStatus('')
    })().catch(error => {
      if (cancelled) return
      engine.setCar(preset, null, null)
      setModelStatus(`${model.name} could not be loaded (${error instanceof Error ? error.message : String(error)}); showing the placeholder.`)
    })
    return () => { cancelled = true }
    // Refits go through setFit; only a new model reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, model?.id, preset, !!scene])
  useEffect(() => { if (engine && fitDraft) engine.setFit(fitDraft) }, [engine, fitDraft])

  const saveFit = async () => {
    if (!model || !fitDraft) return
    setModelStatus('Saving fit…')
    try {
      const saved = await api.updateCarModel(model.id, { fit: fitDraft })
      modelsResource.setData(list => list?.map(m => (m.id === saved.id ? saved : m)))
      setFitDraft(null)
      setModelStatus('Fit saved')
    } catch (error) { setModelStatus(`Could not save the fit: ${error instanceof Error ? error.message : String(error)}`) }
  }

  // ── Controls ───────────────────────────────────────────────────────────
  const setView = useCallback((next: ReplayView) => { setDebugOrbit(false); query({ view: next }) }, [query])
  useEffect(() => {
    if (!engine) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, select, textarea, [contenteditable="true"]')) return
      if (event.key === ' ') { event.preventDefault(); engine.toggle() }
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        engine.seek(engine.time + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 5000 : 1000))
      } else if (event.key === 'c' || event.key === 'C') setView(nextView(view))
      else if (REPLAY_DEBUG && (event.key === 'o' || event.key === 'O')) setDebugOrbit(v => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, view, setView])

  const selectLap = (value: string) => query({ lap: value })
  const selectGhost = (value: string) => query({ ghost: value })
  const selectSession = (guid: string) => go(routeUrl(`/replay/${segment(guid)}`, { view: params.get('view') }))

  // ── Status ─────────────────────────────────────────────────────────────
  const loadingStep = engineError ? null
    : !id && catalogue.data && !sessions.length ? null
    : sceneResource.error || lapResource.error ? null
    : !scene ? 'Loading the session'
    : !lapData ? `Loading ${lapInfo?.label ?? 'the lap'}`
    : worldStatus.error ? null
    : !world ? worldStatus.step || 'Building the track'
    : null
  const error = engineError ?? sceneResource.error ?? lapResource.error ?? worldStatus.error ?? null
  const ghostLabel = ghostInfo ? (ghostInfo.sessionGuid === scene?.sessionGuid ? ghostInfo.label.split(' · ').pop()! : ghostInfo.label) : null
  const units = scene?.units ?? 'imperial'

  return <div className="page-body replay-page">
    <header className="replay-header">
      <div><div className="page-eyebrow">// lap replay</div><h1 className="page-title">3D <span className="accent">Replay</span></h1></div>
      {scene && <p className="replay-header-meta">{scene.track.trackName}{scene.track.configName ? ` · ${scene.track.configName}` : ''}<span>{[scene.vehicle.year, scene.vehicle.make, scene.vehicle.model].filter(Boolean).join(' ')}</span></p>}
    </header>

    <div className="replay-pickers">
      <label>Session<select value={id ?? ''} disabled={!sessions.length} onChange={e => selectSession(e.target.value)}>
        {!id && <option value="">Choose a session</option>}
        {id && !sessions.some(s => s.session_guid === id) && <option value={id}>{scene ? startLabel(scene.sessionStart) : 'This session'}</option>}
        {sessionGroups(sessions).map(([label, rows]) => <optgroup key={label} label={label}>
          {rows.map(s => <option key={s.session_guid} value={s.session_guid}>{startLabel(s.session_start)}{s.best_lap_ms ? ` · best ${msToLap(s.best_lap_ms)}` : ''}{s.video_count ? ' · video' : ''}</option>)}
        </optgroup>)}
      </select></label>
      <label>Lap<select value={lapInfo ? String(lapInfo.lap) : ''} disabled={!scene} onChange={e => selectLap(e.target.value)}>
        {scene?.laps.map(l => <option key={String(l.lap)} value={String(l.lap)}>{l.lap === 'optimal' ? '◆ Optimal' : `${l.isBest ? '★ ' : ''}L${(l.lap as number) + 1}`} · {msToLap(l.durationMs)}{l.hasVideo ? ' · video' : ''}</option>)}
      </select></label>
      <label>Ghost<select value={ghostInfo ? lapValue(ghostInfo) : 'none'} disabled={!scene} onChange={e => selectGhost(e.target.value)}>
        <option value="none">No ghost</option>
        {ghostInfo && !ghostOptions.some(g => g.laps.some(l => lapValue(l) === lapValue(ghostInfo))) && <option value={lapValue(ghostInfo)}>{ghostInfo.label}</option>}
        {ghostOptions.map(g => <optgroup key={g.group} label={g.group}>
          {g.laps.map(l => <option key={lapValue(l)} value={lapValue(l)}>{g.group === 'This session' ? (l.lap === 'optimal' ? '◆ Optimal' : `${l.isBest ? '★ ' : ''}L${(l.lap as number) + 1}`) : l.label} · {msToLap(l.durationMs)}</option>)}
        </optgroup>)}
      </select></label>
      <div className="replay-view-switch" role="group" aria-label="Camera">
        <span>Camera</span>
        <div>{VIEWS.map(v => <button key={v} type="button" className={!debugOrbit && view === v ? 'on' : ''} aria-pressed={!debugOrbit && view === v} onClick={() => setView(v)}>{VIEW_NAMES[v]}</button>)}</div>
      </div>
      {trackMatch && <div className="replay-view-switch" role="group" aria-label="Track">
        <span>Track</span>
        <div>
          <button type="button" className={!useTrackModel ? 'on' : ''} aria-pressed={!useTrackModel} onClick={() => chooseTrack('public')} title="Lidar terrain, aerial photo and the road along Garmin’s line">Public data</button>
          <button type="button" className={useTrackModel ? 'on' : ''} aria-pressed={useTrackModel} onClick={() => chooseTrack('model')} title={trackMatch.model.name}>{trackModelLabel(trackMatch.model)}</button>
        </div>
      </div>}
    </div>

    <div className={`replay-stage ${view === 'garmin' && !debugOrbit ? 'garmin' : ''}`} ref={stageRef}>
      {engine && lapPath && world && <ReplayHud engine={engine} lap={lapPath} ghost={ghostPath} ghostLabel={ghostLabel} units={units} showVideo />}
      {engine && lapPath && world && <PlayOverlay engine={engine} />}
      {engine && world && <ResetView engine={engine} />}
      {world?.note && <div className="replay-note" role="status">{world.note}</div>}
      {!world?.note && lapMissing && <div className="replay-note" role="status">{lapParam === 'optimal' ? 'Garmin has no optimal lap for this session' : `Lap ${Number(lapParam) + 1} is not a valid lap of this session`}; showing {lapInfo!.label.split(' · ').pop()}.</div>}
      {loadingStep && <div className="replay-loading" role="status">
        <span className="replay-spinner" aria-hidden="true" />
        <strong>{loadingStep}</strong>
        {worldStatus.building && !world && <span>The first visit downloads lidar elevation and aerial imagery for the whole circuit; it is kept for every later replay.</span>}
      </div>}
      {error && <div className="replay-loading error" role="alert"><strong>{error}</strong>
        {worldStatus.error && <button className="btn ghost small" type="button" onClick={() => setWorldAttempt(n => n + 1)}>Try again</button>}</div>}
      {!id && catalogue.data && !sessions.length && <div className="replay-loading"><strong>No sessions with laps yet.</strong><NavLink to="/sessions">Download sessions</NavLink></div>}
      {contextLost && <div className="replay-loading" role="status"><strong>Graphics were reset by the system; restoring…</strong></div>}
    </div>

    {engine && lapPath && <Transport engine={engine} lap={lapPath} scene={scene!} rate={rate} onRate={setRate} view={view} onView={setView} />}

    <div className="replay-panels">
      {lapPath && <section className="replay-panel replay-lines">
        <span className="review-eyebrow">On the track</span>
        <label className="replay-check"><input type="checkbox" checked={lines.racing} onChange={e => setLines(l => ({ ...l, racing: e.target.checked }))} />Racing line, by speed</label>
        <div className="replay-legend" aria-hidden={!lines.racing}>
          <div className="replay-legend-bar">{SPEED_RAMP.map(([t, c]) => <i key={t} style={{ background: c }} />)}</div>
          <div className="replay-legend-labels"><span>{Math.round(speedFromMps(lapPath.minSpeed, units))}</span><span>{Math.round(speedFromMps(lapPath.maxSpeed, units))} {speedUnitLabel(units)}</span></div>
        </div>
        {ghostPath && <label className="replay-check"><input type="checkbox" checked={lines.ghost} onChange={e => setLines(l => ({ ...l, ghost: e.target.checked }))} /><i className="replay-swatch ghost" />Ghost line · {ghostLabel}</label>}
        <p className="muted small replay-keys">Space plays and pauses · ← → step a second (⇧ five) · C cycles chase, driver and Garmin cameras · drag the view to look around (chasing: orbit; wheel or pinch zooms) · double-click resets</p>
        {world?.edges && <p className="muted small">Road edges: {world.edges.applied ? `from the aerial photo (${Math.round(world.edges.found * 100)}% of the lap; the tarmac centre sits ${Math.abs(world.edges.medianShiftM).toFixed(1)} m ${world.edges.medianShiftM >= 0 ? 'left' : 'right'} of Garmin’s line, typically)` : `±${((scene?.track.widthM ?? 10) / 2).toFixed(1)} m around Garmin’s line`}{world.trees ? ` · ${world.trees.toLocaleString()} trees from the photo` : ''}</p>}
      </section>}
      {scene && <CarPanel scene={scene} preset={preset} models={models} matching={matching} model={model} fit={fit} dirty={!!fitDraft}
        status={modelStatus} view={view}
        onChoose={value => { setChoice(value); saveChoice(vehicleKey, value) }}
        onFit={setFitDraft} onSave={() => void saveFit()} onReset={() => { setFitDraft(null); if (model) engine?.setFit(model.fit) }} />}
    </div>
  </div>
}

function ResetView({ engine }: { engine: ReplayEngine }) {
  const state = useFrame(engine)
  if (!state?.lookActive) return null
  return <button type="button" className="replay-reset-view" onClick={() => engine.resetLook()} title="Back to the default camera (double-click the view)">Reset view</button>
}

function PlayOverlay({ engine }: { engine: ReplayEngine }) {
  const state = useFrame(engine)
  if (!state || state.playing || (state.timeMs > 0 && state.timeMs < state.durationMs)) return null
  return <button type="button" className="replay-play-overlay" onClick={() => { if (state.timeMs >= state.durationMs) engine.seek(0); engine.play() }} aria-label={state.timeMs >= state.durationMs ? 'Replay the lap' : 'Play the lap'}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
    <span>{state.timeMs >= state.durationMs ? 'Replay lap' : 'Play lap'}</span>
  </button>
}

function Transport({ engine, lap, scene, rate, onRate, view, onView }: {
  engine: ReplayEngine; lap: LapPath; scene: ReplayScene; rate: number; onRate: (rate: number) => void; view: ReplayView; onView: (view: ReplayView) => void
}) {
  const state = useFrame(engine)
  const duration = lap.durationMs
  const markers = useMemo(() => scene.track.corners.map(c => ({ turn: c.turn, name: c.name, at: lap.timeAtDist(c.apexM) })).filter(m => m.at != null), [scene, lap])
  const time = state?.timeMs ?? 0
  return <div className="replay-transport">
    <button type="button" className="replay-play" onClick={() => engine.toggle()} aria-label={state?.playing ? 'Pause' : 'Play'} title={state?.playing ? 'Pause (Space)' : 'Play (Space)'}>
      {state?.playing
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>}
    </button>
    <div className="replay-scrub">
      <input type="range" min={0} max={Math.round(duration)} step={10} value={Math.round(time)} aria-label="Lap time"
        onChange={e => engine.seek(Number(e.target.value))} />
      <div className="replay-scrub-fill" style={{ width: `${duration ? time / duration * 100 : 0}%` }} />
      {markers.map(m => <span key={m.turn} className="replay-scrub-mark" style={{ left: `${m.at! / duration * 100}%` }} title={`${m.turn}${m.name && m.name !== m.turn ? ` · ${m.name}` : ''}`}
        onClick={() => engine.seek(Math.max(0, m.at! - 3000))}><i />{m.turn.replace(/^T/, '')}</span>)}
    </div>
    <span className="replay-time">{clock(time, 1)}<small> / {clock(duration, 1)}</small></span>
    <div className="replay-rates" role="group" aria-label="Playback speed">
      {RATES.map(r => <button key={r} type="button" className={r === rate ? 'on' : ''} aria-pressed={r === rate} onClick={() => onRate(r)}>{r}×</button>)}
    </div>
    <button type="button" className="btn ghost small replay-camera" onClick={() => onView(nextView(view))} title="Next camera (C)">
      {VIEW_NAMES[nextView(view)]} view
    </button>
  </div>
}

const nudge = (fit: CarModelFit, key: 'eyeM' | 'offsetM' | 'dashcamM', axis: number, by: number): CarModelFit => {
  const next = [...(fit[key] ?? [0, 0, 0])] as [number, number, number]
  next[axis] = Math.round((next[axis] + by) * 1000) / 1000
  return { ...fit, [key]: next }
}

function CarPanel({ scene, preset, models, matching, model, fit, dirty, status, view, onChoose, onFit, onSave, onReset }: {
  scene: ReplayScene; preset: ReturnType<typeof presetFor>; models: CarModel[]; matching: CarModel[]; model: CarModel | null; fit: CarModelFit | null
  dirty: boolean; status: string; view: ReplayView
  onChoose: (value: string | null) => void; onFit: (fit: CarModelFit) => void; onSave: () => void; onReset: () => void
}) {
  const others = models.filter(m => !matching.includes(m))
  // A model's default fit is its own car's (a C8 model shown on an Exige lap).
  const modelPreset = model?.matches[0] ? presetFor(model.matches[0]) : preset
  // The Garmin camera's fields fall back to the model's car preset.
  const camera = fit && {
    ...fit,
    dashcamM: fit.dashcamM ?? modelPreset.fit.dashcamM ?? [0, 1.05, 0.2],
    dashcamFovDeg: fit.dashcamFovDeg ?? modelPreset.fit.dashcamFovDeg ?? 120,
    dashcamPitchDeg: fit.dashcamPitchDeg ?? modelPreset.fit.dashcamPitchDeg ?? 0,
  } as CarModelFit & Required<Pick<CarModelFit, 'dashcamM' | 'dashcamFovDeg' | 'dashcamPitchDeg'>>
  const degrees = (label: string, key: 'dashcamPitchDeg' | 'dashcamFovDeg', step: number, minus: string, plus: string) => camera && <div className="replay-fit-row">
    <span>{label}</span>
    <button type="button" className="btn ghost tiny" aria-label={`${label} −${Math.abs(step)}°`} onClick={() => onFit({ ...camera, [key]: camera[key] - step })}>{minus}</button>
    <output>{(key === 'dashcamPitchDeg' ? -camera[key] : camera[key]).toFixed(1)}°</output>
    <button type="button" className="btn ghost tiny" aria-label={`${label} +${Math.abs(step)}°`} onClick={() => onFit({ ...camera, [key]: camera[key] + step })}>{plus}</button>
  </div>
  const row = (label: string, key: 'eyeM' | 'offsetM' | 'dashcamM', axis: number, minus: string, plus: string, step = 0.02) => camera && <div className="replay-fit-row">
    <span>{label}</span>
    <button type="button" className="btn ghost tiny" aria-label={`${label} −${step * 100} cm`} onClick={() => onFit(nudge(camera, key, axis, -step))}>{minus}</button>
    <output>{(camera[key][axis] * 100).toFixed(0)} cm</output>
    <button type="button" className="btn ghost tiny" aria-label={`${label} +${step * 100} cm`} onClick={() => onFit(nudge(camera, key, axis, step))}>{plus}</button>
  </div>
  return <section className="replay-panel replay-car">
    <span className="review-eyebrow">Car</span>
    <label>Model<select value={model ? model.id : 'placeholder'} onChange={e => onChoose(e.target.value)}>
      {matching.length > 0 && <optgroup label={`For ${scene.vehicle.key ?? 'this car'}`}>
        {matching.map((m, i) => <option key={m.id} value={m.id}>{m.name}{i === 0 ? ' (newest)' : ''}</option>)}
      </optgroup>}
      <option value="placeholder">Placeholder · {preset.name}</option>
      {others.length > 0 && <optgroup label="Other models">{others.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</optgroup>}
    </select></label>
    <p className="muted small">{model
      ? <>{model.name}</>
      : <>A simple shape at the {preset.name}’s real size ({preset.lengthM.toFixed(2)} × {preset.widthM.toFixed(2)} × {preset.heightM.toFixed(2)} m). Upload a .glb model of the car in the <NavLink to="/garage">Garage</NavLink>.</>}</p>
    {model && fit && <div className="replay-fit">
      <div className="replay-fit-row"><span>Nose points</span>
        {[0, 90, 180, 270].map(yaw => <button key={yaw} type="button" className={`btn ghost tiny ${fit.yawDeg === yaw ? 'on' : ''}`} onClick={() => onFit({ ...fit, yawDeg: yaw })}>{yaw}°</button>)}
      </div>
      <label className="replay-fit-row"><span>Length</span><input type="number" min={2} max={7} step={0.01} value={Math.round(fit.lengthM * 100) / 100} onChange={e => { const v = Number(e.target.value); if (v >= 2 && v <= 7) onFit({ ...fit, lengthM: v }) }} /> m</label>
      {row('Ride height', 'offsetM', 1, '↓', '↑', 0.01)}
      <p className="muted small">Driver’s eye{view === 'driver' ? '' : ' (switch to the driver view to check)'}:</p>
      {row('Left', 'eyeM', 0, '→', '←')}
      {row('Height', 'eyeM', 1, '↓', '↑')}
      {row('Forward', 'eyeM', 2, '−', '+')}
      <p className="muted small">Garmin camera on the windscreen{view === 'garmin' ? '' : ' (switch to the Garmin view to check)'}:</p>
      {row('Height', 'dashcamM', 1, '↓', '↑', 0.01)}
      {row('Forward', 'dashcamM', 2, '−', '+', 0.01)}
      {degrees('Tilt up', 'dashcamPitchDeg', -0.5, '↓', '↑')}
      {degrees('Lens', 'dashcamFovDeg', 2, '−', '+')}
      <div className="replay-fit-actions">
        <button type="button" className="btn primary small" disabled={!dirty} onClick={onSave}>Save fit</button>
        <button type="button" className="btn ghost small" disabled={!dirty} onClick={onReset}>Undo</button>
        <button type="button" className="btn ghost small" onClick={() => onFit(structuredClone(modelPreset.fit))}>{modelPreset.name} default</button>
      </div>
    </div>}
    {status && <p className="small" role="status">{status}</p>}
  </section>
}
