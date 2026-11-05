// The world's shading on top of three's standard material: close-up detail
// for tarmac and grass (procedural tiling textures, so the track model's
// soft textures hold up near the car), a wet surface (darker, glossy, with
// puddles), aerial haze in the scene's linear light, and the sun's far
// shadow beyond the near shadow map. Every patched material shares one set
// of uniforms (WORLD_UNIFORMS), driven by the atmosphere.

import * as THREE from 'three'
import { WORLD_SHADOW_UNIFORMS } from './shadows'

/** How a world surface shades. */
export type SurfaceKind = 'road' | 'kerb' | 'paint' | 'ground' | 'foliage' | 'object' | 'water' | 'far'

export const WORLD_UNIFORMS = {
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uHazeColor: { value: new THREE.Color() },
  uHazeSun: { value: new THREE.Color() },
  /** Extinction per metre at the haze's base height. */
  uFogDensity: { value: 0 },
  /** Haze thins upward: 1 / scale height, per metre. */
  uFogFalloff: { value: 1 / 1500 },
  uFogBase: { value: 0 },
  uWet: { value: 0 },
  uTime: { value: 0 },
  uDetail: { value: null as THREE.Texture | null },
  uMacro: { value: null as THREE.Texture | null },
  /** The region shadow map's fade to the far map, in its UV units. */
  uShadowEdge: { value: 0.08 },
}

// ─── Procedural textures ───────────────────────────────────────────────────

let seed = 1
const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647

/** A height field (0–1, tiling) to a texture: rg = surface tilt, b = albedo, a = height. */
function heightTexture(size: number, height: Float32Array, albedo: Float32Array, slope: number, maxAnisotropy: number): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x
    const hx = height[y * size + ((x + 1) % size)] - height[y * size + ((x - 1 + size) % size)]
    const hy = height[((y + 1) % size) * size + x] - height[((y - 1 + size) % size) * size + x]
    data[i * 4] = Math.max(0, Math.min(255, 128 - hx * slope * 127))
    data[i * 4 + 1] = Math.max(0, Math.min(255, 128 - hy * slope * 127))
    data[i * 4 + 2] = Math.max(0, Math.min(255, albedo[i] * 128))
    data[i * 4 + 3] = Math.max(0, Math.min(255, height[i] * 255))
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = maxAnisotropy
  texture.colorSpace = THREE.NoColorSpace
  texture.needsUpdate = true
  return texture
}

/** Splat a soft disc into a tiling field (max blend). */
function splat(field: Float32Array, size: number, cx: number, cy: number, r: number, h: number, round = true) {
  const r2 = r * r
  for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
    const d2 = dx * dx + dy * dy
    if (d2 > r2) continue
    const x = (Math.round(cx) + dx + size) % size, y = (Math.round(cy) + dy + size) % size
    const v = h * (round ? Math.sqrt(1 - d2 / r2) : 1)
    if (v > field[y * size + x]) field[y * size + x] = v
  }
}

/** Tarmac aggregate: small stones, worn flat on top, some lighter, in a darker binder. */
function asphaltDetail(maxAnisotropy: number): THREE.DataTexture {
  const size = 512
  seed = 7
  const height = new Float32Array(size * size), albedo = new Float32Array(size * size).fill(0.86)
  for (let i = 0; i < height.length; i++) height[i] = random() * 0.1
  for (let k = 0; k < 16000; k++) {
    const x = random() * size, y = random() * size, r = 0.6 + random() * random() * 1.9
    splat(height, size, x, y, r, 0.3 + random() * 0.7)
    const tone = 0.78 + random() * 0.5
    const rr = Math.max(1, Math.round(r * 0.8))
    for (let dy = -rr; dy <= rr; dy++) for (let dx = -rr; dx <= rr; dx++) {
      if (dx * dx + dy * dy > rr * rr) continue
      albedo[((Math.round(y) + dy + size) % size) * size + (Math.round(x) + dx + size) % size] = tone
    }
  }
  // Traffic wears the tops flat.
  for (let i = 0; i < height.length; i++) height[i] = Math.min(height[i], 0.55)
  return heightTexture(size, height, albedo, 1.2, maxAnisotropy)
}

/** Large, soft, tiling noise: r = fine fbm, g = coarse fbm, b = cells, a = patches. */
function macroNoise(): THREE.DataTexture {
  const size = 256
  seed = 23
  const octave = (cells: number) => {
    const lattice = new Float32Array(cells * cells).map(() => random())
    const out = new Float32Array(size * size)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const fx = x / size * cells, fy = y / size * cells
      const ix = Math.floor(fx), iy = Math.floor(fy)
      let u = fx - ix, v = fy - iy
      u = u * u * (3 - 2 * u); v = v * v * (3 - 2 * v)
      const at = (a: number, b: number) => lattice[((b + cells) % cells) * cells + (a + cells) % cells]
      out[y * size + x] = (at(ix, iy) * (1 - u) + at(ix + 1, iy) * u) * (1 - v) + (at(ix, iy + 1) * (1 - u) + at(ix + 1, iy + 1) * u) * v
    }
    return out
  }
  const fbm = (base: number) => {
    const sum = new Float32Array(size * size)
    let amp = 0.5, total = 0
    for (let o = 0; o < 5; o++) {
      const layer = octave(base << o)
      for (let i = 0; i < sum.length; i++) sum[i] += layer[i] * amp
      total += amp; amp *= 0.5
    }
    for (let i = 0; i < sum.length; i++) sum[i] /= total
    return sum
  }
  const fine = fbm(8), coarse = fbm(3), cells = octave(32), patches = fbm(5)
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = fine[i] * 255; data[i * 4 + 1] = coarse[i] * 255; data[i * 4 + 2] = cells[i] * 255; data[i * 4 + 3] = patches[i] * 255
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.generateMipmaps = true
  texture.needsUpdate = true
  return texture
}

/** Builds the shared detail textures once (a few tens of milliseconds). */
export function ensureDetailTextures(maxAnisotropy: number) {
  const u = WORLD_UNIFORMS
  u.uDetail.value ??= asphaltDetail(maxAnisotropy)
  u.uMacro.value ??= macroNoise()
}

export function disposeDetailTextures() {
  const u = WORLD_UNIFORMS
  for (const key of ['uDetail', 'uMacro'] as const) { u[key].value?.dispose(); u[key].value = null }
}

// ─── Shader patch ───────────────────────────────────────────────────────────

const VERTEX_PARS = /* glsl */`
varying vec3 vWorldPos;
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform mat4 uRegionMatrix;
uniform mat4 uFarMatrix;
uniform float uRegionNormalBias;
uniform float uFarNormalBias;
varying vec4 vRegionCoord;
varying vec4 vFarCoord;
#endif
`
const VERTEX_MAIN = /* glsl */`
{
  vec4 wp = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    wp = instanceMatrix * wp;
  #endif
  vec4 worldPos4 = modelMatrix * wp;
  vWorldPos = worldPos4.xyz;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
    // The world's shadow maps (shadows.ts), offset along the normal as three does.
    vec3 shadowNormal = inverseTransformDirection( transformedNormal, viewMatrix );
    vRegionCoord = uRegionMatrix * ( worldPos4 + vec4( shadowNormal * uRegionNormalBias, 0.0 ) );
    vFarCoord = uFarMatrix * ( worldPos4 + vec4( shadowNormal * uFarNormalBias, 0.0 ) );
  #endif
}
`

/**
 * Turf, shared by the ground's shader and the grass blades (grass.ts):
 * turfGate(photo) → (how grassy: green over red and saturated, so not sand,
 * gravel or clay; how straw-yellow), and turfAlbedo(brightness, straw, clump
 * noise, dry-patch noise) → lush, dark or straw-green turf at that brightness.
 */
export const TURF = /* glsl */`
const mat2 TURF_ROT = mat2( 0.7986, -0.6018, 0.6018, 0.7986 );
vec2 turfGate( vec3 c ) {
  float mx = max( c.r, max( c.g, c.b ) ), mn = min( c.r, min( c.g, c.b ) );
  float gr = c.g / max( c.r, 1e-4 );
  float grassy = smoothstep( 0.6, 0.75, gr ) * smoothstep( 0.3, 0.42, ( mx - mn ) / max( mx, 1e-4 ) );
  return vec2( grassy, 1.0 - smoothstep( 0.78, 0.98, gr ) );
}
vec3 turfAlbedo( float luma, float straw, float clump, float dry ) {
  vec3 t = mix( vec3( 0.07, 0.115, 0.032 ), vec3( 0.045, 0.08, 0.026 ), smoothstep( 0.42, 0.68, clump ) );
  t = mix( t, vec3( 0.12, 0.122, 0.058 ), clamp( 0.35 * smoothstep( 0.45, 0.8, dry ) + 0.45 * straw, 0.0, 1.0 ) );
  return t * luma / max( dot( t, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-4 );
}
`

const FRAGMENT_PARS = /* glsl */`
varying vec3 vWorldPos;
uniform vec3 uSunDir;
uniform vec3 uHazeColor;
uniform vec3 uHazeSun;
uniform float uFogDensity;
uniform float uFogFalloff;
uniform float uFogBase;
uniform float uWet;
uniform sampler2D uDetail;
uniform sampler2D uMacro;
uniform float uShadowEdge;

${TURF}

// Standing water: a few soft-edged pools where the surface is level, none on slopes.
float worldPuddleMask( vec4 macro ) {
  if ( uWet < 0.5 ) return 0.0;
  vec3 faceNormal = normalize( cross( dFdx( vWorldPos ), dFdy( vWorldPos ) ) );
  float level = smoothstep( 0.9975, 0.9995, abs( faceNormal.y ) );
  // Two fbm scales (tens of metres and a few metres), so pools are rare and ragged.
  float pools = texture2D( uMacro, vWorldPos.xz * 0.031 + 0.5 ).a * 0.6 + texture2D( uMacro, vWorldPos.xz * 0.13 + 0.2 ).r * 0.4;
  return smoothstep( 0.62, 0.7, pools ) * level * smoothstep( 0.5, 1.0, uWet );
}

float worldHg( float c, float g ) { float g2 = g * g; return ( 1.0 - g2 ) / pow( 1.0 + g2 - 2.0 * g * c, 1.5 ) * 0.0795774715; }

vec3 worldHaze( vec3 color ) {
  vec3 view = vWorldPos - cameraPosition;
  float dist = length( view );
  // Exponential haze thinning with height: the optical depth along the ray.
  float h0 = cameraPosition.y - uFogBase, h1 = vWorldPos.y - uFogBase;
  float dh = h1 - h0;
  float k = uFogFalloff;
  float density = abs( dh * k ) > 1e-3 ? ( exp( -k * h0 ) - exp( -k * h1 ) ) / ( k * dh ) : exp( -k * h0 );
  float fog = 1.0 - exp( -uFogDensity * dist * min( density, 8.0 ) );
  vec3 haze = uHazeColor + uHazeSun * worldHg( dot( view / max( dist, 1e-3 ), uSunDir ), 0.7 ) * 12.566;
  return mix( color, haze, fog );
}

#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
uniform sampler2DShadow uRegionMap;
uniform sampler2DShadow uFarMap;
uniform vec4 uRegionShadow;
uniform vec4 uFarShadow;
varying vec4 vRegionCoord;
varying vec4 vFarCoord;
// The sun's shadow: the cars' map (three's, map 0) times the world's: the
// region map where it reaches, fading to the whole-track map beyond (shadows.ts).
float worldSunShadow( DirectionalLightShadow s0, sampler2DShadow map0, vec4 coord0 ) {
  float shadow = getShadow( map0, s0.shadowMapSize, s0.shadowIntensity, s0.shadowBias, s0.shadowRadius, coord0 );
  vec2 c = vRegionCoord.xy / vRegionCoord.w;
  vec2 e = min( c, 1.0 - c );
  float w = uRegionShadow.w > 0.0 ? smoothstep( 0.0, uShadowEdge, min( e.x, e.y ) ) : 0.0;
  float world = 1.0;
  if ( w > 0.0 ) world = getShadow( uRegionMap, uRegionShadow.xx, uRegionShadow.w, uRegionShadow.y, uRegionShadow.z, vRegionCoord );
  if ( w < 1.0 && uFarShadow.w > 0.0 ) world = mix( getShadow( uFarMap, uFarShadow.xx, uFarShadow.w, uFarShadow.y, uFarShadow.z, vFarCoord ), world, w );
  return shadow * world;
}
#endif
`

// After map_fragment: detail albedo and wetness darkening. Variables used
// later: worldDetail (rg tilt, a height), worldFade, worldPuddle.
// Fades for close-up detail: by distance, and before the texture's texels
// shrink below a pixel (so it never aliases into noise).
const FADE = /* glsl */`
  float worldDist = length( vWorldPos - cameraPosition );
  float worldTexelsPerPixel = max( length( fwidth( vWorldPos.xz ) ), 1e-5 );
`

const DETAIL = {
  // Tarmac: fine aggregate close up, gone by 30 m; macro patching (rubber,
  // repairs) over tens of metres.
  road: /* glsl */`
  ${FADE}
  float worldFade = ( 1.0 - smoothstep( 6.0, 30.0, worldDist ) ) * ( 1.0 - smoothstep( 0.004, 0.012, worldTexelsPerPixel ) ) * WORLD_DETAIL;
  vec4 worldDetail = texture2D( uDetail, vWorldPos.xz * 0.62 );
  vec4 worldMacro = texture2D( uMacro, vWorldPos.xz * 0.011 );
  diffuseColor.rgb *= mix( 1.0, worldDetail.b * 1.16, 0.18 * worldFade ) * mix( 0.95, 1.05, worldMacro.r );
  float worldPuddle = worldPuddleMask( worldMacro );
  diffuseColor.rgb *= 1.0 - uWet * ( 0.42 + 0.18 * worldMacro.g ) - 0.25 * worldPuddle;
`,
  // Kerbs, lines and plain concrete keep their own texture; only water darkens them.
  painted: /* glsl */`
  vec4 worldMacro = texture2D( uMacro, vWorldPos.xz * 0.011 );
  float worldPuddle = 0.6 * worldPuddleMask( worldMacro );
  diffuseColor.rgb *= 1.0 - uWet * 0.3;
`,
  // Turf. The aerial photo (sampled soft, see GROUND_MAP) gives the colour
  // over metres: where it is grassy (green over red, and saturated, so not
  // sand, gravel or clay) a procedural turf takes over at the photo's
  // brightness, mixing lush, dark and straw greens by world noise at three
  // scales, with a fine tuft mottle close up.
  ground: /* glsl */`
  ${FADE}
  vec2 worldXZ = vWorldPos.xz;
  vec3 worldPhoto = diffuseColor.rgb;
  // Brightness from a much softer lookup: the photo's own streaks stay out.
  #ifdef USE_MAP
    float worldLuma = dot( texture2D( map, vMapUv, 3.2 ).rgb * diffuse, vec3( 0.2126, 0.7152, 0.0722 ) );
  #else
    float worldLuma = dot( worldPhoto, vec3( 0.2126, 0.7152, 0.0722 ) );
  #endif
  vec2 worldGate = turfGate( worldPhoto );
  vec4 worldMacro = texture2D( uMacro, worldXZ * 0.008 );
  float worldClump = texture2D( uMacro, TURF_ROT * worldXZ * 0.07 ).r;
  vec3 worldTurf = turfAlbedo( worldLuma, worldGate.y, worldClump, worldMacro.g );
  float worldGrassy = worldGate.x;
  diffuseColor.rgb = mix( worldPhoto, worldTurf, 0.85 * worldGrassy );
  diffuseColor.rgb *= mix( 0.95, 1.05, worldMacro.r );
  // Tufts: two noise samples at other scales and angles (hides the tiling),
  // about ±10 %, to 25 m (the noise is mipmapped: it softens, never aliases).
  float worldFade = 1.0 - smoothstep( 18.0, 32.0, worldDist );
  float worldTuft = texture2D( uMacro, worldXZ * 1.1 ).r + texture2D( uMacro, TURF_ROT * worldXZ * 2.7 + 0.31 ).r - 1.0;
  diffuseColor.rgb *= 1.0 + 0.2 * worldTuft * worldFade * worldGrassy;
  float worldPuddle = 0.0;
  diffuseColor.rgb *= 1.0 - uWet * 0.25;
  diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * vec3( 0.93, 1.04, 0.9 ), uWet * 0.5 * worldGrassy );
`,
  object: /* glsl */`
  float worldPuddle = 0.0;
  diffuseColor.rgb *= 1.0 - uWet * 0.18;
`,
}

// After roughnessmap_fragment.
const ROUGHNESS = {
  road: /* glsl */`
  roughnessFactor = mix( roughnessFactor * mix( 0.96, 1.04, worldDetail.a ), mix( 0.24, 0.4, worldDetail.a ), uWet );
  roughnessFactor = mix( roughnessFactor, 0.035, worldPuddle );
`,
  painted: /* glsl */`
  roughnessFactor = mix( roughnessFactor, 0.22, uWet );
  roughnessFactor = mix( roughnessFactor, 0.05, worldPuddle );
`,
  ground: /* glsl */`
  roughnessFactor = mix( roughnessFactor, 0.62, uWet );
`,
  object: /* glsl */`
  roughnessFactor = mix( roughnessFactor, roughnessFactor * 0.6, uWet );
`,
}

// After normal_fragment_maps: a soft tilt in world x/z, into view space.
const NORMAL = {
  road: /* glsl */`
  {
    vec2 tilt = ( worldDetail.rg * 2.0 - 1.0 ) * 0.1 * worldFade * ( 1.0 - worldPuddle ) * ( 1.0 - 0.5 * uWet );
    normal = normalize( normal + ( viewMatrix * vec4( tilt.x, 0.0, tilt.y, 0.0 ) ).xyz );
  }
`,
  ground: /* glsl */`
  {
    // The tufts' slope, gently.
    vec2 tilt = vec2( dFdx( worldTuft ), dFdy( worldTuft ) );
    tilt = clamp( tilt * 0.6, -0.12, 0.12 ) * worldFade;
    normal = normalize( normal + ( viewMatrix * vec4( tilt.x, 0.0, tilt.y, 0.0 ) ).xyz );
  }
`,
}

// Turf: the photo sampled a mip and a half softer, so up close it is colour,
// never smeared pixels (the turf above brings the fine detail).
const GROUND_MAP = /* glsl */`
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vMapUv, 1.6 );
  diffuseColor *= sampledDiffuseColor;
#endif
`

function group(kind: SurfaceKind): 'road' | 'painted' | 'ground' | 'object' | null {
  if (kind === 'road') return 'road'
  if (kind === 'kerb' || kind === 'paint') return 'painted'
  if (kind === 'ground') return 'ground'
  if (kind === 'object' || kind === 'water') return 'object'
  return null
}

// Hooks applied before three resolves includes and unrolls loops.
function patchShader(shader: THREE.WebGLProgramParametersWithUniforms, kind: SurfaceKind, extraFragment: ((fragment: string) => string) | undefined, detail: number) {
  Object.assign(shader.uniforms, WORLD_UNIFORMS, WORLD_SHADOW_UNIFORMS)

  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_MAIN}`)
  let f = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n#define WORLD_DETAIL ${detail.toFixed(2)}\n${FRAGMENT_PARS.split('#if defined( USE_SHADOWMAP )')[0]}`)
    // The far-shadow helper needs the shadow functions: after their declarations.
    .replace('#include <shadowmap_pars_fragment>', `#include <shadowmap_pars_fragment>\n#if defined( USE_SHADOWMAP )${FRAGMENT_PARS.split('#if defined( USE_SHADOWMAP )')[1]}`)
  const g = group(kind)
  if (g) {
    f = f.replace('#include <map_fragment>', `${g === 'ground' ? GROUND_MAP : '#include <map_fragment>'}\n${DETAIL[g]}`)
    if (f.includes('#include <roughnessmap_fragment>')) f = f.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${ROUGHNESS[g]}`)
    if (g === 'road' || g === 'ground') f = f.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${NORMAL[g]}`)
  }
  // The sun's shadow: near map, then the far one.
  f = f.replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(
    /directLight\.color \*= \( directLight\.visible && receiveShadow \) \? getShadow\( directionalShadowMap\[ i \][^;]*vDirectionalShadowCoord\[ i \] \) : 1\.0;/,
    `#if ( UNROLLED_LOOP_INDEX == 0 )
      directLight.color *= ( directLight.visible && receiveShadow ) ? worldSunShadow( directionalLightShadow, directionalShadowMap[ i ], vDirectionalShadowCoord[ i ] ) : 1.0;
    #endif`))
  // Haze in linear light, before tone mapping; three's own fog is not used.
  f = f.replace('#include <tonemapping_fragment>', 'gl_FragColor.rgb = worldHaze( gl_FragColor.rgb );\n#include <tonemapping_fragment>')
    .replace('#include <fog_fragment>', '')
  shader.fragmentShader = extraFragment ? extraFragment(f) : f
}

export interface SurfaceOptions {
  /** Strength of the close-up detail (tarmac aggregate), 0–1. */
  detail?: number
}

/** Patches a world material (MeshStandardMaterial or MeshLambertMaterial) in place. */
export function patchWorldMaterial(material: THREE.Material, kind: SurfaceKind, extraFragment?: (fragment: string) => string, cacheKey = '', options: SurfaceOptions = {}) {
  const detail = Math.round((options.detail ?? 1) * 100) / 100
  material.onBeforeCompile = shader => patchShader(shader, kind, extraFragment, detail)
  material.customProgramCacheKey = () => `world:${kind}:${cacheKey}:${detail}`
  material.userData.surfaceKind = kind
  material.needsUpdate = true
}
