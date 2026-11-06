// Coaching in the 3D replay (replay:coaching, src/shared/replayCoaching.ts):
// a note floating over each coached corner, the best pass's brake, minimum
// speed and throttle points (and this lap's brake) as stripes and small
// boards by the road, the coached stretches lit along the road's edges, and a
// suggested line beside the racing line.
//
// Everything is anchored by distance along the mean line: a station of the
// road model, across to the road's drawn edges (a track model's own edges
// when it has them) and down onto its surface, as the engine rests the car.
// The suggested line is GPS (lat/lon) and goes through LapPath.toLocal, so it
// takes the lap's "Align to track" shift; refreshLine() redraws it when the
// shift changes (ReplayEngine.onAlignment).
//
// Cheap: six draw calls at most (zones, stripes, line, posts, boards,
// notes), text from one canvas atlas, billboards sized in the vertex shader,
// nothing allocated per frame.

import * as THREE from 'three'
import type { ReplayCoaching, ReplayCoachMarks, ReplayCoachPoint, ReplayCoachTone } from '../../shared/replayCoaching'
import { speedFromMps, speedUnitLabel, type UnitSystem } from '../../shared/units'
import { PALETTE } from '../components/chartTheme'
import type { ReplayWorld } from './engine'
import type { LapPath } from './lapPath'
import type { Across } from './align'

export const TONE_COLOR: Record<ReplayCoachTone, string> = { loss: PALETTE.red, gain: PALETTE.green, coach: PALETTE.amber, note: PALETTE.teal }
/** The best pass's marks, this lap's, the coach's targets, the suggested line. */
// The line is pink and dashed: the racing line runs violet to orange by speed.
export const MARK_COLOR = { best: PALETTE.cyan, you: PALETTE.signal, coach: PALETTE.amber, throttle: PALETTE.green, line: PALETTE.pink, coachLine: PALETTE.text }

export interface CoachingLayers {
  /** The notes floating over the corners. */
  labels: boolean
  /** Brake, minimum-speed and throttle points. */
  marks: boolean
  /** The coached stretches along the road's edges. */
  zones: boolean
  /** The suggested line. */
  line: boolean
}

// Over the road surface, above the racing line (0.04 m) and its paint.
const LIFT = 0.06
const NOTE_HEIGHT_M = 6
const BOARD_HEIGHT_M = 1.05
const STRIPE_DEPTH_M = 0.7
// The coached stretch: a band this far inside each edge (clear of kerbs), this wide.
const ZONE_INSET_M = 0.3
const ZONE_BAND_M = 0.4
const LINE_WIDTH_M = 0.2
// The suggested line's dashes: this long in every so many metres.
const LINE_DASH_M = [4, 6]
// Distances from the camera (m) over which billboards fade in and out.
const NOTE_FADE: [number, number, number, number] = [16, 34, 480, 650]
const BOARD_FADE: [number, number, number, number] = [2, 6, 170, 240]
// Along the track (m), so a corner across the infield or just beyond does
// not crowd the one ahead: a note shows from this far before its corner (or
// once the car passes the previous coached corner) to just past it, fading
// in and out over the ramp; boards for the last few hundred metres.
const NOTE_AHEAD_M = 700, NOTE_PAST_M = 60, NOTE_RAMP: [number, number] = [40, 40]
const BOARD_AHEAD_M = 400, BOARD_PAST_M = 30, BOARD_RAMP: [number, number] = [80, 20]
// Canvas pixels per CSS pixel of text in the atlas (sharp on retina).
const ATLAS_SCALE = 2
const ATLAS_WIDTH = 2048
const POST_COLOR = new THREE.Color(PALETTE.textDim)

/** Where a lap reached its marks against the best pass: "11 m early", "+1.2 mph". */
export function compareMarks(lap: ReplayCoachMarks | undefined, best: ReplayCoachMarks | null, units: UnitSystem) {
  const out: { brake: string | null; vmin: string | null; throttle: string | null; time: string | null } = { brake: null, vmin: null, throttle: null, time: null }
  if (!lap || !best) return out
  if (lap.brakeM != null && best.brakeM != null) {
    const d = lap.brakeM - best.brakeM
    out.brake = Math.abs(d) < 2 ? 'the same' : `${Math.round(Math.abs(d))} m ${d < 0 ? 'earlier' : 'later'}`
  }
  if (lap.vminMps != null && best.vminMps != null) {
    const d = speedFromMps(lap.vminMps - best.vminMps, units)
    out.vmin = `${Math.round(speedFromMps(lap.vminMps, units))} ${speedUnitLabel(units)}${Math.abs(d) < 0.5 ? '' : ` (${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(1)})`}`
  }
  if (lap.throttleM != null && best.throttleM != null) {
    const d = lap.throttleM - best.throttleM
    out.throttle = Math.abs(d) < 3 ? 'the same' : `${Math.round(Math.abs(d))} m ${d < 0 ? 'sooner' : 'later'}`
  }
  if (lap.timeMs != null && best.timeMs != null) {
    const d = (lap.timeMs - best.timeMs) / 1000
    out.time = Math.abs(d) < 0.005 ? null : `${d > 0 ? '+' : '−'}${Math.abs(d).toFixed(2)} s`
  }
  return out
}

/** The points placed on the track (session-wide notes are only listed). */
export const placedPoints = (data: ReplayCoaching | null) => (data?.points ?? []).filter((p): p is ReplayCoachPoint & { atM: number; startM: number; endM: number } => p.atM != null && p.startM != null && p.endM != null)

/** The lap's index as the coaching keys it ("3"), or null for Garmin's optimal lap. */
export const lapKey = (lap: LapPath | null) => (lap && typeof lap.lap.lap === 'number' ? String(lap.lap.lap) : null)

// ─── Placing by distance ─────────────────────────────────────────────────────

class Placer {
  private edgeHint = -1
  private across: Across = { o: 0, half: 0, ax: 0, az: 0 }
  constructor(private world: ReplayWorld) {}

  get road() { return this.world.road }

  station(dist: number): number { return this.road.stationAt(dist) }

  /** The ground under a point near station s: a track model's surface, else the road's. */
  ground(x: number, z: number, s: number): number {
    const onRoad = this.road.surface(x, z, s).h
    const onModel = this.world.surface?.(x, z, onRoad) ?? NaN
    return Number.isFinite(onModel) ? onModel : onRoad
  }

  /** The road's drawn edges at station s, as offsets across it (+ left): [left, right]. */
  edges(s: number): [number, number] {
    const road = this.road, edges = this.world.trackEdges
    if (edges) {
      const x = road.cx[s], z = road.cz[s]
      const k = edges.nearest(x, z, this.edgeHint)
      if (k >= 0) {
        this.edgeHint = k
        const a = this.across
        edges.across(x, z, k, a)
        const dot = a.ax * road.lx[s] + a.az * road.lz[s]
        if (dot > 0.5 && a.half > 2) return [(a.half - a.o) * dot, (-a.half - a.o) * dot]
      }
    }
    return [road.left[s], -road.right[s]]
  }

  /** A point across the road at station s: offset o (+ left), a metres along; [x, y, z]. */
  point(s: number, o: number, along = 0, lift = LIFT): [number, number, number] {
    const road = this.road
    const fx = -road.lz[s], fz = road.lx[s]
    const x = road.cx[s] + road.lx[s] * o + fx * along, z = road.cz[s] + road.lz[s] * o + fz * along
    return [x, this.ground(x, z, s) + lift, z]
  }

  /** Whether the road turns left through a distance (to put boards on the outside). */
  turnsLeft(dist: number): boolean {
    const road = this.road, s = this.station(dist)
    const a = road.wrap(s - 15), b = road.wrap(s + 15)
    return -road.lz[b] * road.lx[a] + road.lx[b] * road.lz[a] > 0
  }
}

// ─── Geometry ────────────────────────────────────────────────────────────────

/** Triangles with RGBA colours, merged into one mesh. */
class Tris {
  pos: number[] = []
  col: number[] = []
  quad(a: number[], b: number[], c: number[], d: number[], color: THREE.Color, alpha: number | [number, number, number, number]) {
    const al = typeof alpha === 'number' ? [alpha, alpha, alpha, alpha] : alpha
    const v = [a, b, c, d]
    for (const i of [0, 1, 2, 1, 3, 2]) { this.pos.push(...v[i]); this.col.push(color.r, color.g, color.b, al[i]) }
  }
  mesh(name: string, renderOrder: number): THREE.Mesh | null {
    if (!this.pos.length) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 4))
    // Flat on the ground, so one pass draws what three's two for a see-through
    // double-sided material would (back faces, then front), without a program lookup each.
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, forceSinglePass: true,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = name
    mesh.renderOrder = renderOrder
    return mesh
  }
}

// ─── Text atlas and billboards ──────────────────────────────────────────────

interface Sprite { w: number; h: number; draw: (g: CanvasRenderingContext2D, x: number, y: number) => void }
interface Placed extends Sprite { x: number; y: number }

const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace'
const BODY = 'Manrope, system-ui, sans-serif'

function measure(font: string, text: string): number {
  const g = measureContext()
  g.font = font
  return g.measureText(text).width
}
let measurer: CanvasRenderingContext2D | null = null
const measureContext = () => (measurer ??= document.createElement('canvas').getContext('2d')!)

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath()
  g.roundRect(x, y, w, h, r)
}

/** A floating note: the corner, then the headline, with a bar in the tone's colour. */
function noteSprite(title: string, headline: string, tone: ReplayCoachTone): Sprite {
  const k = ATLAS_SCALE
  const titleFont = `600 ${11 * k}px ${MONO}`, headFont = `700 ${15 * k}px ${BODY}`
  const titleText = title.toUpperCase()
  const pad = 10 * k, bar = 4 * k
  const w = Math.ceil(Math.min(ATLAS_WIDTH - 4, bar + pad * 2 + Math.max(measure(titleFont, titleText) + titleText.length * 0.6 * k, measure(headFont, headline))))
  const h = Math.ceil(pad * 2 + 13 * k + 5 * k + 17 * k)
  return {
    w, h, draw: (g, x, y) => {
      g.save()
      roundRect(g, x + 1, y + 1, w - 2, h - 2, 7 * k)
      g.fillStyle = 'rgba(15, 15, 18, 0.88)'
      g.fill()
      g.strokeStyle = 'rgba(255, 255, 255, 0.14)'
      g.lineWidth = k
      g.stroke()
      g.clip()
      g.fillStyle = TONE_COLOR[tone]
      g.fillRect(x, y, bar + k, h)
      g.textBaseline = 'top'
      g.font = titleFont
      g.fillStyle = PALETTE.textDim
      ;(g as unknown as { letterSpacing: string }).letterSpacing = `${0.6 * k}px`
      g.fillText(titleText, x + bar + pad, y + pad)
      ;(g as unknown as { letterSpacing: string }).letterSpacing = '0px'
      g.font = headFont
      g.fillStyle = PALETTE.text
      g.fillText(headline, x + bar + pad, y + pad + 13 * k + 5 * k)
      g.restore()
    },
  }
}

/** A small board by the road: a pill in the mark's colour. */
function boardSprite(text: string, color: string): Sprite {
  const k = ATLAS_SCALE
  const font = `700 ${11 * k}px ${MONO}`
  const label = text.toUpperCase()
  const padX = 8 * k, h = 20 * k
  const w = Math.ceil(measure(font, label) + label.length * 0.5 * k + padX * 2)
  return {
    w, h, draw: (g, x, y) => {
      g.save()
      roundRect(g, x + 1, y + 1, w - 2, h - 2, 5 * k)
      g.fillStyle = color
      g.fill()
      g.strokeStyle = 'rgba(15, 15, 18, 0.7)'
      g.lineWidth = 1.5 * k
      g.stroke()
      g.font = font
      g.textBaseline = 'middle'
      g.fillStyle = PALETTE.bgPlot
      ;(g as unknown as { letterSpacing: string }).letterSpacing = `${0.5 * k}px`
      g.fillText(label, x + padX, y + h / 2 + k)
      g.restore()
    },
  }
}

/** A white patch in the atlas: posts are drawn with it, tinted. */
const WHITE: Sprite = { w: 8, h: 8, draw: (g, x, y) => { g.fillStyle = '#fff'; g.fillRect(x, y, 8, 8) } }

/** Shelf-packs sprites (and the white patch) into one canvas; returns it and each sprite's place. */
function packAtlas(sprites: Sprite[]): { canvas: HTMLCanvasElement; placed: Map<Sprite, Placed> } {
  const gap = 4
  let x = gap, y = gap, row = 0
  const placed = new Map<Sprite, Placed>()
  for (const s of [WHITE, ...sprites]) {
    if (x + s.w + gap > ATLAS_WIDTH) { x = gap; y += row + gap; row = 0 }
    placed.set(s, { ...s, x, y })
    x += s.w + gap; row = Math.max(row, s.h)
  }
  const canvas = document.createElement('canvas')
  canvas.width = ATLAS_WIDTH
  canvas.height = Math.max(16, THREE.MathUtils.ceilPowerOfTwo(y + row + gap))
  const g = canvas.getContext('2d')!
  for (const p of placed.values()) p.draw(g, p.x, p.y)
  return { canvas, placed }
}

// Billboards facing the camera, sized in the shader; a post (size.y = 0)
// runs from the anchor down to the ground, a pixel or two wide. Both fade
// with the anchor's distance and along the track with the car.
const billboardVertex = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec2 corner;
  attribute vec3 size;
  attribute vec4 fade;
  attribute vec2 span;
  attribute vec4 tint;
  attribute float drop;
  uniform float uPxScale;
  uniform float uCarDist;
  uniform float uTotal;
  uniform vec2 uRamp;
  varying vec2 vUv;
  varying vec4 vTint;
  varying float vAlpha;
  void main() {
    vec4 anchor = modelViewMatrix * vec4(position, 1.0);
    float d = max(0.001, -anchor.z);
    vec4 mv = anchor;
    if (size.y > 0.0) {
      // At least size.z pixels tall, else its size in metres.
      float h = max(size.y, size.z * d * uPxScale);
      float w = h * size.x / size.y;
      mv.xy += vec2(corner.x * w, corner.y * h);
    } else {
      mv = modelViewMatrix * vec4(position - vec3(0.0, drop, 0.0), 1.0);
      mv.x += corner.x * 1.5 * max(0.001, -mv.z) * uPxScale;
    }
    gl_Position = projectionMatrix * mv;
    #include <logdepthbuf_vertex>
    vUv = uv;
    vTint = tint;
    vAlpha = smoothstep(fade.x, fade.y, d) * (1.0 - smoothstep(fade.z, fade.w, d));
    // Shown while the car is between span.x and span.y along the track
    // (wrapped around a closed lap); always without a car.
    if (uCarDist > -1e8) {
      float len = span.y - span.x, t = uCarDist - span.x;
      if (uTotal > 0.0) { len = mod(len, uTotal); t = mod(t, uTotal); }
      vAlpha *= smoothstep(0.0, uRamp.x, t) * (1.0 - smoothstep(len - uRamp.y, len, t));
    }
  }
`
const billboardFragment = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  varying vec2 vUv;
  varying vec4 vTint;
  varying float vAlpha;
  void main() {
    #include <logdepthbuf_fragment>
    vec4 c = texture2D(map, vUv) * vTint;
    float a = c.a * vAlpha;
    if (a < 0.01) discard;
    gl_FragColor = vec4(c.rgb, a);
    #include <colorspace_fragment>
  }
`

interface Billboard {
  sprite: Sprite
  /** The bottom middle of the sprite, local metres. */
  at: [number, number, number]
  heightM: number
  minPx: number
  fade: [number, number, number, number]
  /** Along the track (m): shown while the car is between these. */
  span: [number, number]
  /** A post down to the ground (this far below `at`), in this colour. */
  post: { dropM: number; color: THREE.Color; opacity: number } | null
}

const viewport = new THREE.Vector2()

/** Shared by the notes and boards: where the car is along the track and the lap's length. */
interface TrackUniforms { uCarDist: { value: number }; uTotal: { value: number } }

function billboards(items: Billboard[], placed: Map<Sprite, Placed>, atlas: THREE.Texture, depthTest: boolean, name: string, track: TrackUniforms, ramp: [number, number]): THREE.Mesh | null {
  if (!items.length) return null
  const quads = items.length + items.filter(i => i.post).length
  const pos = new Float32Array(quads * 12), corner = new Float32Array(quads * 8), size = new Float32Array(quads * 12)
  const fade = new Float32Array(quads * 16), uv = new Float32Array(quads * 8), span = new Float32Array(quads * 8)
  const tint = new Float32Array(quads * 16).fill(1), drop = new Float32Array(quads * 4)
  const index: number[] = []
  const W = (atlas.image as HTMLCanvasElement).width, H = (atlas.image as HTMLCanvasElement).height
  const white = placed.get(WHITE)!
  const wu = (white.x + white.w / 2) / W, wv = 1 - (white.y + white.h / 2) / H
  let q = 0
  const quad = (item: Billboard, corners: number[][], sizes: number[], color: number[] | null, drops: number[]) => {
    corners.forEach(([cx, cy, u, v], j) => {
      const k = q * 4 + j
      pos.set(item.at, k * 3)
      corner.set([cx, cy], k * 2)
      size.set(sizes, k * 3)
      fade.set(item.fade, k * 4)
      uv.set([u, v], k * 2)
      span.set(item.span, k * 2)
      if (color) tint.set(color, k * 4)
      drop[k] = drops[j]
    })
    index.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4 + 1, q * 4 + 3, q * 4 + 2)
    q++
  }
  // Posts first, so their sprites draw over them.
  for (const item of items) {
    if (!item.post) continue
    const { color: c, opacity, dropM } = item.post
    quad(item, [[-0.5, 0, wu, wv], [0.5, 0, wu, wv], [-0.5, 0, wu, wv], [0.5, 0, wu, wv]], [0, 0, 0], [c.r, c.g, c.b, opacity], [dropM, dropM, 0, 0])
  }
  for (const item of items) {
    const p = placed.get(item.sprite)!
    const u0 = p.x / W, u1 = (p.x + p.w) / W, v1 = 1 - p.y / H, v0 = 1 - (p.y + p.h) / H
    quad(item, [[-0.5, 0, u0, v0], [0.5, 0, u1, v0], [-0.5, 1, u0, v1], [0.5, 1, u1, v1]], [item.heightM * p.w / p.h, item.heightM, item.minPx], null, [0, 0, 0, 0])
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geometry.setAttribute('corner', new THREE.BufferAttribute(corner, 2))
  geometry.setAttribute('size', new THREE.BufferAttribute(size, 3))
  geometry.setAttribute('fade', new THREE.BufferAttribute(fade, 4))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geometry.setAttribute('span', new THREE.BufferAttribute(span, 2))
  geometry.setAttribute('tint', new THREE.BufferAttribute(tint, 4))
  geometry.setAttribute('drop', new THREE.BufferAttribute(drop, 1))
  geometry.setIndex(index)
  const material = new THREE.ShaderMaterial({
    vertexShader: billboardVertex, fragmentShader: billboardFragment,
    uniforms: { map: { value: atlas }, uPxScale: { value: 0.002 }, uRamp: { value: new THREE.Vector2(...ramp) }, ...track },
    transparent: true, depthWrite: false, depthTest, toneMapped: false,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = name
  // The quads grow in the shader; their anchors alone would cull them early.
  mesh.frustumCulled = false
  mesh.renderOrder = depthTest ? 4 : 6
  // Metres per pixel at a metre's distance, for this camera and target (CSS pixels).
  mesh.onBeforeRender = (renderer, _scene, camera) => {
    const target = renderer.getRenderTarget()
    const heightPx = target ? target.height : renderer.getDrawingBufferSize(viewport).y
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 60
    // Drawn into a target: the Garmin lens, which magnifies the middle about 1.5×.
    material.uniforms.uPxScale.value = 2 * Math.tan(fov * Math.PI / 360) / Math.max(1, heightPx) * renderer.getPixelRatio() / (target ? 1.5 : 1)
  }
  return mesh
}

// ─── The overlay ─────────────────────────────────────────────────────────────

export class CoachingOverlay {
  readonly group = new THREE.Group()
  private placer: Placer
  private points: Array<ReplayCoachPoint & { atM: number; startM: number; endM: number }>
  private zones: THREE.Mesh | null = null
  private stripes: THREE.Mesh | null = null
  private boards: THREE.Mesh | null = null
  private notes: THREE.Mesh | null = null
  private line: THREE.Mesh | null = null
  private atlas: THREE.CanvasTexture | null = null
  private lap: LapPath | null = null
  private layers: CoachingLayers = { labels: true, marks: true, zones: true, line: true }
  private track: TrackUniforms = { uCarDist: { value: -1e9 }, uTotal: { value: 0 } }

  constructor(private world: ReplayWorld, private data: ReplayCoaching, private units: UnitSystem) {
    this.group.name = 'coaching'
    this.placer = new Placer(world)
    this.points = placedPoints(data)
    this.track.uTotal.value = world.road.closed ? world.road.totalM : 0
    this.zones = this.buildZones()
    if (this.zones) this.group.add(this.zones)
    this.rebuildLapParts()
    this.applyLayers()
  }

  /** The watched lap: its own brake points, and the suggested line in its GPS frame. */
  setLap(lap: LapPath | null) {
    this.lap = lap
    this.rebuildLapParts()
    this.refreshLine()
    this.applyLayers()
  }

  /** Where the car is along the track (FrameState.pose.dist): notes and boards show for the corners ahead. */
  setCarDist(dist: number | null) {
    this.track.uCarDist.value = dist != null && Number.isFinite(dist) ? dist : -1e9
  }

  setLayers(layers: CoachingLayers) {
    this.layers = { ...layers }
    this.applyLayers()
  }

  /** Redraw the suggested line with the lap's current GPS shift ("Align to track"). */
  refreshLine() {
    this.drop(this.line)
    this.line = this.buildLine()
    if (this.line) this.group.add(this.line)
    this.applyLayers()
  }

  private applyLayers() {
    if (this.zones) this.zones.visible = this.layers.zones
    if (this.stripes) this.stripes.visible = this.layers.marks
    if (this.boards) this.boards.visible = this.layers.marks
    if (this.notes) this.notes.visible = this.layers.labels
    if (this.line) this.line.visible = this.layers.line
  }

  private drop(object: THREE.Object3D | null) {
    if (!object) return
    this.group.remove(object)
    const mesh = object as THREE.Mesh
    mesh.geometry?.dispose()
    ;(Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(m => m?.dispose())
  }

  // The coached stretches: bands inside both edges, in the note's colour, fading in and out at the ends.
  private buildZones(): THREE.Mesh | null {
    const p = this.placer, tris = new Tris()
    for (const point of this.points) {
      const color = new THREE.Color(TONE_COLOR[point.tone])
      const from = point.startM, to = Math.max(point.startM + 4, point.endM)
      const step = 2, ramp = Math.min(10, (to - from) / 3)
      const alphaAt = (d: number) => 0.5 * Math.min(1, (d - from) / ramp, (to - d) / ramp)
      for (let d = from; d < to; d += step) {
        const d1 = Math.min(to, d + step)
        const s0 = p.station(d), s1 = p.station(d1)
        const [l0, r0] = p.edges(s0), [l1, r1] = p.edges(s1)
        const a0 = Math.max(0, alphaAt(d)), a1 = Math.max(0, alphaAt(d1))
        for (const [e0, e1, inward] of [[l0, l1, -1], [r0, r1, 1]] as const) {
          tris.quad(p.point(s0, e0 + inward * ZONE_INSET_M), p.point(s0, e0 + inward * (ZONE_INSET_M + ZONE_BAND_M)), p.point(s1, e1 + inward * ZONE_INSET_M), p.point(s1, e1 + inward * (ZONE_INSET_M + ZONE_BAND_M)),
            color, [a0, a0 * 0.25, a1, a1 * 0.25])
        }
      }
    }
    return tris.mesh('coaching-zones', 1)
  }

  /** The stripes, boards, notes and posts: the notes follow the data, the marks the lap. */
  private rebuildLapParts() {
    for (const o of [this.stripes, this.boards, this.notes]) this.drop(o)
    this.stripes = this.boards = this.notes = null
    this.atlas?.dispose()
    this.atlas = null
    const p = this.placer, tris = new Tris()
    const noteItems: Billboard[] = [], boardItems: Billboard[] = []
    const lapIndex = lapKey(this.lap)
    const unit = speedUnitLabel(this.units)

    const total = this.track.uTotal.value
    this.points.forEach((point, i) => {
      // The note, over the middle of the road at the corner, from the previous coached corner on.
      const sa = p.station(point.atM)
      const anchor = p.point(sa, 0, 0, NOTE_HEIGHT_M)
      const previous = i ? this.points[i - 1].atM : total ? this.points[this.points.length - 1].atM - total : -Infinity
      const from = this.points.length > 1 ? Math.max(point.atM - NOTE_AHEAD_M, previous + 5) : point.atM - NOTE_AHEAD_M
      noteItems.push({
        sprite: noteSprite(point.title, point.headline, point.tone), at: anchor, heightM: 2.1, minPx: 40, fade: NOTE_FADE, span: [from, point.atM + NOTE_PAST_M],
        post: { dropM: anchor[1] - p.ground(anchor[0], anchor[2], sa), color: new THREE.Color(TONE_COLOR[point.tone]), opacity: 0.7 },
      })

      // Boards a little past the edge: the best pass's on the outside of the
      // corner, this lap's on the inside, so neither hides the other.
      const outsideLeft = !p.turnsLeft(point.atM)
      const placedBoards: Array<[number, boolean]> = []
      const stripe = (dist: number, color: string, full: boolean, text: string, inside = false) => {
        const s = p.station(dist)
        const [left, right] = p.edges(s)
        const c = new THREE.Color(color)
        const from = full ? right : outsideLeft ? left - (left - right) * 0.45 : right
        const to = full ? left : outsideLeft ? left : right + (left - right) * 0.45
        const depth = full ? STRIPE_DEPTH_M : STRIPE_DEPTH_M * 0.6
        const parts = 6
        for (let k = 0; k < parts; k++) {
          const o0 = from + (to - from) * k / parts, o1 = from + (to - from) * (k + 1) / parts
          tris.quad(p.point(s, o0, -depth / 2), p.point(s, o1, -depth / 2), p.point(s, o0, depth / 2), p.point(s, o1, depth / 2), c, 0.9)
        }
        // Boards close together on one side stack.
        const stacked = placedBoards.filter(([m, i]) => i === inside && Math.abs(m - dist) < 15).length
        placedBoards.push([dist, inside])
        const side = outsideLeft !== inside ? left + 1.1 : right - 1.1
        const at = p.point(s, side, 0, BOARD_HEIGHT_M + stacked * 0.75)
        boardItems.push({
          sprite: boardSprite(text, color), at, heightM: 0.5, minPx: 17, fade: BOARD_FADE, span: [dist - BOARD_AHEAD_M, dist + BOARD_PAST_M],
          post: { dropM: at[1] - p.ground(at[0], at[2], s), color: POST_COLOR, opacity: 0.8 },
        })
      }

      const best = point.reference
      const mine = lapIndex != null ? point.laps[lapIndex] : undefined
      const isBest = !!best && lapIndex === String(best.lap)
      if (best) {
        if (best.brakeM != null) stripe(best.brakeM, MARK_COLOR.best, true, isBest ? `Brake · best (${best.label}, this lap)` : `Brake · best ${best.label}`)
        if (mine?.brakeM != null && !isBest && best.brakeM != null && Math.abs(mine.brakeM - best.brakeM) >= 2) {
          const d = mine.brakeM - best.brakeM
          stripe(mine.brakeM, MARK_COLOR.you, true, `You · ${Math.round(Math.abs(d))} m ${d < 0 ? 'early' : 'late'}`, true)
        }
        if (best.vminM != null && best.vminMps != null) stripe(best.vminM, MARK_COLOR.best, false, `Min ${Math.round(speedFromMps(best.vminMps, this.units))} ${unit}`)
        if (best.throttleM != null && (best.vminM == null || best.throttleM - best.vminM >= 8)) stripe(best.throttleM, MARK_COLOR.throttle, false, 'Throttle · best')
      }
      for (const target of point.targets) stripe(target.atM, MARK_COLOR.coach, target.kind === 'brake', target.label)
    })

    this.stripes = tris.mesh('coaching-marks', 3)
    const sprites = [...noteItems, ...boardItems].map(i => i.sprite)
    if (sprites.length) {
      const { canvas, placed } = packAtlas(sprites)
      const atlas = this.atlas = new THREE.CanvasTexture(canvas)
      atlas.colorSpace = THREE.SRGBColorSpace
      atlas.generateMipmaps = false
      atlas.minFilter = THREE.LinearFilter
      this.boards = billboards(boardItems, placed, atlas, true, 'coaching-boards', this.track, BOARD_RAMP)
      this.notes = billboards(noteItems, placed, atlas, false, 'coaching-notes', this.track, NOTE_RAMP)
    }
    for (const o of [this.stripes, this.boards, this.notes]) if (o) this.group.add(o)
  }

  // The suggested lines (the coach's, the best-sector line) as dashed
  // ribbons on the surface, in the watched lap's GPS frame.
  private buildLine(): THREE.Mesh | null {
    const lap = this.lap
    if (!lap) return null
    const p = this.placer, road = p.road
    const pos: number[] = [], col: number[] = [], index: number[] = []
    const out: [number, number] = [0, 0]
    for (const source of this.data.lines) {
      const n = source.dist.length
      if (n < 2) continue
      const color = new THREE.Color(source.id === 'coach' ? MARK_COLOR.coachLine : MARK_COLOR.line)
      const xz = new Float64Array(n * 2)
      for (let i = 0; i < n; i++) { lap.toLocal(source.lat[i], source.lon[i], out); xz[2 * i] = out[0]; xz[2 * i + 1] = out[1] }
      let count = 0, previous = -Infinity
      for (let i = 0; i < n; i++) {
        const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1)
        let fx = xz[2 * b] - xz[2 * a], fz = xz[2 * b + 1] - xz[2 * a + 1]
        const len = Math.hypot(fx, fz)
        if (!(len > 0) || len > 12) continue
        // A gap in the line (a stretch without samples) starts a new piece.
        const last = previous
        if (source.dist[i] - last > 6) count = 0
        previous = source.dist[i]
        fx /= len; fz /= len
        const x = xz[2 * i], z = xz[2 * i + 1]
        const hint = road.nearestFrom(x, z, road.stationAt(source.dist[i]), 12)
        const y = p.ground(x, z, hint) + LIFT
        const ox = fz * LINE_WIDTH_M / 2, oz = -fx * LINE_WIDTH_M / 2
        const v = pos.length / 3
        pos.push(x + ox, y, z + oz, x - ox, y, z - oz)
        col.push(color.r, color.g, color.b, color.r, color.g, color.b)
        // Dashed, so it never reads as the racing line.
        if (count && ((last % LINE_DASH_M[1]) + LINE_DASH_M[1]) % LINE_DASH_M[1] < LINE_DASH_M[0]) index.push(v - 2, v, v - 1, v - 1, v, v + 1)
        count++
      }
    }
    if (!index.length) return null
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    geometry.setIndex(index)
    // A flat ribbon: one pass, as the marks (Tris.mesh).
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, toneMapped: false, forceSinglePass: true,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
    }))
    mesh.name = 'coaching-line'
    mesh.renderOrder = 2
    return mesh
  }

  dispose() {
    for (const o of [this.zones, this.stripes, this.boards, this.notes, this.line]) this.drop(o)
    this.atlas?.dispose()
    this.group.removeFromParent()
  }
}
