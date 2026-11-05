// Moves a rigged car (wheels.ts) each frame: the wheels roll by the distance
// travelled and the fronts steer (by the steering channel, else the path's
// curvature, with Ackermann geometry); the body rolls and pitches with the
// lap's g-forces and heaves over the ground through a spring and damper,
// while the wheels stay on the ground. Everything is a function of lap time
// (the springs step through replay time), so pausing holds and scrubbing
// lands where playback would. It allocates nothing per frame.

import * as THREE from 'three'
import type { CarDynamics } from '../../shared/replay'
import type { LapPath, LapPose } from './lapPath'
import { RIG } from './wheels'

const G = 9.80665
const DEG = Math.PI / 180
const TAU = 2 * Math.PI
// Spring steps at most this long (s).
const MAX_STEP_S = 1 / 240
// After a jump (a seek, another lap) the springs start this long before the
// new time, so the body is where playback would have put it.
const WARMUP_MS = 1500
// The body rolls and pitches about axes this high above the ground (m).
const ROLL_AXIS_M = 0.08
const MAX_HEAVE_M = 0.04
const MAX_STEER = 35 * DEG
const MAX_G = 2.5
// The ground under the car is sampled on this grid of lap time (ms) for the
// heave, so it is the same at any frame rate and after a seek.
const GROUND_STEP_MS = 1000 / 60

/** The car's resting height on the ground at a lap time (the engine's placement). */
export type GroundAt = (lap: LapPath, timeMs: number) => number

interface Wheel {
  hub: THREE.Object3D
  steer: THREE.Object3D
  spin: THREE.Object3D
  /** Tyre radius in the frame's units, and in metres. */
  radius: number
  radiusM: number
  front: boolean
  left: boolean
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export class CarMotion {
  /** False holds the wheels straight and the body level. */
  enabled = true
  private carFromFrame = new THREE.Matrix4()
  private frameFromCar = new THREE.Matrix4()
  // The car's axle (+x) and up (+y) in the frame.
  private axle = new THREE.Vector3(1, 0, 0)
  private up = new THREE.Vector3(0, 1, 0)
  private wheelbase = 2.4
  private track = 1.5
  private midZ = 0
  // Springs: roll (+ = left side up) and pitch (+ = nose down) in radians, the body's height (m), and their rates.
  private roll = 0
  private rollRate = 0
  private pitch = 0
  private pitchRate = 0
  private bodyY = 0
  private bodyRate = 0
  private targetRoll = 0
  private targetPitch = 0
  private groundK = NaN
  private groundA = 0
  private groundB = 0
  private lastTime = 0
  private lastLap: LapPath | null = null
  private ready = false
  private accel = { accelX: 0, accelY: 0 }
  private sway = new THREE.Matrix4()
  private euler = new THREE.Euler()
  private v = new THREE.Vector3()

  private constructor(private body: THREE.Object3D, private frame: THREE.Object3D, private sprung: THREE.Object3D, private wheels: Wheel[]) {
    this.refresh()
  }

  /** The rig in a car body (a rigged model or the placeholder), or null when it has none. */
  static find(body: THREE.Object3D | null): CarMotion | null {
    let frame: THREE.Object3D | null = null
    body?.traverse(o => { if (!frame && o.userData[RIG] === 'frame') frame = o })
    if (!body || !frame) return null
    const children = (frame as THREE.Object3D).children
    const sprung = children.find(c => c.userData[RIG] === 'sprung')
    const wheels: Wheel[] = []
    for (const hub of children) {
      if (hub.userData[RIG] !== 'hub') continue
      const steer = hub.children.find(c => c.userData[RIG] === 'steer'), spin = steer?.children.find(c => c.userData[RIG] === 'spin')
      if (steer && spin) wheels.push({ hub, steer, spin, radius: Number(hub.userData.radius) || 0.3, radiusM: 0.3, front: false, left: false })
    }
    return sprung && wheels.length === 4 ? new CarMotion(body, frame, sprung, wheels) : null
  }

  // The frame's placement in the car (the fit's scale, yaw and offset).
  private measure() {
    const m = this.carFromFrame.identity()
    for (let o: THREE.Object3D | null = this.frame; o; o = o.parent) {
      if (o.matrixAutoUpdate) o.updateMatrix()
      m.premultiply(o.matrix)
      if (o === this.body) break
    }
    this.frameFromCar.copy(m).invert()
    this.axle.set(1, 0, 0).transformDirection(this.frameFromCar)
    this.up.set(0, 1, 0).transformDirection(this.frameFromCar)
  }

  /** Re-measure after a refit: which wheels are at the front and left, the tyres in metres, wheelbase and track. */
  refresh() {
    this.rest()
    this.measure()
    const scale = this.carFromFrame.getMaxScaleOnAxis()
    let meanX = 0, meanZ = 0
    for (const w of this.wheels) { const p = this.v.copy(w.hub.position).applyMatrix4(this.carFromFrame); meanX += p.x / 4; meanZ += p.z / 4 }
    let front = 0, rear = 0, left = 0, right = 0
    for (const w of this.wheels) {
      const p = this.v.copy(w.hub.position).applyMatrix4(this.carFromFrame)
      w.front = p.z > meanZ; w.left = p.x > meanX
      w.radiusM = Math.max(0.05, w.radius * scale)
      if (w.front) { front += p.z / 2; if (w.left) left = p.x; else right = p.x } else rear += p.z / 2
    }
    this.wheelbase = Math.max(1, front - rear)
    this.track = Math.max(0.8, left - right)
    this.midZ = (front + rear) / 2
  }

  /** Wheels straight and unturned, body level; the springs start afresh. */
  rest() {
    for (const w of this.wheels) { w.spin.quaternion.identity(); w.steer.quaternion.identity() }
    this.sprung.matrix.identity()
    this.sprung.matrixWorldNeedsUpdate = true
    this.ready = false
  }

  /**
   * Turn the wheels without a lap (a model preview): rolled as if driven
   * `distanceM` metres, the fronts steered by `steerRad` (positive left).
   */
  turnWheels(distanceM: number, steerRad = 0) {
    this.measure()
    for (const w of this.wheels) {
      w.spin.quaternion.setFromAxisAngle(this.axle, (distanceM / w.radiusM) % TAU)
      if (w.front) w.steer.quaternion.setFromAxisAngle(this.up, steerRad)
    }
  }

  /** Pose the wheels and body for a lap time (the car at `pose`; `ground` samples its height on the ground). */
  update(lap: LapPath, timeMs: number, pose: LapPose, spec: CarDynamics, ground: GroundAt) {
    if (!this.enabled) { if (this.ready || !this.sprung.matrix.equals(IDENTITY)) this.rest(); return }
    this.measure()
    // Roll: distance over radius, so any time (or a pause) is exact.
    for (const w of this.wheels) w.spin.quaternion.setFromAxisAngle(this.axle, (pose.dist / w.radiusM) % TAU)
    // Steer: the mean front-wheel angle, as a curvature, splits into the
    // inner and outer wheels' (Ackermann).
    const steering = lap.steeringAt(pose.dist)
    const mean = clamp(steering != null ? steering * DEG / spec.steeringRatio : Math.atan(this.wheelbase * pose.curvature), -MAX_STEER, MAX_STEER)
    const curvature = Math.tan(mean) / this.wheelbase
    const half = clamp(curvature * this.track / 2, -0.8, 0.8)
    const leftAngle = Math.atan(this.wheelbase * curvature / (1 - half)), rightAngle = Math.atan(this.wheelbase * curvature / (1 + half))
    for (const w of this.wheels) if (w.front) w.steer.quaternion.setFromAxisAngle(this.up, w.left ? leftAngle : rightAngle)
    // Body.
    this.step(lap, timeMs, spec, ground)
    const heave = clamp(this.bodyY - this.groundAt(lap, timeMs, ground), -MAX_HEAVE_M, MAX_HEAVE_M)
    // About the roll and pitch axes: p' = R(p − c) + c + heave.
    const sway = this.sway.makeRotationFromEuler(this.euler.set(this.pitch, 0, this.roll))
    const c = this.v.set(0, ROLL_AXIS_M, this.midZ).applyMatrix4(sway)
    sway.setPosition(-c.x, ROLL_AXIS_M - c.y + heave, this.midZ - c.z)
    this.sprung.matrix.multiplyMatrices(this.frameFromCar, sway).multiply(this.carFromFrame)
    this.sprung.matrixWorldNeedsUpdate = true
  }

  // Where the body leans to at a lap time: away from the turn and onto the
  // nose under braking, in proportion to the g-forces.
  private target(lap: LapPath, timeMs: number, spec: CarDynamics) {
    lap.accelAt(timeMs, this.accel)
    // Garmin's lateral is positive turning right; toward the left is the negative.
    const left = clamp(-this.accel.accelY / G, -MAX_G, MAX_G), ahead = clamp(this.accel.accelX / G, -MAX_G, MAX_G)
    this.targetRoll = spec.rollDegPerG * left * DEG
    this.targetPitch = -(ahead < 0 ? spec.diveDegPerG : spec.squatDegPerG) * ahead * DEG
  }

  // The ground on the time grid, linear between samples (two are kept).
  private groundAt(lap: LapPath, timeMs: number, ground: GroundAt): number {
    const k = Math.floor(timeMs / GROUND_STEP_MS)
    if (k !== this.groundK) {
      if (k === this.groundK + 1) this.groundA = this.groundB
      else this.groundA = ground(lap, k * GROUND_STEP_MS)
      this.groundB = ground(lap, (k + 1) * GROUND_STEP_MS)
      this.groundK = k
    }
    return this.groundA + (this.groundB - this.groundA) * (timeMs / GROUND_STEP_MS - k)
  }

  // The springs, stepped through lap time from the last frame's (or warmed
  // up before a jump, so a seek lands where playback would).
  private step(lap: LapPath, timeMs: number, spec: CarDynamics, ground: GroundAt) {
    const jump = !this.ready || lap !== this.lastLap || timeMs < this.lastTime - 0.5 || timeMs - this.lastTime > 1000
    let from = this.lastTime
    if (jump) {
      from = timeMs - WARMUP_MS
      this.groundK = NaN
      this.target(lap, from, spec)
      this.roll = this.targetRoll; this.pitch = this.targetPitch; this.rollRate = this.pitchRate = 0
      this.bodyY = this.groundAt(lap, from, ground); this.bodyRate = (this.groundB - this.groundA) * 1000 / GROUND_STEP_MS
    }
    const span = timeMs - from
    if (span > 0) {
      const steps = Math.ceil(span / 1000 / MAX_STEP_S), h = span / 1000 / steps
      const w = TAU * spec.rideHz, k = w * w, d = 2 * spec.damping * w
      for (let i = 1; i <= steps; i++) {
        const t = from + span * i / steps
        this.target(lap, t, spec)
        // Semi-implicit Euler: rate first, then position.
        this.rollRate += (k * (this.targetRoll - this.roll) - d * this.rollRate) * h
        this.roll += this.rollRate * h
        this.pitchRate += (k * (this.targetPitch - this.pitch) - d * this.pitchRate) * h
        this.pitch += this.pitchRate * h
        const groundY = this.groundAt(lap, t, ground), groundRate = (this.groundB - this.groundA) * 1000 / GROUND_STEP_MS
        this.bodyRate += (k * (groundY - this.bodyY) + d * (groundRate - this.bodyRate)) * h
        this.bodyY += this.bodyRate * h
      }
    }
    this.lastTime = timeMs; this.lastLap = lap; this.ready = true
  }
}

const IDENTITY = new THREE.Matrix4()
