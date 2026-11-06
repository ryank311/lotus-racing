// 3D Replay: one lap driven by the car on a 3D model of the track (USGS
// lidar terrain, NAIP aerial photo, the road on the Garmin mean line; or a
// user-supplied track model such as a converted Assetto Corsa track), seen
// from the driver's seat or a chase camera, with an optional ghost lap, the
// car's inputs and the onboard video picture in picture.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api, msToLap } from '../api'
import { NavLink, useNavigation, useRoute } from '../navigation'
import { routeUrl, segment } from '../routes'
import { useResource } from '../useResource'
import { startLabel } from '../components/reviewTimeline'
import { SessionPicker } from '../components/SessionPicker'
import { GhostPicker, type GhostCourse, type RivalChoice } from '../replay/GhostPicker'
import { InlineLoadStatus } from '../components/Loading'
import { SPEED_RAMP } from '../components/chartTheme'
import { carModelFor, driverGhostParam, parseDriverGhostParam, presetFor, trackModelFor, type CarModel, type CarPreset, type ReplayDriverLap, type ReplayVehicle, type ReplayLap, type ReplayLapInfo, type ReplayLapRef, type ReplayScene } from '../../shared/replay'
import { speedFromMps, speedUnitLabel, tempFromC, tempUnitLabel, type UnitSystem } from '../../shared/units'
import { ReplayEngine, type Alignment, type FrameState, type ReplayView } from '../replay/engine'
import { formatOffset, scrubFraction } from '../replay/compare'
import { LapPath } from '../replay/lapPath'
import { buildModelWorld, buildWorld, type BuiltWorld, type TerrainData } from '../replay/world'
import { trackModelLabel } from '../replay/acTrack'
import { parseGlb } from '../replay/car'
import { shortTrackName } from '../replay/geo'
import { REPLAY_DEBUG } from '../replay/debug'
import { replayProfile } from '../replay/budget'
import { ReplayHud, clock, frameWriter, labelClock, useFrameValue, type FrameSource } from '../replay/Hud'
import { CoachingCallout, CoachingPanel, CoachingToggles, useReplayCoaching } from '../replay/ReplayCoaching'
import { WEATHER_CHOICES, lookFor, type Look, type WeatherChoice } from '../replay/weather'
import '../replay/replay.css'

// The cameras, in the order C cycles them; Both cars only with a compared car.
const VIEWS = ['chase', 'driver', 'garmin', 'both'] as const
type CameraView = typeof VIEWS[number]
const VIEW_NAMES: Record<string, string> = { chase: 'Chase', driver: 'Driver', garmin: 'Garmin', both: 'Both cars' }
const camerasFor = (compared: boolean, view: ReplayView): CameraView[] => VIEWS.filter(v => v !== 'both' || compared || view === 'both')
const nextView = (views: CameraView[], view: ReplayView): ReplayView => views[(views.indexOf(view as CameraView) + 1) % views.length]
// Another driver's car, line and handle (Analysis's second driver colour: clear of the ghost's cyan and the speed ramp).
const RIVAL_COLOR = '#d8b4fe'
const titleCase = (s: string | null) => (s ?? '').trim().toLowerCase().replace(/\b\p{L}/gu, c => c.toUpperCase())
const lapValue = (ref: ReplayLapRef) => `${ref.sessionGuid}:${ref.lap}`
// The last terrain stays in memory while the app is open, so changing laps,
// layouts of the same circuit or sessions does not refetch it.
let terrainCache: { key: string; data: Omit<TerrainData, 'sample'> } | null = null
// Car models' bytes, by id, only until they are parsed: your car and another
// driver's of the same model share a download while either is under way. A
// later parse (another session, a rebuilt context) reads the browser's cache.
const carModels = new Map<string, Promise<ArrayBuffer>>()
async function parseCarModel(id: string) {
  let bytes = carModels.get(id)
  if (!bytes) carModels.set(id, bytes = api.getCarModel(id))
  try {
    return await parseGlb(await bytes)
  } finally {
    if (carModels.get(id) === bytes) carModels.delete(id)
  }
}
// Track model files (the shared base and each layout's), by "id/file": one
// download for the early fetch and the build that parses it, let go once
// parsed (on every device: a rebuild or another layout reads the browser's
// cache, the files being versioned and immutable).
const trackFiles = new Map<string, Promise<ArrayBuffer>>()
// Debugging: what the caches above hold, MiB.
if (REPLAY_DEBUG) Object.assign(window, { replayCaches: async () => {
  const mib = (bytes: number) => Math.round(bytes / 1048576 * 10) / 10
  const sizes = (downloads: Iterable<Promise<ArrayBuffer>>) => Promise.all([...downloads].map(p => p.then(b => b.byteLength, () => 0)))
  const [files, cars] = await Promise.all([sizes(trackFiles.values()), sizes(carModels.values())])
  return {
    trackFiles: mib(files.reduce((a, b) => a + b, 0)),
    carModels: mib(cars.reduce((a, b) => a + b, 0)),
    terrain: mib((terrainCache?.data.grid.byteLength ?? 0) + (terrainCache?.data.image?.size ?? 0)),
  }
} })
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
/** Lets a track file go (parsed, or no longer wanted), unless another download has taken its place. */
function forgetTrackFile(key: string, bytes: Promise<ArrayBuffer>) {
  if (trackFiles.get(key) === bytes) trackFiles.delete(key)
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
  // Another driver's lap: ?ghost=driver:<name>:<session>:<lap>, raced in their own car.
  const rivalRef = useMemo(() => parseDriverGhostParam(ghostParam), [ghostParam])
  const ghostInfo = useMemo(() => {
    if (!scene || !lapInfo || ghostParam === 'none' || rivalRef) return null
    if (ghostParam) {
      const [guid, lap] = [ghostParam.slice(0, ghostParam.lastIndexOf(':')), ghostParam.slice(ghostParam.lastIndexOf(':') + 1)]
      const ref = { sessionGuid: guid, lap: lap === 'optimal' ? 'optimal' as const : Number(lap) }
      return [...scene.laps, ...scene.ghostCandidates].find(l => l.sessionGuid === ref.sessionGuid && l.lap === ref.lap)
        ?? { ...ref, durationMs: 0, label: `${ref.lap === 'optimal' ? 'Optimal' : `L${Number(ref.lap) + 1}`}`, isBest: false, hasVideo: false }
    }
    const best = scene.laps.find(l => l.isBest)
    return best && best.lap !== lapInfo.lap ? best : null
  }, [scene, lapInfo, ghostParam, rivalRef])

  const viewParam = params.get('view')
  // Racing another driver, both cars stay in frame unless a camera was chosen.
  const view: ReplayView = viewParam === 'driver' || viewParam === 'garmin' || viewParam === 'both' || viewParam === 'chase' ? viewParam : rivalRef ? 'both' : 'chase'
  const [debugOrbit, setDebugOrbit] = useState(false)

  const lapKey = id && lapInfo ? `${id}|${lapValue(lapInfo)}` : ''
  const lapResource = useResource<ReplayLap | null>(() => (id && lapInfo ? api.getReplayLap(id, { sessionGuid: lapInfo.sessionGuid, lap: lapInfo.lap }) : Promise.resolve(null)), lapKey)
  const ghostKey = id && ghostInfo ? `${id}|${lapValue(ghostInfo)}` : ''
  const ghostResource = useResource<ReplayLap | null>(() => (id && ghostInfo ? api.getReplayLap(id, { sessionGuid: ghostInfo.sessionGuid, lap: ghostInfo.lap }) : Promise.resolve(null)), ghostKey)
  // Their lap through the server (their backend, read-only), on this scene's mean line.
  const rivalKey = id && rivalRef && scene ? `${id}|${driverGhostParam(rivalRef)}|${scene.units}` : ''
  const rivalResource = useResource<ReplayDriverLap | null>(() => (id && rivalRef && scene ? api.getReplayDriverLap(id, rivalRef, scene.units) : Promise.resolve(null)), rivalKey)
  const rivalData = rivalRef ? rivalResource.data ?? null : null
  const lapData = lapResource.data ?? null

  // ── Engine ─────────────────────────────────────────────────────────────
  const stageRef = useRef<HTMLDivElement>(null)
  const [engine, setEngine] = useState<ReplayEngine | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [contextLost, setContextLost] = useState(false)
  // A new engine (and everything built again) after a lost context it cannot restore in place.
  const [engineAttempt, setEngineAttempt] = useState(0)
  useEffect(() => {
    let created: ReplayEngine
    try { created = new ReplayEngine(stageRef.current!) } catch (error) {
      setEngineError(`3D graphics are unavailable in this browser (${error instanceof Error ? error.message : String(error)}).`)
      return
    }
    created.onContextLost = lost => {
      setContextLost(lost)
      // Its textures were on the GPU only (a constrained device, budget.ts): build the scene again.
      if (!lost && created.needsRebuild) setEngineAttempt(n => n + 1)
    }
    if (REPLAY_DEBUG) (window as unknown as { replay: ReplayEngine }).replay = created
    setEngine(created)
    return () => { created.dispose(); setEngine(null) }
  }, [engineAttempt])

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
  // The model's files start downloading as soon as the layout is known, while
  // the lap and the terrain load (the build below takes the same downloads
  // through trackFile). When the layout changes first, the ones no build took
  // go once they have arrived (one asked for meanwhile still shares them).
  const prefetch = useTrackModel && engine ? trackSource : null
  useEffect(() => {
    if (!prefetch || !trackMatch) return
    const { model, layout } = trackMatch
    const files = model.footprint ? [...layout.files, model.footprint.file] : layout.files
    const started = files.map(file => [`${model.id}/${file}`, trackFile(model.id, file)] as const)
    return () => {
      for (const [key, bytes] of started) {
        const forget = () => forgetTrackFile(key, bytes)
        bytes.then(forget, forget)
      }
    }
    // The source names the files (the model, its layout's files and its version).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefetch])
  // The world is built once per track, as soon as a lap of it has loaded (the
  // public world's fallback road follows that lap's altitude). Choosing
  // another lap, which empties `lapData` while it loads, must not tear the
  // world down and rebuild it: that re-uploads the whole track to the GPU
  // and, a few lap changes in, runs an iPad out of memory.
  const [lapReadyFor, setLapReadyFor] = useState('')
  useEffect(() => { if (lapData && trackKey) setLapReadyFor(trackKey) }, [lapData, trackKey])
  const haveLap = !!trackKey && lapReadyFor === trackKey
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
      // The model's files this build takes, let go once it is done with them.
      const taken: Array<readonly [string, Promise<ArrayBuffer>]> = []
      const getFile = (modelId: string, file: string) => {
        const bytes = trackFile(modelId, file)
        taken.push([`${modelId}/${file}`, bytes])
        return bytes
      }
      let built: BuiltWorld
      try {
        if (match) {
          try {
            built = await buildModelWorld(track, terrain, { model: match.model, layout: match.layout, getFile }, maxAnisotropy, status)
          } catch (error) {
            if (cancelled) return
            modelError = error instanceof Error ? error.message : String(error)
            console.warn('[replay] track model unusable, using public data:', error)
            built = await buildPublic()
            built.note = `The ${trackModelLabel(match.model)} track could not be loaded (${modelError}); showing public data.`
          }
        } else built = await buildPublic()
      } finally {
        // Parsed (or given up on): no copy of the files is kept, on any device.
        for (const [key, bytes] of taken) forgetTrackFile(key, bytes)
      }
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
  const ghostData = rivalRef ? rivalData : ghostInfo ? ghostResource.data ?? null : null
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
      const root = await parseCarModel(model.id)
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

  // ── The other driver's car ─────────────────────────────────────────────
  // Their car from the shared library by their vehicle key (as the Garage
  // assigns it), with its own preset: dimensions, dynamics and the data
  // collector's place. A separate parse of the model, so a car the same as
  // yours is still its own (tinted) object (from the same download while
  // yours is still loading).
  // Who and which car, kept while another lap of theirs loads (no reload of the car).
  const [rivalIdentity, setRivalIdentity] = useState<Pick<ReplayDriverLap, 'driver' | 'vehicle'> | null>(null)
  useEffect(() => {
    if (!rivalRef) setRivalIdentity(null)
    else if (rivalData) setRivalIdentity(current => (current?.driver === rivalData.driver && current.vehicle.key === rivalData.vehicle.key ? current : { driver: rivalData.driver, vehicle: rivalData.vehicle }))
  }, [rivalRef, rivalData])
  const rivalVehicle = rivalIdentity?.vehicle ?? null
  const rivalPreset = useMemo(() => presetFor(rivalVehicle?.key ?? null), [rivalVehicle?.key])
  const rivalModel = rivalVehicle ? carModelFor(models, rivalVehicle.key) : null
  const rivalCar = rivalVehicle ? titleCase(rivalVehicle.model) || titleCase(rivalVehicle.make) || rivalPreset.name : null
  const [rivalStatus, setRivalStatus] = useState('')
  // The key of the car in the scene, once it is (its model, or the placeholder after a failure).
  const [rivalReady, setRivalReady] = useState<string | null>(null)
  const loadedRival = useRef<string | null>(null)
  const rivalName = rivalIdentity?.driver ?? null
  const rivalCarKey = rivalName ? `${rivalName}|${rivalModel?.id ?? 'placeholder'}|${rivalPreset.name}` : null
  useEffect(() => {
    if (!engine) return
    loadedRival.current = null
    if (!rivalName || !rivalCarKey) { engine.setRival(null); setRivalStatus(''); setRivalReady(null); return }
    if (!rivalModel) { engine.setRival({ preset: rivalPreset, model: null, fit: null, color: RIVAL_COLOR, name: rivalName }); setRivalStatus(''); setRivalReady(rivalCarKey); return }
    let cancelled = false
    setRivalReady(null)
    setRivalStatus(`Loading ${rivalName}’s ${rivalModel.name}…`)
    void (async () => {
      const root = await parseCarModel(rivalModel.id)
      if (cancelled) return
      engine.setRival({ preset: rivalPreset, model: root, fit: rivalModel.fit, color: RIVAL_COLOR, name: rivalName })
      loadedRival.current = rivalModel.id
      setRivalStatus('')
      setRivalReady(rivalCarKey)
    })().catch(error => {
      if (cancelled) return
      engine.setRival({ preset: rivalPreset, model: null, fit: null, color: RIVAL_COLOR, name: rivalName })
      setRivalStatus(`${rivalModel.name} could not be loaded (${error instanceof Error ? error.message : String(error)}); ${rivalName}’s car is the placeholder.`)
      setRivalReady(rivalCarKey)
    })
    return () => { cancelled = true }
    // Refits go through setRivalFit; only a new model reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, rivalCarKey])
  const rivalFitKey = rivalModel ? JSON.stringify(rivalModel.fit) : ''
  useEffect(() => {
    if (engine && rivalModel && loadedRival.current === rivalModel.id) engine.setRivalFit(rivalModel.fit)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, rivalFitKey])
  const [marked, setMarked] = useState(true)
  useEffect(() => { engine?.setRivalMarked(marked) }, [engine, marked])

  // ── Controls ───────────────────────────────────────────────────────────
  const setView = useCallback((next: ReplayView) => { setDebugOrbit(false); query({ view: next }) }, [query])
  const playerRef = useRef<HTMLDivElement>(null)
  const fullscreen = useFullscreen(playerRef)
  const toggleFullscreen = fullscreen.toggle
  const cameras = camerasFor(!!ghostPath, view)
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
      } else if (event.key === 'c' || event.key === 'C') setView(nextView(cameras, view))
      // The compared car alone, a tenth (⇧ a second) back or forward along its lap.
      else if (event.key === '[' || event.key === ']' || event.key === '{' || event.key === '}') {
        event.preventDefault()
        engine.setGhostOffset(engine.ghostOffset + (event.key === '[' || event.key === '{' ? -1 : 1) * (event.shiftKey ? 1000 : 100))
      } else if (event.key === 'f' || event.key === 'F') toggleFullscreen()
      else if (REPLAY_DEBUG && (event.key === 'o' || event.key === 'O')) setDebugOrbit(v => !v)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [engine, view, cameras.join(), setView, toggleFullscreen])  // eslint-disable-line react-hooks/exhaustive-deps

  const selectLap = (value: string) => query({ lap: value })
  // Turning to another driver's lap starts on both cars (the default above).
  const selectGhost = (value: string) => query(!rivalRef && parseDriverGhostParam(value) ? { ghost: value, view: null } : { ghost: value })

  // ── Status ─────────────────────────────────────────────────────────────
  const error = engineError ?? sceneResource.error ?? lapResource.error ?? worldStatus.error ?? null

  // The view stays under the loading screen until the world, the lap and the
  // car are all in and on the GPU; then it fades in. A new lap on the same
  // world and car does not bring it back.
  const [prepared, setPrepared] = useState<string | null>(null)
  useEffect(() => { setPrepared(null) }, [world])
  // Another driver's lap and car load with the rest (a failure does not hold the view: it shows a note).
  const rivalError = rivalRef ? rivalResource.error : null
  const rivalPending = !!rivalRef && !rivalError && !(rivalData && rivalCarKey && rivalReady === rivalCarKey)
  const readyKey = engine && world && lapPath && carReady && !rivalPending ? `${trackKey}|${model?.id ?? 'placeholder'}|${rivalRef ? rivalReady ?? 'failed' : 'none'}` : null
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
    ...(rivalRef ? [{
      label: `${rivalIdentity?.driver ?? rivalRef.driver}’s lap and car`, state: (rivalPending ? (scene ? 'active' : 'pending') : 'done') as LoaderStep['state'],
      detail: rivalError ? 'Not available' : !rivalData ? `Loading ${rivalRef.driver}’s L${rivalRef.lap + 1} from their workspace` : rivalStatus || null,
    }] : []),
    { label: 'Getting the view ready', state: ready ? 'done' : readyKey ? 'active' : 'pending' },
  ]
  const loaderTitle = scene ? [shortTrackName(scene.track.trackName), scene.track.configName].filter(Boolean).join(' · ') : 'Loading the replay'
  const showLoader = !error && !engineError && !(!id && catalogue.data && !sessions.length)
  const ghostLabel = rivalRef ? rivalIdentity?.driver ?? rivalRef.driver
    : ghostInfo ? (ghostInfo.sessionGuid === scene?.sessionGuid ? ghostInfo.label.split(' · ').pop()! : ghostInfo.label) : null
  // The compared car's short name on the scrub bar: their car when it is not yours ("Corvette"), else their name, or "Ghost".
  const myCar = titleCase(scene?.vehicle.model ?? null)
  const comparedName = rivalRef ? (rivalCar && rivalCar !== myCar ? rivalCar : ghostLabel!) : 'Ghost'
  const comparedColor = rivalRef ? RIVAL_COLOR : 'var(--cyan)'
  const rivalChoice: RivalChoice | null = rivalRef ? {
    ...rivalRef, driver: rivalIdentity?.driver ?? rivalRef.driver, label: rivalData?.label ?? null, durationMs: rivalData?.durationMs ?? 0,
    car: rivalVehicle ? [titleCase(rivalVehicle.make), titleCase(rivalVehicle.model)].filter(Boolean).join(' ') || null : null, error: rivalError,
  } : null
  const ghostCourse: GhostCourse | null = scene ? {
    identity: { configurationId: scene.track.configurationId ?? null, meanLineGuid: scene.track.meanLineGuid, trackLabel: `${scene.track.trackName ?? ''} · ${scene.track.configName ?? ''}` },
    label: [shortTrackName(scene.track.trackName), scene.track.configName].filter(Boolean).join(' · '),
  } : null
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
      <GhostPicker groups={ghostOptions} ghost={ghostInfo} rival={rivalChoice} current={lapInfo} sessionGuid={scene?.sessionGuid ?? null}
        course={ghostCourse} onSelect={selectGhost} disabled={!scene} />
    </div>

    <div className={`replay-player${fullscreen.overlay ? ' pseudo-full' : ''}${ready ? '' : ' waiting'}`} ref={playerRef}>
    <div className={`replay-stage ${view === 'garmin' && !debugOrbit ? 'garmin' : ''}`} ref={stageRef}>
      {engine && lapPath && world && <ReplayHud engine={engine} lap={lapPath} ghost={ghostPath} ghostLabel={ghostLabel} units={units} showVideo
        rival={rivalRef && ghostPath ? { name: ghostLabel!, color: RIVAL_COLOR } : null} />}
      {engine && lapPath && world && <PlayOverlay engine={engine} />}
      {engine && world && <ResetView engine={engine} />}
      {world?.note && <div className="replay-note" role="status">{world.note}</div>}
      {!world?.note && rivalError && <div className="replay-note" role="status">{rivalRef!.driver}’s lap could not be loaded: {rivalError}</div>}
      {!world?.note && !rivalError && lapMissing && <div className="replay-note" role="status">{lapParam === 'optimal' ? 'Garmin has no optimal lap for this session' : `Lap ${Number(lapParam) + 1} is not a valid lap of this session`}; showing {lapInfo!.label.split(' · ').pop()}.</div>}
      {engine && lapPath && world && <CoachingCallout coaching={coaching} engine={engine} lap={lapPath} />}
      {showLoader && <ReplayLoader active={!ready} title={loaderTitle} subtitle={lapInfo?.label ?? null} steps={loaderSteps} />}
      {error && <div className="replay-loading error" role="alert"><strong>{error}</strong>
        {worldStatus.error && <button className="btn ghost small" type="button" onClick={() => setWorldAttempt(n => n + 1)}>Try again</button>}</div>}
      {!id && catalogue.data && !sessions.length && <div className="replay-loading"><strong>No sessions with laps yet.</strong><NavLink to="/sessions">Download sessions</NavLink></div>}
      {contextLost && <div className="replay-loading" role="status"><strong>Graphics were reset by the system; restoring the scene…</strong>
        <button className="btn ghost small" type="button" onClick={() => { setContextLost(false); setEngineAttempt(n => n + 1) }}>Reload the 3D view</button></div>}
      {engine && lapPath && <Transport engine={engine} lap={lapPath} scene={scene!} view={debugOrbit ? null : view} views={cameras} onView={setView}
        fullscreen={fullscreen.active} onFullscreen={toggleFullscreen} stage={stageRef}
        compared={ghostPath ? { name: comparedName, label: ghostLabel ?? comparedName, color: comparedColor } : null} />}
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
        {ghostPath && <label className="replay-check"><input type="checkbox" checked={lines.ghost} onChange={e => setLines(l => ({ ...l, ghost: e.target.checked }))} /><i className={`replay-swatch ${rivalRef ? 'rival' : 'ghost'}`} />{rivalRef ? `${ghostLabel}’s line` : `Ghost line · ${ghostLabel}`}</label>}
        {rivalRef && ghostPath && <label className="replay-check" title="A tag over their car and a faint tint of their colour, to tell it from yours"><input type="checkbox" checked={marked} onChange={e => setMarked(e.target.checked)} />Tag {ghostLabel}’s car</label>}
        <label className="replay-check" title="GPS without corrections is a metre or more off, a little differently each session: shift each lap as a whole so it sits on the road. Off: the GPS as recorded.">
          <input type="checkbox" checked={align} onChange={e => { setAlign(e.target.checked); store(ALIGN_KEY, e.target.checked ? 'on' : 'off') }} />Align to track</label>
        {alignment?.lap && <p className="muted small">{alignmentNote(alignment, ghostLabel, !!rivalRef)}</p>}
        <CoachingToggles coaching={coaching} />
        <p className="muted small replay-keys">Space plays and pauses · ← → step a second (⇧ five) · C cycles chase, driver and Garmin cameras{ghostPath ? ' and both cars' : ''} · drag the view to look around (chasing: orbit; wheel or pinch zooms) · double-click resets{ghostPath ? ` · [ ] move ${rivalRef ? `${ghostLabel}’s car` : 'the ghost'} alone a tenth (⇧ a second)` : ''}</p>
        {world?.edges && <p className="muted small">Road edges: {world.edges.applied ? `from the aerial photo (${Math.round(world.edges.found * 100)}% of the lap; the tarmac centre sits ${Math.abs(world.edges.medianShiftM).toFixed(1)} m ${world.edges.medianShiftM >= 0 ? 'left' : 'right'} of Garmin’s line, typically)` : `±${((scene?.track.widthM ?? 10) / 2).toFixed(1)} m around Garmin’s line`}{world.trees ? ` · ${world.trees.toLocaleString()} trees from the photo` : ''}</p>}
      </section>}
      {scene && <CarPanel scene={scene} preset={preset} model={model} status={modelStatus}
        rival={rivalRef && rivalVehicle ? { driver: ghostLabel!, vehicle: rivalVehicle, preset: rivalPreset, model: rivalModel, status: rivalStatus } : null} />}
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
const GRAPHICS_CHOICES = ['auto', 'high', 'medium', 'low'] as const
type GraphicsChoice = typeof GRAPHICS_CHOICES[number]
const WEATHER_NAMES: Record<WeatherChoice, string> = { auto: 'Auto', sunny: 'Sunny', overcast: 'Overcast', wet: 'Wet' }
const GRAPHICS_NAMES: Record<GraphicsChoice, string> = { auto: 'Auto', high: 'High', medium: 'Medium', low: 'Low' }
const GRAPHICS_TITLES: Record<GraphicsChoice, string> = {
  auto: replayProfile().constrained ? `Low on this device (${replayProfile().reason}): it has the least memory to spare` : 'High, stepping down to Medium if the frame rate drops',
  high: 'Grass out to 60 m, sharp shadows near and far',
  medium: 'Less grass, softer shadows, for slower graphics',
  low: 'No grass, smaller shadows, the Garmin lens without smoothing: for a small memory budget (iPhone and iPad)',
}

function readStored<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  try { const v = localStorage.getItem(key) as T | null; return v && choices.includes(v) ? v : fallback } catch { return fallback }
}
function store(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* optional */ }
}

// The fit in a line: "GPS shifted 3.5 m onto the road: off it for 436 m of the lap as recorded, 8 m now."
function alignmentNote({ on, lap, ghost }: Alignment, ghostLabel: string | null, rival = false): string {
  if (!lap) return ''
  const shift = (fit: NonNullable<Alignment['lap']>) => `${Math.hypot(fit.dx, fit.dz).toFixed(1)} m`
  const offRoad = (metres: number) => (metres < 1 ? 'none' : `${Math.round(metres)} m`)
  if (!lap.applied) return 'This lap does not follow the road closely enough to line up; shown as recorded.'
  const ghostPart = ghost?.applied ? ` ${rival ? `${ghostLabel}’s lap` : `Ghost${ghostLabel ? ` (${ghostLabel})` : ''}`}: ${shift(ghost)}.` : ''
  if (!on) return `GPS as recorded: ${offRoad(lap.before.metres)} of the lap off the road (aligned, it moves ${shift(lap)}).`
  return `GPS shifted ${shift(lap)} onto the road: off it for ${offRoad(lap.before.metres)} of the lap as recorded, ${offRoad(lap.after.metres)} now.${ghostPart}`
}

const frameQuality = (state: FrameState) => state.quality

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
  const level = useFrameValue<FrameState['quality'] | null>(engine, frameQuality, null)
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
        title={GRAPHICS_TITLES[v]}>{GRAPHICS_NAMES[v]}</button>)}</div>
    </div>
    {graphics === 'auto' && level && <p className="muted small">Now {GRAPHICS_NAMES[level].toLowerCase()}.</p>}
  </section>
}

// What the overlays follow of the frames (each renders again only when its value changes).
const isLookActive = (state: FrameState) => state.lookActive
const isPlaying = (state: FrameState) => state.playing
const hasComparedCar = (state: FrameState) => state.compared != null
// Paused at the start or the end of the lap: the big button offers to play it, or to play it again.
const playOffer = (state: FrameState): 'play' | 'replay' | null =>
  state.playing || (state.timeMs > 0 && state.timeMs < state.durationMs) ? null : state.timeMs >= state.durationMs ? 'replay' : 'play'

function ResetView({ engine }: { engine: ReplayEngine }) {
  const lookActive = useFrameValue(engine, isLookActive, false)
  if (!lookActive) return null
  return <button type="button" className="replay-reset-view" onClick={() => engine.resetLook()} title="Back to the default camera (double-click the view)">Reset view</button>
}

function PlayOverlay({ engine }: { engine: ReplayEngine }) {
  const offer = useFrameValue(engine, playOffer, null)
  if (!offer) return null
  const again = offer === 'replay'
  return <button type="button" className="replay-play-overlay" onClick={() => { if (again) engine.seek(0); engine.play() }} aria-label={again ? 'Replay the lap' : 'Play the lap'}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>
    <span>{again ? 'Replay lap' : 'Play lap'}</span>
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

// The compared car (a ghost or another driver's) on the transport: its short name, full label and colour.
interface ComparedCar { name: string; label: string; color: string }

/**
 * The frames for the transport's own writes (its clock and bar, the compared
 * car's handle and clock), passed on while it shows. Asleep and faded out,
 * the bar is not written; the latest frame is, as soon as it shows again.
 */
class TransportFrames implements FrameSource {
  hidden = false
  private latest: FrameState | null = null
  private listeners = new Set<(state: FrameState) => void>()

  subscribe(listener: (state: FrameState) => void): () => void {
    this.listeners.add(listener)
    if (this.latest && !this.hidden) listener(this.latest)
    return () => { this.listeners.delete(listener) }
  }

  publish(state: FrameState) {
    this.latest = state
    if (!this.hidden) for (const listener of this.listeners) listener(state)
  }

  show() {
    if (!this.hidden) return
    this.hidden = false
    if (this.latest) this.publish(this.latest)
  }
}

function Transport({ engine, lap, scene, view, views, onView, fullscreen, onFullscreen, stage, compared }: {
  engine: ReplayEngine; lap: LapPath; scene: ReplayScene
  view: ReplayView | null; views: readonly CameraView[]; onView: (view: ReplayView) => void
  fullscreen: boolean; onFullscreen: () => void; stage: { current: HTMLElement | null }
  compared: ComparedCar | null
}) {
  const playing = useFrameValue(engine, isPlaying, false)
  const comparing = useFrameValue(engine, hasComparedCar, false) && !!compared
  const duration = lap.durationMs
  const markers = useMemo(() => scene.track.corners.map(c => ({ turn: c.turn, name: c.name, at: lap.timeAtDist(c.apexM) })).filter(m => m.at != null), [scene, lap])
  const bar = useRef<HTMLDivElement>(null)
  const scrub = useRef<HTMLDivElement>(null)
  const range = useRef<HTMLInputElement>(null), fill = useRef<HTMLDivElement>(null), clockText = useRef<HTMLSpanElement>(null)
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
  const shown = awake || !playing
  // The instruments follow the bar: down to the bottom edge while it is hidden.
  useEffect(() => {
    const host = stage.current
    if (!host) return
    host.dataset.transport = shown ? 'shown' : 'asleep'
    return () => { delete host.dataset.transport }
  }, [stage, shown])
  // Asleep, the bar stops being written once it has faded out (on a phone it
  // stays in view below the stage, so it never fades, and is written on).
  const frames = useMemo(() => new TransportFrames(), [])
  useLayoutEffect(() => {
    const el = bar.current
    if (!el) return
    const faded = () => !shown && getComputedStyle(el).opacity === '0'
    // Just put to sleep, it is still fading (opacity 1 as the transition starts).
    frames.hidden = faded()
    const onFaded = (event: TransitionEvent) => {
      if (event.target !== el || event.propertyName !== 'opacity') return
      if (faded()) frames.hidden = true
      else frames.show()
    }
    el.addEventListener('transitionend', onFaded)
    const unsubscribe = engine.subscribe(state => frames.publish(state))
    return () => { unsubscribe(); el.removeEventListener('transitionend', onFaded) }
  }, [engine, frames, shown])
  // The range input is invisible (the fill shows the time): its value and
  // spoken time follow a few times a second, and at once before a key steps
  // it or it takes focus.
  const valueText = (ms: number) => `${clock(ms, 1)}${compared ? `, ${compared.label} with it` : ''}`
  const freshen = () => {
    const el = range.current
    if (!el) return
    el.value = String(Math.round(engine.time))
    el.setAttribute('aria-valuetext', valueText(engine.time))
  }
  useLayoutEffect(() => {
    const write = frameWriter(), labelsDue = labelClock()
    return frames.subscribe(state => {
      const time = state.timeMs
      write.text(clockText.current, clock(time, 1))
      write.style(fill.current, 'width', `${duration ? (time / duration * 100).toFixed(3) : 0}%`)
      const el = range.current
      if (el && labelsDue(state)) {
        // Against the element itself: the pointer and freshen set these too.
        const value = String(Math.round(time)), text = valueText(time)
        if (el.value !== value) el.value = value
        if (el.getAttribute('aria-valuetext') !== text) el.setAttribute('aria-valuetext', text)
      }
    })
    // valueText reads the compared car's label.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frames, duration, compared?.label])
  return <div ref={bar} className={`replay-transport${shown ? '' : ' asleep'}${comparing ? ' compared' : ''}`}
    onPointerEnter={() => { hovering.current = true }} onPointerLeave={() => { hovering.current = false }}>
    <button type="button" className="replay-play" onClick={() => engine.toggle()} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}>
      {playing
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor" /></svg>}
    </button>
    <div className={`replay-scrub${comparing ? ' has-ghost' : ''}`} ref={scrub}
      style={compared ? { ['--compared' as string]: compared.color } : undefined}>
      {compared && comparing && <ComparedHandle engine={engine} frames={frames} car={compared} duration={duration} scrub={scrub} />}
      <input ref={range} type="range" min={0} max={Math.round(duration)} step={10} defaultValue={0} aria-label="Lap time"
        onKeyDown={freshen} onFocus={freshen} onChange={e => engine.seek(Number(e.target.value))} />
      <div className="replay-scrub-fill" ref={fill} />
      {markers.map(m => <span key={m.turn} className="replay-scrub-mark" style={{ left: `${m.at! / duration * 100}%` }} title={`${m.turn}${m.name && m.name !== m.turn ? ` · ${m.name}` : ''}`}
        onClick={() => engine.seek(Math.max(0, m.at! - 3000))}><i />{m.turn.replace(/^T/, '')}</span>)}
    </div>
    <span className="replay-time"><span ref={clockText} /><small> / {clock(duration, 1)}</small></span>
    {compared && comparing && <ComparedClock engine={engine} frames={frames} car={compared} />}
    <div className="replay-rates replay-cameras" role="group" aria-label="Camera" title="Camera (C cycles)">
      {views.map(v => <button key={v} type="button" className={view === v ? 'on' : ''} aria-pressed={view === v} onClick={() => onView(v)}
        title={v === 'both' ? 'Keeps your car and the other in view' : undefined}>{VIEW_NAMES[v]}</button>)}
    </div>
    <button type="button" className="replay-fullscreen" onClick={onFullscreen} aria-pressed={fullscreen}
      aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} title={fullscreen ? 'Exit full screen (F or Esc)' : 'Full screen (F)'}>
      {fullscreen
        ? <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" strokeWidth="2" /></svg>}
    </button>
  </div>
}

/**
 * The compared car's own handle on the scrub bar, above yours: drag it (or
 * use the arrow keys on it) to move only that car along its lap, so the two
 * meet at a corner; your handle moves both and keeps the gap between them.
 */
function ComparedHandle({ engine, frames, car, duration, scrub }: {
  engine: ReplayEngine; frames: FrameSource; car: ComparedCar; duration: number; scrub: { current: HTMLElement | null }
}) {
  const grab = useRef(0)
  const band = useRef<HTMLDivElement>(null), handle = useRef<HTMLDivElement>(null)
  // Its lap's length (End puts it at its finish).
  const length = useRef(0)
  useLayoutEffect(() => {
    const write = frameWriter(), labelsDue = labelClock()
    return frames.subscribe(state => {
      const c = state.compared
      if (!c) return
      length.current = c.durationMs
      const own = Math.min(Math.max(0, c.timeMs), c.durationMs)
      const at = scrubFraction(own, duration) * 100, mine = scrubFraction(state.timeMs, duration) * 100
      write.style(band.current, 'left', `${Math.min(at, mine).toFixed(3)}%`)
      write.style(band.current, 'width', `${Math.abs(at - mine).toFixed(3)}%`)
      write.style(handle.current, 'left', `${at.toFixed(3)}%`)
      write.toggle(handle.current, 'off', c.timeMs > c.durationMs || c.timeMs < 0)
      if (labelsDue(state)) {
        write.attr(handle.current, 'aria-valuemax', String(Math.round(c.durationMs)))
        write.attr(handle.current, 'aria-valuenow', String(Math.round(own)))
        write.attr(handle.current, 'aria-valuetext', `${clock(own, 1)}, ${formatOffset(c.offsetMs)} from your clock`)
      }
    })
  }, [frames, duration])
  const move = (clientX: number) => {
    const r = scrub.current?.getBoundingClientRect()
    if (!r || !r.width) return
    engine.seekGhost(Math.min(1, Math.max(0, (clientX - grab.current - r.left) / r.width)) * duration)
  }
  const step = (ms: number) => engine.setGhostOffset(engine.ghostOffset + ms)
  return <>
    <div className="replay-scrub-offset" aria-hidden="true" ref={band} />
    <div ref={handle} className="replay-scrub-ghost" role="slider" tabIndex={0}
      aria-label={`${car.label}’s place on its own lap`} aria-valuemin={0}
      title={`${car.label}: drag to move only this car along its lap (← → a tenth, ⇧ a second)`}
      onPointerDown={e => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        e.preventDefault()
        const r = e.currentTarget.getBoundingClientRect()
        grab.current = e.clientX - (r.left + r.width / 2)
        try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* gone */ }
      }}
      onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e.clientX) }}
      onPointerUp={e => { try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* gone */ } }}
      onKeyDown={e => {
        const keys: Record<string, () => void> = {
          ArrowLeft: () => step(e.shiftKey ? -1000 : -100), ArrowDown: () => step(e.shiftKey ? -1000 : -100),
          ArrowRight: () => step(e.shiftKey ? 1000 : 100), ArrowUp: () => step(e.shiftKey ? 1000 : 100),
          PageDown: () => step(-1000), PageUp: () => step(1000),
          Home: () => engine.seekGhost(0), End: () => engine.seekGhost(length.current),
        }
        if (!keys[e.key]) return
        e.preventDefault(); e.stopPropagation()
        keys[e.key]()
      }}>
      <i /><b />
    </div>
  </>
}

// Where the compared car is against yours on the track: "level", "3.2 m ahead", "40 m behind".
const aheadText = (aheadM: number | null) => aheadM == null ? null
  : Math.abs(aheadM) < 0.5 ? 'level' : `${Math.abs(aheadM) < 10 ? Math.abs(aheadM).toFixed(1) : Math.round(Math.abs(aheadM))} m ${aheadM > 0 ? 'ahead' : 'behind'}`

/** The compared car's clock against yours, and the buttons that set it: Side by side and Sync. */
function ComparedClock({ engine, frames, car }: { engine: ReplayEngine; frames: FrameSource; car: ComparedCar }) {
  const [missed, setMissed] = useState(false)
  useEffect(() => { if (missed) { const t = window.setTimeout(() => setMissed(false), 2500); return () => window.clearTimeout(t) } }, [missed])
  // These render again when they change; the clock and the distance are written per frame.
  const [synced, setSynced] = useState(true)
  const [onTrack, setOnTrack] = useState(false)
  const summary = useRef<HTMLSpanElement>(null), offset = useRef<HTMLElement>(null), ahead = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const write = frameWriter(), labelsDue = labelClock()
    let wasSynced: boolean | null = null, wasOnTrack: boolean | null = null
    return frames.subscribe(state => {
      const c = state.compared
      if (!c) return
      const near = aheadText(c.aheadM)
      const isSynced = Math.abs(c.offsetMs) < 5, isOnTrack = near != null
      if (isSynced !== wasSynced) { wasSynced = isSynced; setSynced(isSynced) }
      if (isOnTrack !== wasOnTrack) { wasOnTrack = isOnTrack; setOnTrack(isOnTrack) }
      write.text(offset.current, formatOffset(c.offsetMs))
      write.text(ahead.current, missed ? 'not on its lap here' : near ?? '')
      if (labelsDue(state)) write.attr(summary.current, 'title', `${car.label}’s lap time minus yours: ${formatOffset(c.offsetMs)}${near ? ` · on track: ${near}` : ''}`)
    })
  }, [frames, car.label, missed, onTrack])
  return <div className="replay-sync" role="group" aria-label={`${car.label}’s clock`}>
    <span className="replay-offset" ref={summary} aria-live="off">
      <i style={{ background: car.color }} aria-hidden="true" />{car.name} <b ref={offset} />{onTrack && <small ref={ahead} />}
    </span>
    <div className="replay-rates">
      <button type="button" onClick={() => setMissed(!engine.ghostSideBySide())} title={`Put ${car.label} level with your car here (the same spot on the track)`}>Side by side</button>
      <button type="button" className={synced ? '' : 'on'} disabled={synced} onClick={() => engine.syncGhost()} title="Back on the normal timelines: both laps from their own starts">Sync</button>
    </div>
  </div>
}

// Which model the replay draws for this car: chosen and fitted in the Garage.
// Another driver's car: the shared library's model for their vehicle (the Garage assigns one per car), with its preset.
interface RivalCarInfo { driver: string; vehicle: ReplayVehicle; preset: CarPreset; model: CarModel | null; status: string }

function CarPanel({ scene, preset, model, status, rival }: { scene: ReplayScene; preset: CarPreset; model: CarModel | null; status: string; rival: RivalCarInfo | null }) {
  const garage = scene.vehicle.guid ? `/garage/${segment(scene.vehicle.guid)}` : routeUrl('/garage', { vehicle: scene.vehicle.key })
  return <section className="replay-panel replay-car">
    <span className="review-eyebrow">Car</span>
    <p className="muted small">3D model: {model ? model.name : `placeholder shape (${preset.name} size)`} · <NavLink to={garage}>Change in Garage</NavLink></p>
    {status && <p className="small" role="status">{status}</p>}
    {rival && <p className="muted small"><i className="replay-swatch rival" /> {rival.driver}’s {[rival.vehicle.make, rival.vehicle.model].filter(Boolean).map(v => titleCase(v)).join(' ') || 'car'}: {rival.model ? rival.model.name : `placeholder shape (${rival.preset.name} size)`}
      {rival.vehicle.key && <> · <NavLink to={routeUrl('/garage', { vehicle: rival.vehicle.key })}>Model in Garage</NavLink></>}</p>}
    {rival?.status && <p className="small" role="status">{rival.status}</p>}
  </section>
}
