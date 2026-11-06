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
import { SessionPicker } from '../components/SessionPicker'
import { InlineLoadStatus } from '../components/Loading'
import { SPEED_RAMP } from '../components/chartTheme'
import { carModelFor, presetFor, trackModelFor, type CarModel, type ReplayLap, type ReplayLapInfo, type ReplayLapRef, type ReplayScene } from '../../shared/replay'
import { speedFromMps, speedUnitLabel, tempFromC, tempUnitLabel, type UnitSystem } from '../../shared/units'
import { ReplayEngine, type Alignment, type ReplayView } from '../replay/engine'
import { LapPath } from '../replay/lapPath'
import { buildModelWorld, buildWorld, type BuiltWorld, type TerrainData } from '../replay/world'
import { trackModelLabel } from '../replay/acTrack'
import { parseGlb } from '../replay/car'
import { shortTrackName } from '../replay/geo'
import { REPLAY_DEBUG } from '../replay/debug'
import { ReplayHud, clock, useFrame } from '../replay/Hud'
import { CoachingCallout, CoachingPanel, CoachingToggles, useReplayCoaching } from '../replay/ReplayCoaching'
import { WEATHER_CHOICES, lookFor, type Look, type WeatherChoice } from '../replay/weather'
import '../replay/replay.css'

// The cameras, in the order C cycles them.
const VIEWS = ['chase', 'driver', 'garmin'] as const
const VIEW_NAMES: Record<string, string> = { chase: 'Chase', driver: 'Driver', garmin: 'Garmin' }
const nextView = (view: ReplayView): ReplayView => VIEWS[(VIEWS.indexOf(view as typeof VIEWS[number]) + 1) % VIEWS.length]
const lapValue = (ref: ReplayLapRef) => `${ref.sessionGuid}:${ref.lap}`
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
  // A track model always wins; public data is only the fallback without one.
  const useTrackModel = !!trackMatch
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
  // The laps' GPS lined up with the road (align.ts), or as recorded; after setLap/setGhost above.
  const [align, setAlign] = useState(() => readStored(ALIGN_KEY, ALIGN_CHOICES, 'on') === 'on')
  const [alignment, setAlignment] = useState<Alignment | null>(null)
  useEffect(() => {
    if (!engine) return
    engine.setAlign(align)
    setAlignment(engine.alignment())
  }, [engine, align, lapPath, ghostPath, world])
  // The session's coaching on the track (ReplayCoaching.tsx), after the lap and its alignment above.
  const coaching = useReplayCoaching(engine, world, id ?? null, scene?.units ?? 'imperial', lapPath)

  // ── Weather and graphics ───────────────────────────────────────────────
  const [weather, setWeather] = useState<WeatherChoice>(() => readStored(WEATHER_KEY, WEATHER_CHOICES, 'auto'))
  const look = useMemo(() => (scene ? lookFor(scene, weather) : null), [scene, weather])
  useEffect(() => { if (engine && look) engine.setLook(look) }, [engine, look])
  const [graphics, setGraphics] = useState<GraphicsChoice>(() => readStored(GRAPHICS_KEY, GRAPHICS_CHOICES, 'auto'))
  useEffect(() => { engine?.setGraphics(graphics) }, [engine, graphics])

  // ── Car model ──────────────────────────────────────────────────────────
  // The model chosen and fitted for this car in the Garage (by vehicle key),
  // else the placeholder.
  const modelsResource = useResource(() => api.listCarModels(), '', refreshTick)
  const models = modelsResource.data ?? []
  const vehicleKey = scene?.vehicle.key ?? null
  const preset = useMemo(() => presetFor(vehicleKey), [vehicleKey])
  const model = carModelFor(models, vehicleKey)
  const [modelStatus, setModelStatus] = useState<string>('')
  // The car is in the scene (its model, or the placeholder after a failure).
  const [carReady, setCarReady] = useState(false)
  const loadedModel = useRef<string | null>(null)
  useEffect(() => {
    if (!engine || !scene) return
    loadedModel.current = null
    if (!model) { engine.setCar(preset, null, null); setModelStatus(''); setCarReady(true); return }
    let cancelled = false
    setCarReady(false)
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
      loadedModel.current = model.id
      setModelStatus('')
      setCarReady(true)
    })().catch(error => {
      if (cancelled) return
      engine.setCar(preset, null, null)
      setModelStatus(`${model.name} could not be loaded (${error instanceof Error ? error.message : String(error)}); showing the placeholder.`)
      setCarReady(true)
    })
    return () => { cancelled = true }
    // Refits go through setFit; only a new model reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, model?.id, preset, !!scene])
  // A fit saved in the Garage meanwhile (the list reloads): refit in place.
  const fitKey = model ? JSON.stringify(model.fit) : ''
  useEffect(() => {
    if (engine && model && loadedModel.current === model.id) engine.setFit(model.fit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, fitKey])

  // ── Controls ───────────────────────────────────────────────────────────
  const setView = useCallback((next: ReplayView) => { setDebugOrbit(false); query({ view: next }) }, [query])
  const playerRef = useRef<HTMLDivElement>(null)
  const fullscreen = useFullscreen(playerRef)
  const toggleFullscreen = fullscreen.toggle
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
      else if (event.key === 'f' || event.key === 'F') toggleFullscreen()
      else if (REPLAY_DEBUG && (event.key === 'o' || event.key === 'O')) setDebugOrbit(v => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, view, setView, toggleFullscreen])

  const selectLap = (value: string) => query({ lap: value })
  const selectGhost = (value: string) => query({ ghost: value })

  // ── Status ─────────────────────────────────────────────────────────────
  const error = engineError ?? sceneResource.error ?? lapResource.error ?? worldStatus.error ?? null

  // The view stays under the loading screen until the world, the lap and the
  // car are all in and on the GPU; then it fades in. A new lap on the same
  // world and car does not bring it back.
  const [prepared, setPrepared] = useState<string | null>(null)
  useEffect(() => { setPrepared(null) }, [world])
  const readyKey = engine && world && lapPath && carReady ? `${trackKey}|${model?.id ?? 'placeholder'}` : null
  useEffect(() => {
    if (!engine || !readyKey || prepared === readyKey) return
    let cancelled = false
    void engine.prepare().then(() => { if (!cancelled) setPrepared(readyKey) })
    return () => { cancelled = true }
  }, [engine, readyKey, prepared])
  const ready = !!readyKey && prepared === readyKey
  const loaderSteps: LoaderStep[] = [
    { label: 'Session and lap', state: scene && lapData ? 'done' : 'active',
      detail: !scene ? 'Loading the session' : !lapData ? `Loading ${lapInfo?.label ?? 'the lap'}` : null },
    { label: 'Track', state: world ? 'done' : scene && lapData ? 'active' : 'pending',
      detail: world ? null : worldStatus.step || null,
      note: worldStatus.building && !world ? 'The first visit downloads elevation and imagery for the whole circuit; it is kept for every later replay.' : null },
    { label: 'Car', state: carReady ? 'done' : scene ? 'active' : 'pending', detail: carReady ? null : modelStatus || null },
    { label: 'Getting the view ready', state: ready ? 'done' : readyKey ? 'active' : 'pending' },
  ]
  const loaderTitle = scene ? [shortTrackName(scene.track.trackName), scene.track.configName].filter(Boolean).join(' · ') : 'Loading the replay'
  const showLoader = !error && !engineError && !(!id && catalogue.data && !sessions.length)
  const ghostLabel = ghostInfo ? (ghostInfo.sessionGuid === scene?.sessionGuid ? ghostInfo.label.split(' · ').pop()! : ghostInfo.label) : null
  const units = scene?.units ?? 'imperial'

  return <div className="page-body replay-page">
    <header className="replay-header">
      <div><div className="page-eyebrow">// lap replay</div><h1 className="page-title">3D <span className="accent">Replay</span></h1></div>
    </header>

    <InlineLoadStatus label="sessions" pending={catalogue.pending} error={catalogue.error} hasData={catalogue.data !== undefined} onRetry={catalogue.reload} />
    <div className="replay-pickers">
      <SessionPicker sessions={sessions} selected={id} label="Replay session" loading={catalogue.pending}
        sessionUrl={guid => routeUrl(`/replay/${segment(guid)}`, { view: params.get('view') })}
        fallback={scene ? { title: [scene.track.configName, scene.track.trackName].filter(Boolean).join(' · '), detail: `${startLabel(scene.sessionStart)} · ${[scene.vehicle.make, scene.vehicle.model].filter(Boolean).join(' ')}` } : undefined} />
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
    </div>

    <div className={`replay-player${fullscreen.overlay ? ' pseudo-full' : ''}${ready ? '' : ' waiting'}`} ref={playerRef}>
    <div className={`replay-stage ${view === 'garmin' && !debugOrbit ? 'garmin' : ''}`} ref={stageRef}>
      {engine && lapPath && world && <ReplayHud engine={engine} lap={lapPath} ghost={ghostPath} ghostLabel={ghostLabel} units={units} showVideo />}
      {engine && lapPath && world && <PlayOverlay engine={engine} />}
      {engine && world && <ResetView engine={engine} />}
      {world?.note && <div className="replay-note" role="status">{world.note}</div>}
      {!world?.note && lapMissing && <div className="replay-note" role="status">{lapParam === 'optimal' ? 'Garmin has no optimal lap for this session' : `Lap ${Number(lapParam) + 1} is not a valid lap of this session`}; showing {lapInfo!.label.split(' · ').pop()}.</div>}
      {engine && lapPath && world && <CoachingCallout coaching={coaching} engine={engine} lap={lapPath} />}
      {showLoader && <ReplayLoader active={!ready} title={loaderTitle} subtitle={lapInfo?.label ?? null} steps={loaderSteps} />}
      {error && <div className="replay-loading error" role="alert"><strong>{error}</strong>
        {worldStatus.error && <button className="btn ghost small" type="button" onClick={() => setWorldAttempt(n => n + 1)}>Try again</button>}</div>}
      {!id && catalogue.data && !sessions.length && <div className="replay-loading"><strong>No sessions with laps yet.</strong><NavLink to="/sessions">Download sessions</NavLink></div>}
      {contextLost && <div className="replay-loading" role="status"><strong>Graphics were reset by the system; restoring…</strong></div>}
      {engine && lapPath && <Transport engine={engine} lap={lapPath} scene={scene!} view={debugOrbit ? null : view} onView={setView}
        fullscreen={fullscreen.active} onFullscreen={toggleFullscreen} stage={stageRef} />}
    </div>
    </div>

    <div className="replay-panels">
      {lapPath && id && <CoachingPanel coaching={coaching} engine={engine} lap={lapPath} sessionGuid={id} />}
      {lapPath && <section className="replay-panel replay-lines">
        <span className="review-eyebrow">On the track</span>
        <label className="replay-check"><input type="checkbox" checked={lines.racing} onChange={e => setLines(l => ({ ...l, racing: e.target.checked }))} />Racing line, by speed</label>
        <div className="replay-legend" aria-hidden={!lines.racing}>
          <div className="replay-legend-bar">{SPEED_RAMP.map(([t, c]) => <i key={t} style={{ background: c }} />)}</div>
          <div className="replay-legend-labels"><span>{Math.round(speedFromMps(lapPath.minSpeed, units))}</span><span>{Math.round(speedFromMps(lapPath.maxSpeed, units))} {speedUnitLabel(units)}</span></div>
        </div>
        {ghostPath && <label className="replay-check"><input type="checkbox" checked={lines.ghost} onChange={e => setLines(l => ({ ...l, ghost: e.target.checked }))} /><i className="replay-swatch ghost" />Ghost line · {ghostLabel}</label>}
        <label className="replay-check" title="GPS without corrections is a metre or more off, a little differently each session: shift each lap as a whole so it sits on the road. Off: the GPS as recorded.">
          <input type="checkbox" checked={align} onChange={e => { setAlign(e.target.checked); store(ALIGN_KEY, e.target.checked ? 'on' : 'off') }} />Align to track</label>
        {alignment?.lap && <p className="muted small">{alignmentNote(alignment, ghostLabel)}</p>}
        <CoachingToggles coaching={coaching} />
        <p className="muted small replay-keys">Space plays and pauses · ← → step a second (⇧ five) · C cycles chase, driver and Garmin cameras · drag the view to look around (chasing: orbit; wheel or pinch zooms) · double-click resets</p>
        {world?.edges && <p className="muted small">Road edges: {world.edges.applied ? `from the aerial photo (${Math.round(world.edges.found * 100)}% of the lap; the tarmac centre sits ${Math.abs(world.edges.medianShiftM).toFixed(1)} m ${world.edges.medianShiftM >= 0 ? 'left' : 'right'} of Garmin’s line, typically)` : `±${((scene?.track.widthM ?? 10) / 2).toFixed(1)} m around Garmin’s line`}{world.trees ? ` · ${world.trees.toLocaleString()} trees from the photo` : ''}</p>}
      </section>}
      {scene && <CarPanel scene={scene} preset={preset} model={model} status={modelStatus} />}
      {scene && look && engine && <ConditionsPanel engine={engine} scene={scene} look={look} units={units}
        weather={weather} onWeather={value => { setWeather(value); store(WEATHER_KEY, value) }}
        graphics={graphics} onGraphics={value => { setGraphics(value); store(GRAPHICS_KEY, value) }} />}
    </div>
  </div>
}

// The weather to show (the session's, or a look to check) and the graphics
// level, remembered in this browser.
const WEATHER_KEY = 'catalyst:replay-weather'
const ALIGN_KEY = 'catalyst:replay-align'
const ALIGN_CHOICES = ['on', 'off'] as const
const GRAPHICS_KEY = 'catalyst:replay-graphics'
const GRAPHICS_CHOICES = ['auto', 'high', 'medium'] as const
type GraphicsChoice = typeof GRAPHICS_CHOICES[number]
const WEATHER_NAMES: Record<WeatherChoice, string> = { auto: 'Auto', sunny: 'Sunny', overcast: 'Overcast', wet: 'Wet' }
const GRAPHICS_NAMES: Record<GraphicsChoice, string> = { auto: 'Auto', high: 'High', medium: 'Medium' }

function readStored<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  try { const v = localStorage.getItem(key) as T | null; return v && choices.includes(v) ? v : fallback } catch { return fallback }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* optional */ }
}

// The fit in a line: "GPS shifted 3.5 m onto the road: off it for 436 m of the lap as recorded, 8 m now."
function alignmentNote({ on, lap, ghost }: Alignment, ghostLabel: string | null): string {
  if (!lap) return ''
  const shift = (fit: NonNullable<Alignment['lap']>) => `${Math.hypot(fit.dx, fit.dz).toFixed(1)} m`
  const offRoad = (metres: number) => (metres < 1 ? 'none' : `${Math.round(metres)} m`)
  if (!lap.applied) return 'This lap does not follow the road closely enough to line up; shown as recorded.'
  const ghostPart = ghost?.applied ? ` Ghost${ghostLabel ? ` (${ghostLabel})` : ''}: ${shift(ghost)}.` : ''
  if (!on) return `GPS as recorded: ${offRoad(lap.before.metres)} of the lap off the road (aligned, it moves ${shift(lap)}).`
  return `GPS shifted ${shift(lap)} onto the road: off it for ${offRoad(lap.before.metres)} of the lap as recorded, ${offRoad(lap.after.metres)} now.${ghostPart}`
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]

function ConditionsPanel({ engine, scene, look, units, weather, onWeather, graphics, onGraphics }: {
  engine: ReplayEngine; scene: ReplayScene; look: Look; units: UnitSystem
  weather: WeatherChoice; onWeather: (value: WeatherChoice) => void
  graphics: GraphicsChoice; onGraphics: (value: GraphicsChoice) => void
}) {
  const c = scene.conditions
  const session = [
    c?.description || 'Weather not recorded',
    c?.temperatureC != null ? `${Math.round(tempFromC(c.temperatureC, units))} ${tempUnitLabel(units)}` : null,
    c?.humidityPct != null ? `${Math.round(c.humidityPct)}% humidity` : null,
    c && c.surface !== 'unknown' ? `${c.surface} track` : null,
  ].filter(Boolean).join(' · ')
  const sun = `Sun ${Math.round(look.sun.elevationDeg)}° up in the ${compass(look.sun.azimuthDeg)}${c?.localStart ? ` at ${c.localStart.slice(11, 16)}` : ''}`
  // The level Auto picked: re-rendered only when it changes, not every frame.
  const [level, setLevel] = useState<'high' | 'medium' | null>(null)
  useEffect(() => engine.subscribe(state => setLevel(state.quality)), [engine])
  return <section className="replay-panel replay-conditions">
    <span className="review-eyebrow">Weather and light</span>
    <div className="replay-view-switch" role="group" aria-label="Weather">
      <span>Weather</span>
      <div>{WEATHER_CHOICES.map(v => <button key={v} type="button" className={weather === v ? 'on' : ''} aria-pressed={weather === v} onClick={() => onWeather(v)}
        title={v === 'auto' ? `As the session ran: ${session}` : undefined}>{WEATHER_NAMES[v]}</button>)}</div>
    </div>
    <p className="muted small">{weather === 'auto' ? session : `${look.label}, instead of: ${session}`}. {sun}.</p>
    <div className="replay-view-switch" role="group" aria-label="Graphics">
      <span>Graphics</span>
      <div>{GRAPHICS_CHOICES.map(v => <button key={v} type="button" className={graphics === v ? 'on' : ''} aria-pressed={graphics === v} onClick={() => onGraphics(v)}
        title={v === 'auto' ? 'High, stepping down to Medium if the frame rate drops' : v === 'high' ? 'Grass out to 60 m, sharp shadows near and far' : 'Less grass, softer shadows, for slower graphics'}>{GRAPHICS_NAMES[v]}</button>)}</div>
    </div>
    {graphics === 'auto' && level && <p className="muted small">Now {GRAPHICS_NAMES[level].toLowerCase()}.</p>}
  </section>
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

interface LoaderStep { label: string; state: 'done' | 'active' | 'pending'; detail?: string | null; note?: string | null }

/**
 * Covers the view while the replay loads: a ring filling as the steps
 * finish, and what each one is doing. When everything is ready it fades
 * out (the view fading in beneath it), then leaves the page.
 */
function ReplayLoader({ active, title, subtitle, steps }: { active: boolean; title: string; subtitle: string | null; steps: LoaderStep[] }) {
  const [shown, setShown] = useState(active)
  useEffect(() => { if (active) setShown(true) }, [active])
  if (!shown) return null
  const done = steps.filter(s => s.state === 'done').length
  const current = steps.find(s => s.state === 'active')
  const R = 26, C = 2 * Math.PI * R
  return <div className={`replay-loader${active ? '' : ' leaving'}`} role="status" aria-live="polite" aria-busy={active}
    onTransitionEnd={event => { if (!active && event.target === event.currentTarget) setShown(false) }}>
    <div className="replay-loader-card">
      <svg className="replay-loader-ring" viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r={R} className="track" />
        <circle cx="32" cy="32" r={R} className="fill" strokeDasharray={C} strokeDashoffset={C * (1 - done / steps.length)} />
        <circle cx="32" cy="32" r={R} className="spin" strokeDasharray={`${C * 0.12} ${C}`} />
      </svg>
      <div className="replay-loader-title">
        <strong>{title}</strong>
        {subtitle && <span>{subtitle}</span>}
      </div>
      {current && <p className="replay-loader-current">{current.label}{current.detail ? ` · ${current.detail}` : ''}</p>}
      <ol className="replay-loader-steps">
        {steps.map(step => <li key={step.label} className={step.state}>
          <i aria-hidden="true">{step.state === 'done' ? '✓' : ''}</i>
          <span>{step.label}{step === current && step.detail ? <small>{step.detail}</small> : null}</span>
        </li>)}
      </ol>
      {current?.note && <p className="replay-loader-note">{current.note}</p>}
    </div>
  </div>
}

type FullscreenDocument = Document &{ webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void }
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => void }

/**
 * Full screen for the view and its transport. Where elements cannot go full
 * screen (Safari on iPhone) the player becomes a fixed overlay instead; both
 * close with Escape.
 */
function useFullscreen(target: { current: HTMLElement | null }):{ active: boolean; overlay: boolean; toggle: () => void } {
  const [native, setNative] = useState(false)
  const [overlay, setOverlay] = useState(false)
  useEffect(() => {
    const doc = document as FullscreenDocument
    const sync = () => setNative(!!target.current && (document.fullscreenElement ?? doc.webkitFullscreenElement ?? null) === target.current)
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => { document.removeEventListener('fullscreenchange', sync); document.removeEventListener('webkitfullscreenchange', sync) }
  }, [target])
  useEffect(() => {
    if (!overlay) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOverlay(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay])
  const toggle = useCallback(() => {
    const doc = document as FullscreenDocument
    const el = target.current as FullscreenElement | null
    if (!el) return
    if (overlay) { setOverlay(false); return }
    if (document.fullscreenElement || doc.webkitFullscreenElement) {
      if (document.exitFullscreen) void document.exitFullscreen().catch(() => {})
      else doc.webkitExitFullscreen?.()
      return
    }
    if (el.requestFullscreen) el.requestFullscreen().catch(() => setOverlay(true))
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen()
    else setOverlay(true)
  }, [target, overlay])
  return { active: native || overlay, overlay, toggle }
}

// The transport, over the bottom of the view like a video player's: it
// fades away while the lap plays and the pointer rests, and comes back on
// any movement. The instruments above it keep clear of its height.
const TRANSPORT_IDLE_MS = 2800

function Transport({ engine, lap, scene, view, onView, fullscreen, onFullscreen, stage }: {
  engine: ReplayEngine; lap: LapPath; scene: ReplayScene
  view: ReplayView | null; onView: (view: ReplayView) => void
  fullscreen: boolean; onFullscreen: () => void; stage: { current: HTMLElement | null }
}) {
  const state = useFrame(engine)
  const duration = lap.durationMs
  const markers = useMemo(() => scene.track.corners.map(c => ({ turn: c.turn, name: c.name, at: lap.timeAtDist(c.apexM) })).filter(m => m.at != null), [scene, lap])
  const time = state?.timeMs ?? 0
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bar.current, host = stage.current
    if (!el || !host) return
    const observer = new ResizeObserver(() => host.style.setProperty('--transport-h', `${el.offsetHeight}px`))
    observer.observe(el)
    return () => { observer.disconnect(); host.style.removeProperty('--transport-h') }
  }, [stage])
  const [awake, setAwake] = useState(true)
  const hovering = useRef(false)
  useEffect(() => {
    const host = stage.current
    if (!host) return
    let timer = 0
    const wake = () => {
      setAwake(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => { if (!hovering.current) setAwake(false) }, TRANSPORT_IDLE_MS)
    }
    wake()
    host.addEventListener('pointermove', wake)
    host.addEventListener('pointerdown', wake)
    window.addEventListener('keydown', wake)
    return () => { window.clearTimeout(timer); host.removeEventListener('pointermove', wake); host.removeEventListener('pointerdown', wake); window.removeEventListener('keydown', wake) }
  }, [stage])
  const shown = awake || !state?.playing
  // The instruments follow the bar: down to the bottom edge while it is hidden.
  useEffect(() => {
    const host = stage.current
    if (!host) return
    host.dataset.transport = shown ? 'shown' : 'asleep'
    return () => { delete host.dataset.transport }
  }, [stage, shown])
  return <div ref={bar} className={`replay-transport${shown ? '' : ' asleep'}`}
    onPointerEnter={() => { hovering.current = true }} onPointerLeave={() => { hovering.current = false }}>
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
    <div className="replay-rates replay-cameras" role="group" aria-label="Camera" title="Camera (C cycles)">
      {VIEWS.map(v => <button key={v} type="button" className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => onView(v)}>{VIEW_NAMES[v]}</button>)}
    </div>
    <button type="button" className="replay-fullscreen" onClick={onFullscreen} aria-pressed={fullscreen}
      aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} title={fullscreen ? 'Exit full screen (F or Esc)' : 'Full screen (F)'}>
      {fullscreen
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>}
    </button>
  </div>
}

// Which model the replay draws for this car: chosen and fitted in the Garage.
function CarPanel({ scene, preset, model, status }: { scene: ReplayScene; preset: ReturnType<typeof presetFor>; model: CarModel | null; status: string }) {
  const garage = scene.vehicle.guid ? `/garage/${segment(scene.vehicle.guid)}` : routeUrl('/garage', { vehicle: scene.vehicle.key })
  return <section className="replay-panel replay-car">
    <span className="review-eyebrow">Car</span>
    <p className="muted small">3D model: {model ? model.name : `placeholder shape (${preset.name} size)`} · <NavLink to={garage}>Change in Garage</NavLink></p>
    {status && <p className="small" role="status">{status}</p>}
  </section>
}
