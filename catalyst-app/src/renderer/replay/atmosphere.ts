// The light of a look (weather.ts): the sky dome, the sun and its shadows,
// an environment map of that sky over the surrounding ground and woods (the
// world's ambient light and every reflection), the haze, and the exposure.
//
// Units: radiance is scaled so a white horizontal surface under a clear sky
// with the sun where it stands reads 1.0; overcast skies give less, and the
// exposure adapts most of the way, as a camera does.

import * as THREE from 'three'
import type { Look } from './weather'
import { sunDirection } from './sun'
import { SkyDome, extinction, horizonRadiance, preetham, skyIrradiance, skyUniforms, type SkyState } from './sky'
import { SunShadows, SHADOW_QUALITY, markWorldCasters, type ShadowQuality } from './shadows'
import { WORLD_UNIFORMS } from './surfaces'

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b
// Ground and woods around the track, as the environment map sees them.
const GROUND_ALBEDO = new THREE.Color(0.11, 0.13, 0.075)
const WOODS_ALBEDO = new THREE.Color(0.045, 0.06, 0.035)
// ∫ (1 + 1.6 cos θ) / 2.6 · cos θ dω: the deck's irradiance per unit zenith radiance.
const DECK_IRRADIANCE = (Math.PI + 1.6 * 2 * Math.PI / 3) / 2.6
// Scene-referred middle grey for a fully adapted exposure.
const KEY = 1.15

// The picture's look: AgX (photographic highlight roll-off, no hue skew)
// with a little more contrast and saturation than its neutral base, like a
// camera's standard profile ("punchy" after Blender, toned down).
const AGX_LOOK = /* glsl */`
vec3 CustomToneMapping( vec3 color ) {
  const mat3 AgXInsetMatrix = mat3(
    vec3( 0.856627153315983, 0.137318972929847, 0.11189821299995 ),
    vec3( 0.0951212405381588, 0.761241990602591, 0.0767994186031903 ),
    vec3( 0.0482516061458583, 0.101439036467562, 0.811302368396859 ) );
  const mat3 AgXOutsetMatrix = mat3(
    vec3( 1.1271005818144368, - 0.1413297634984383, - 0.14132976349843826 ),
    vec3( - 0.11060664309660323, 1.157823702216272, - 0.11060664309660294 ),
    vec3( - 0.016493938717834573, - 0.016493938717834257, 1.2519364065950405 ) );
  const float AgxMinEv = - 12.47393;
  const float AgxMaxEv = 4.026069;
  color *= toneMappingExposure;
  color = AgXInsetMatrix * ( LINEAR_SRGB_TO_LINEAR_REC2020 * color );
  color = clamp( ( log2( max( color, 1e-10 ) ) - AgxMinEv ) / ( AgxMaxEv - AgxMinEv ), 0.0, 1.0 );
  color = agxDefaultContrastApprox( color );
  // The look: a touch of contrast (power) and saturation.
  float luma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  color = pow( max( color, 0.0 ), vec3( 1.16 ) );
  color = luma + 1.22 * ( color - luma );
  color = AgXOutsetMatrix * color;
  color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
  return clamp( LINEAR_REC2020_TO_LINEAR_SRGB * color, 0.0, 1.0 );
}
`
let toneMappingInstalled = false
/** Use with renderer.toneMapping = THREE.CustomToneMapping. */
export function installToneMapping() {
  if (toneMappingInstalled) return
  toneMappingInstalled = true
  THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace('vec3 CustomToneMapping( vec3 color ) { return color; }', AGX_LOOK)
}

// The same curve on the CPU (for three's own fog, mixed after tone mapping).
const M_SRGB_2020 = new THREE.Matrix3().set(0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0113, 0.0164, 0.0880, 0.8956)
const M_2020_SRGB = new THREE.Matrix3().set(1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187)
const M_INSET = new THREE.Matrix3().set(0.856627153315983, 0.0951212405381588, 0.0482516061458583, 0.137318972929847, 0.761241990602591, 0.101439036467562, 0.11189821299995, 0.0767994186031903, 0.811302368396859)
const M_OUTSET = new THREE.Matrix3().set(1.1271005818144368, -0.11060664309660323, -0.016493938717834573, -0.1413297634984383, 1.157823702216272, -0.016493938717834257, -0.14132976349843826, -0.11060664309660294, 1.2519364065950405)

/** A linear colour as the tone mapping shows it (display-encoded sRGB, 0–1). */
export function toneMapped(color: THREE.Color, exposure: number): THREE.Color {
  const v = new THREE.Vector3(color.r, color.g, color.b).multiplyScalar(exposure).applyMatrix3(M_SRGB_2020).applyMatrix3(M_INSET)
  const curve = (x: number) => {
    x = Math.min(1, Math.max(0, (Math.log2(Math.max(x, 1e-10)) + 12.47393) / (4.026069 + 12.47393)))
    const x2 = x * x, x4 = x2 * x2
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232
  }
  v.set(curve(v.x), curve(v.y), curve(v.z))
  const luma = 0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z
  v.set(Math.max(0, v.x) ** 1.16, Math.max(0, v.y) ** 1.16, Math.max(0, v.z) ** 1.16)
  v.set(luma + 1.22 * (v.x - luma), luma + 1.22 * (v.y - luma), luma + 1.22 * (v.z - luma))
  v.applyMatrix3(M_OUTSET)
  v.set(Math.max(0, v.x) ** 2.2, Math.max(0, v.y) ** 2.2, Math.max(0, v.z) ** 2.2).applyMatrix3(M_2020_SRGB)
  // Encoded as the screen shows it: three mixes its fog into the encoded colour.
  const encoded = new THREE.Color(Math.min(1, Math.max(0, v.x)), Math.min(1, Math.max(0, v.y)), Math.min(1, Math.max(0, v.z))).convertLinearToSRGB()
  return encoded
}

export interface AtmosphereState {
  look: Look
  exposure: number
  sunIntensity: number
  sunColor: THREE.Color
  skyIrradiance: THREE.Color
  hazeColor: THREE.Color
}

export class Atmosphere {
  readonly sky: SkyDome
  readonly shadows: SunShadows
  private envSky: SkyDome
  private envScene = new THREE.Scene()
  private envGround: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>
  private envWoods: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshBasicMaterial>
  private envTarget: THREE.WebGLRenderTarget | null = null
  private pending = true
  state: AtmosphereState | null = null
  /** The world's lowest ground (local y), where mist lies thickest. */
  groundY = 0

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene) {
    const uniforms = skyUniforms()
    this.sky = new SkyDome(uniforms, true)
    this.envSky = new SkyDome(uniforms, false)
    scene.add(this.sky)
    this.shadows = new SunShadows(scene)
    // The environment's world: the sky, a ring of woods on the horizon and the ground.
    this.envGround = new THREE.Mesh(new THREE.CircleGeometry(60, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ toneMapped: false }))
    this.envGround.position.y = -2
    this.envWoods = new THREE.Mesh(new THREE.CylinderGeometry(50, 50, 4.2, 48, 1, true), new THREE.MeshBasicMaterial({ side: THREE.BackSide, toneMapped: false }))
    this.envWoods.position.y = 0.6
    this.envScene.add(this.envSky, this.envGround, this.envWoods)
  }

  setQuality(quality: ShadowQuality) { this.shadows.setQuality(quality) }

  /** The world (its casters for the shadows), its extent for the far shadows, and its lowest ground for the mist. */
  setWorld(group: THREE.Object3D | null, bounds: THREE.Box3 | null) {
    if (group) markWorldCasters(group)
    this.shadows.setBounds(bounds)
    this.shadows.refresh()
    if (bounds && !bounds.isEmpty()) this.groundY = bounds.min.y
    this.applyHaze()
  }

  apply(look: Look) {
    const sun = new THREE.Vector3()
    sunDirection(look.sun, sun)
    const p = preetham(sun.y, look.turbidity)
    // Clear sky first (for the clouds' light and the overcast's brightness).
    const base: SkyState = {
      sun, preetham: p, cumulus: 0, overcast: 0, rain: 0,
      deck: new THREE.Color(0, 0, 0), cloudSun: new THREE.Color(0, 0, 0), cloudAmbient: new THREE.Color(0, 0, 0),
      haze: new THREE.Color(0, 0, 0), hazeSun: new THREE.Color(0, 0, 0), hazeHeight: 1e-3,
    }
    const clearSky = skyIrradiance(base)
    const elev = Math.max(0.02, sun.y)
    // Direct versus diffuse on the level: about 5:1 with a high sun, less low down and in haze.
    const ratio = (1.1 + 5 * elev) / (1 + 0.22 * (look.turbidity - 2.2))
    const sunColor = new THREE.Color().fromArray(extinction(p, elev))
    sunColor.multiplyScalar(1 / Math.max(sunColor.r, sunColor.g, sunColor.b, 1e-6))
    const clearSunLevel = ratio * lum(clearSky)
    // Scale to the units: clear-sky white level reads 1.
    const scale = Math.PI / (lum(clearSky) + clearSunLevel)
    const sunNormal = clearSunLevel / elev * scale
    // The overcast deck: 30 % of the clear light (rain cloud less), brightest overhead.
    const overcastLevel = 0.3 * (1 - 0.45 * look.rain) * Math.PI
    const deck = new THREE.Color(0.93, 0.96, 1.0).multiplyScalar(overcastLevel / DECK_IRRADIANCE / scale)
    const state: SkyState = {
      ...base,
      cumulus: look.cumulus, overcast: look.overcast, rain: look.rain, deck,
      cloudSun: sunColor.clone().multiplyScalar(sunNormal / Math.PI / scale * 0.85),
      cloudAmbient: clearSky.clone().multiplyScalar(1 / Math.PI),
    }
    // Haze: the horizon's own colour, whiter in humid air, glowing towards the sun.
    const horizon = horizonRadiance(state)
    const whiten = Math.min(1, 0.25 + 0.6 * (1 - look.visibilityKm / 32))
    state.haze = horizon.clone().lerp(new THREE.Color(1, 1, 1).multiplyScalar(lum(horizon) * 1.08), whiten)
    const sunThrough = (1 - look.overcast) ** 2
    state.hazeSun = sunColor.clone().multiplyScalar(sunNormal / scale * 0.0025 * (32 / look.visibilityKm) ** 0.5 * sunThrough)
    state.hazeHeight = look.visibilityKm < 4 ? 0.3 : 0.035 + 0.1 * (1 - look.visibilityKm / 32)
    this.sky.set(state, scale)
    // Light: sun through the clouds, the sky's ambient from the environment.
    const skyE = skyIrradiance(state).multiplyScalar(scale)
    const sunThroughCloud = look.overcast >= 0.99 ? 0.07 * (1 - look.rain) : (1 - 0.8 * look.overcast) * (1 - 0.35 * look.cumulus * look.cumulus)
    const sunIntensity = sunNormal * sunThroughCloud
    this.shadows.near.color.copy(sunColor)
    this.shadows.near.intensity = sunIntensity
    this.shadows.setSun(sun, look.overcast >= 0.99 ? sunThroughCloud * 3 : 1 - 0.4 * look.overcast, Math.min(1, look.overcast * 1.2 + look.cumulus * 0.15))
    // Exposure: most of the way to a fixed middle grey.
    const level = lum(skyE) + sunIntensity * elev
    const exposure = KEY * Math.PI / level * (level / Math.PI) ** 0.15
    this.renderer.toneMappingExposure = exposure
    // The environment: sky, woods and ground, lit by the same light (scene units).
    const total = skyE.clone().add(sunColor.clone().multiplyScalar(sunIntensity * elev))
    const hazeScene = state.haze.clone().multiplyScalar(scale)
    this.envGround.material.color.copy(GROUND_ALBEDO).multiply(total).multiplyScalar(1 / Math.PI)
    const woods = WOODS_ALBEDO.clone().multiply(skyE.clone().add(sunColor.clone().multiplyScalar(sunIntensity * elev * 0.35))).multiplyScalar(1 / Math.PI)
    this.envWoods.material.color.copy(woods.lerp(hazeScene, Math.min(0.6, 0.5 * (1 - Math.exp(-0.5 * 3.912 / look.visibilityKm)))))
    this.scale = scale
    this.state = { look, exposure, sunIntensity, sunColor, skyIrradiance: skyE, hazeColor: hazeScene }
    WORLD_UNIFORMS.uSunDir.value.copy(sun)
    this.applyHaze()
    this.shadows.refresh()
    this.pending = true
  }

  private scale = 1

  private applyHaze() {
    const s = this.state
    if (!s) return
    const u = WORLD_UNIFORMS
    const look = s.look
    u.uHazeColor.value.copy(this.sky.uniforms.hazeColor.value).multiplyScalar(this.scale)
    u.uHazeSun.value.copy(this.sky.uniforms.hazeSun.value).multiplyScalar(this.scale)
    // Koschmieder: 2 % contrast left at the visibility distance.
    u.uFogDensity.value = 3.912 / (look.visibilityKm * 1000)
    u.uFogFalloff.value = look.visibilityKm < 4 ? 1 / 70 : 1 / 1500
    u.uFogBase.value = this.groundY
    u.uWet.value = look.wetness
    // Materials outside the world's own shading (the car, the lines, others' materials)
    // take three's standard fog: about the same haze at a few hundred metres.
    const fog = this.scene.fog instanceof THREE.FogExp2 ? this.scene.fog : (this.scene.fog = new THREE.FogExp2(0xffffff, 0))
    fog.color.copy(toneMapped(s.hazeColor, s.exposure))
    fog.density = Math.sqrt(u.uFogDensity.value / 400)
  }

  /** The world's shadow maps that are due (shadows.ts); call before rendering. */
  renderShadows() {
    this.shadows.render(this.renderer, this.scene)
  }

  /** Rebuild the environment map if the look changed; call before rendering. */
  prepare() {
    if (!this.pending || !this.state) return
    this.pending = false
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    const next = pmrem.fromScene(this.envScene, 0, 0.1, 200, { size: 256 })
    pmrem.dispose()
    this.envTarget?.dispose()
    this.envTarget = next
    this.scene.environment = next.texture
  }

  get environment(): THREE.Texture | null { return this.envTarget?.texture ?? null }

  /** Per frame: the dome around the camera, cloud drift, the shadows on the car and ahead of the view. */
  update(camera: THREE.Camera, timeS: number, car: THREE.Vector3 | null) {
    this.sky.position.copy(camera.position)
    this.sky.scale.setScalar(Math.max(1, (camera as THREE.PerspectiveCamera).near * 10))
    this.sky.uniforms.time.value = timeS
    WORLD_UNIFORMS.uTime.value = timeS
    this.shadows.follow(camera, car)
  }

  /** Mark the environment for a rebuild (after a context loss). */
  invalidate() { this.pending = true; this.shadows.refresh() }

  dispose() {
    this.sky.removeFromParent()
    this.sky.dispose()
    this.envSky.dispose()
    this.envGround.geometry.dispose(); this.envGround.material.dispose()
    this.envWoods.geometry.dispose(); this.envWoods.material.dispose()
    this.shadows.dispose()
    this.envTarget?.dispose()
    if (this.scene.environment === this.envTarget?.texture) this.scene.environment = null
  }
}

export { SHADOW_QUALITY }
