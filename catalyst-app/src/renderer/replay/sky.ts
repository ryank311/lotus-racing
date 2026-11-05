// The sky: Preetham's clear sky (as three's Sky addon draws it) with
// fair-weather cumulus, an overcast deck that can cover it, and the horizon
// haze the world's fog fades into. The same model is evaluated on the CPU
// (skyRadiance) so the lights, the fog colour and the exposure agree with
// what is drawn.

import * as THREE from 'three'

// ─── Preetham (after three's Sky.js, MIT) ───────────────────────────────────

const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5]
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14]
const CUTOFF = 1.6110731556870734, STEEPNESS = 1.5, EE = 1000

export interface PreethamParams { sunE: number; betaR: number[]; betaM: number[]; mieG: number }

export function preetham(sunY: number, turbidity: number, rayleigh = 1.4, mieCoefficient = 0.005, mieG = 0.8): PreethamParams {
  const zenith = Math.acos(Math.min(1, Math.max(-1, sunY)))
  const sunE = EE * Math.max(0, 1 - Math.exp(-((CUTOFF - zenith) / STEEPNESS)))
  const mie = 0.434 * (0.2 * turbidity * 10e-18)
  return { sunE, betaR: TOTAL_RAYLEIGH.map(v => v * rayleigh), betaM: MIE_CONST.map(v => v * mie * mieCoefficient), mieG }
}

/** Transmittance of the atmosphere along a direction `y` above the horizon (the sun's colour). */
export function extinction(p: PreethamParams, y: number): number[] {
  const zenith = Math.acos(Math.max(0, y))
  const inverse = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - zenith * 180 / Math.PI, -1.253))
  return [0, 1, 2].map(c => Math.exp(-(p.betaR[c] * 8.4e3 * inverse + p.betaM[c] * 1.25e3 * inverse)))
}

/** Preetham's clear-sky radiance (three's units) towards `dir` with the sun at `sun`. */
function clearSky(p: PreethamParams, dir: THREE.Vector3, sun: THREE.Vector3, out: number[]) {
  const zenith = Math.acos(Math.max(0, dir.y))
  const inverse = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - zenith * 180 / Math.PI, -1.253))
  const cosTheta = dir.dot(sun)
  const rPhase = 0.05968310365946075 * (1 + Math.pow(cosTheta * 0.5 + 0.5, 2))
  const g2 = p.mieG * p.mieG
  const mPhase = 0.07957747154594767 * (1 - g2) / Math.pow(1 - 2 * p.mieG * cosTheta + g2, 1.5)
  const blend = Math.min(1, Math.max(0, Math.pow(1 - sun.y, 5)))
  for (let c = 0; c < 3; c++) {
    const fex = Math.exp(-(p.betaR[c] * 8.4e3 * inverse + p.betaM[c] * 1.25e3 * inverse))
    const ratio = (p.betaR[c] * rPhase + p.betaM[c] * mPhase) / (p.betaR[c] + p.betaM[c])
    let lin = Math.pow(p.sunE * ratio * (1 - fex), 1.5)
    lin *= 1 + (Math.pow(p.sunE * ratio * fex, 0.5) - 1) * blend
    out[c] = (lin + 0.1 * fex) * 0.04 + [0, 0.0003, 0.00075][c]
  }
}

// ─── The sky's state ────────────────────────────────────────────────────────

export interface SkyState {
  sun: THREE.Vector3
  preetham: PreethamParams
  /** Fair-weather cumulus cover, 0–1. */
  cumulus: number
  overcast: number
  rain: number
  /** Zenith radiance of the overcast deck. */
  deck: THREE.Color
  /** Sunlight on clouds (irradiance / π) and the sky's light on them. */
  cloudSun: THREE.Color
  cloudAmbient: THREE.Color
  /** Horizon haze radiance, and the extra towards the sun. */
  haze: THREE.Color
  hazeSun: THREE.Color
  /** How far up the sky the haze reaches (in the direction's y). */
  hazeHeight: number
}

const HG = (cosTheta: number, g: number) => (1 - g * g) / Math.pow(1 + g * g - 2 * g * cosTheta, 1.5) / (4 * Math.PI)

/** The model's radiance towards `dir`, with the clouds' noise replaced by its mean. */
export function skyRadiance(s: SkyState, dir: THREE.Vector3, out: number[] = [0, 0, 0]): number[] {
  const y = Math.max(0, dir.y)
  clearSky(s.preetham, dir.y < 0 ? new THREE.Vector3(dir.x, 0, dir.z).normalize() : dir, s.sun, out)
  // Cumulus: about their cover of the sky, lit grey-white.
  const cover = s.cumulus * 0.55 * Math.min(1, y / 0.08)
  const cosSun = dir.dot(s.sun)
  for (let c = 0; c < 3; c++) {
    const cloud = s.cloudAmbient.toArray()[c] * 0.9 + s.cloudSun.toArray()[c] * (0.62 + 0.4 * HG(cosSun, 0.6))
    out[c] += (cloud - out[c]) * cover
  }
  // The deck: brighter overhead (gentler than the CIE overcast sky), a glow where the sun is.
  const deck = s.deck.toArray(), cloudSun = s.cloudSun.toArray()
  for (let c = 0; c < 3; c++) {
    const v = deck[c] * (1 + 1.6 * y) / 2.6 * 0.97 + cloudSun[c] * 0.05 * (1 - s.rain) * Math.pow(Math.max(0, cosSun), 6)
    out[c] += (v - out[c]) * s.overcast
  }
  // Haze over the horizon.
  const h = dir.y <= 0 ? 1 : Math.exp(-y / s.hazeHeight)
  const haze = s.haze.toArray(), hazeSun = s.hazeSun.toArray()
  const glow = HG(cosSun, 0.7) * 4 * Math.PI
  for (let c = 0; c < 3; c++) out[c] += (haze[c] + hazeSun[c] * glow - out[c]) * h
  return out
}

/** Irradiance (rgb) on a horizontal surface from the whole sky, by numerical integration. */
export function skyIrradiance(s: SkyState): THREE.Color {
  const sum = [0, 0, 0], v = new THREE.Vector3(), out = [0, 0, 0]
  const rings = 12, segments = 24
  for (let i = 0; i < rings; i++) {
    // Equal-area rings in cos θ, each weighted by cos θ.
    const mu = (i + 0.5) / rings, sinT = Math.sqrt(1 - mu * mu)
    for (let j = 0; j < segments; j++) {
      const phi = (j + 0.5) / segments * Math.PI * 2
      v.set(sinT * Math.cos(phi), mu, sinT * Math.sin(phi))
      skyRadiance(s, v, out)
      for (let c = 0; c < 3; c++) sum[c] += out[c] * mu
    }
  }
  // ∫ L cos θ dω with dω = 2π dμ / (rings · segments) per sample.
  const k = 2 * Math.PI / (rings * segments)
  return new THREE.Color(sum[0] * k, sum[1] * k, sum[2] * k)
}

/** The sky's mean radiance at the horizon (a few degrees up), around the compass. */
export function horizonRadiance(s: SkyState, elevationDeg = 3): THREE.Color {
  const sum = [0, 0, 0], v = new THREE.Vector3(), out = [0, 0, 0]
  const y = Math.sin(elevationDeg * Math.PI / 180), r = Math.cos(elevationDeg * Math.PI / 180)
  for (let j = 0; j < 32; j++) {
    const phi = j / 32 * Math.PI * 2
    v.set(r * Math.cos(phi), y, r * Math.sin(phi))
    skyRadiance(s, v, out)
    for (let c = 0; c < 3; c++) sum[c] += out[c] / 32
  }
  return new THREE.Color(sum[0], sum[1], sum[2])
}

// ─── The dome ───────────────────────────────────────────────────────────────

const vertexShader = /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // On the far plane: drawn after the world, only where nothing else is.
  #ifdef USE_REVERSED_DEPTH_BUFFER
    p.z = 1e-7 * p.w;
  #else
    p.z = p.w * 0.999999;
  #endif
  gl_Position = p;
}
`

const fragmentShader = /* glsl */`
uniform vec3 sunDirection;
uniform float sunE;
uniform vec3 betaR;
uniform vec3 betaM;
uniform float mieG;
uniform float cumulus;
uniform float overcast;
uniform float rain;
uniform vec3 deckColor;
uniform vec3 cloudSun;
uniform vec3 cloudAmbient;
uniform vec3 hazeColor;
uniform vec3 hazeSun;
uniform float hazeHeight;
uniform float sunDisc;
uniform float skyScale;
uniform float time;
uniform vec2 drift;
varying vec3 vDir;

float hash(vec2 p) { vec3 q = fract(p.xyx * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p, int octaves) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++) {
    if (i >= octaves) break;
    v += a * noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.1;
    a *= 0.5;
  }
  return v;
}
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * c, 1.5) * 0.0795774715; }

vec3 preetham(vec3 dir) {
  float zenithAngle = acos(max(0.0, dir.y));
  float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - zenithAngle * 57.29577951, -1.253));
  vec3 Fex = exp(-(betaR * 8.4e3 * inverse + betaM * 1.25e3 * inverse));
  float cosTheta = dot(dir, sunDirection);
  float rPhase = 0.0596831036 * (1.0 + pow(cosTheta * 0.5 + 0.5, 2.0));
  vec3 ratio = (betaR * rPhase + betaM * hg(cosTheta, mieG)) / (betaR + betaM);
  vec3 Lin = pow(sunE * ratio * (1.0 - Fex), vec3(1.5));
  Lin *= mix(vec3(1.0), pow(sunE * ratio * Fex, vec3(0.5)), clamp(pow(1.0 - sunDirection.y, 5.0), 0.0, 1.0));
  return (Lin + 0.1 * Fex) * 0.04 + vec3(0.0, 0.0003, 0.00075);
}

void main() {
  vec3 dir = normalize(vDir);
  float y = max(dir.y, 0.0);
  vec3 horizontal = normalize(vec3(dir.x, max(dir.y, 0.0), dir.z) + vec3(0.0, 1e-4, 0.0));
  vec3 col = preetham(horizontal);
  float cosSun = dot(dir, sunDirection);
  // The sun's disc (a little over its real 0.53°) where the sky is clear.
  float disc = smoothstep(0.99996, 0.99999, cosSun) * sunDisc;
  // Clouds live on a plane: their texture flattens towards the horizon.
  vec2 plane = dir.xz / max(y, 0.035) + drift * time;
  float lit = 1.0;
  if (cumulus > 0.0 && dir.y > 0.0) {
    float n = fbm(plane * 1.4, 5);
    float cover = cumulus * 0.85 + 0.08;
    float d = smoothstep(1.0 - cover, 1.0 - cover + 0.22, n + 0.2 * (noise(plane * 0.23) - 0.5));
    float depth = clamp((n - (1.0 - cover)) * 3.0, 0.0, 1.0);
    vec3 cloud = cloudAmbient * 0.9 + cloudSun * (mix(0.95, 0.42, depth) + 0.9 * hg(cosSun, 0.6) * (1.0 - depth) * 4.0 * 0.5);
    d *= smoothstep(0.0, 0.08, y);
    col = mix(col, cloud, d);
    lit = 1.0 - d;
  }
  vec3 sunColor = cloudSun * 4000.0 * lit;
  // The overcast deck: brighter overhead, slow lumpy texture, a glow where the sun is.
  if (overcast > 0.0) {
    float n = fbm(plane * 0.55 + vec2(3.0, 1.0), 4);
    float lumps = mix(0.84, 1.16, n) * mix(1.0, 0.9 + 0.2 * noise(plane * 3.1), 0.6);
    vec3 deck = deckColor * (1.0 + 1.6 * y) / 2.6 * lumps;
    deck += cloudSun * 0.05 * (1.0 - rain) * pow(max(cosSun, 0.0), 6.0) * (1.6 - n);
    col = mix(col, deck, overcast);
    sunColor *= 1.0 - smoothstep(0.35, 0.75, overcast);
  }
  col += sunColor * disc;
  // Haze over the horizon (the world's fog fades into the same colour).
  float h = dir.y <= 0.0 ? 1.0 : exp(-y / hazeHeight);
  col = mix(col, hazeColor + hazeSun * hg(cosSun, 0.7) * 12.566, h);
  gl_FragColor = vec4(col * skyScale, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`

export function skyUniforms() {
  return {
    sunDirection: { value: new THREE.Vector3(0, 1, 0) },
    sunE: { value: 1000 },
    betaR: { value: new THREE.Vector3() },
    betaM: { value: new THREE.Vector3() },
    mieG: { value: 0.8 },
    cumulus: { value: 0 },
    overcast: { value: 0 },
    rain: { value: 0 },
    deckColor: { value: new THREE.Color() },
    cloudSun: { value: new THREE.Color() },
    cloudAmbient: { value: new THREE.Color() },
    hazeColor: { value: new THREE.Color() },
    hazeSun: { value: new THREE.Color() },
    hazeHeight: { value: 0.05 },
    sunDisc: { value: 1 },
    /** Preetham's units into the scene's. */
    skyScale: { value: 1 },
    time: { value: 0 },
    drift: { value: new THREE.Vector2(0.004, 0.0015) },
  }
}
export type SkyUniforms = ReturnType<typeof skyUniforms>

/** A unit sphere drawn on the far plane around the camera (move it with the camera). */
export class SkyDome extends THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> {
  readonly uniforms: SkyUniforms
  constructor(uniforms = skyUniforms(), sunDisc = true) {
    const material = new THREE.ShaderMaterial({
      name: 'SkyDome', vertexShader, fragmentShader, uniforms: { ...uniforms, sunDisc: sunDisc ? uniforms.sunDisc : { value: 0 } },
      side: THREE.BackSide, depthWrite: false,
    })
    super(new THREE.SphereGeometry(1, 48, 24), material)
    this.uniforms = uniforms
    this.name = 'sky'
    this.frustumCulled = false
    // After the opaque world, so only the pixels it leaves are shaded.
    this.renderOrder = 10
  }

  set(s: SkyState, scale: number) {
    const u = this.uniforms
    u.skyScale.value = scale
    u.sunDirection.value.copy(s.sun)
    u.sunE.value = s.preetham.sunE
    u.betaR.value.fromArray(s.preetham.betaR)
    u.betaM.value.fromArray(s.preetham.betaM)
    u.mieG.value = s.preetham.mieG
    u.cumulus.value = s.cumulus
    u.overcast.value = s.overcast
    u.rain.value = s.rain
    u.deckColor.value.copy(s.deck)
    u.cloudSun.value.copy(s.cloudSun)
    u.cloudAmbient.value.copy(s.cloudAmbient)
    u.hazeColor.value.copy(s.haze)
    u.hazeSun.value.copy(s.hazeSun)
    u.hazeHeight.value = s.hazeHeight
  }

  dispose() { this.geometry.dispose(); this.material.dispose() }
}
