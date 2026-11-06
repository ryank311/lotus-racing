// Grass on a track model's turf: a dense field of blades around the camera
// in the ground's own colours, over the turf's carpet of short grass
// (surfaces.ts turfCarpet), swaying in the session's wind and thinning into
// the turf's shading at its edge. After Ghost of Tsushima's grass (blades
// curved, clumped, turned towards the view so none thins to nothing, dark at
// the root) and SimonDev's three.js grass (instanced tiles with LODs).
//
// The ground around the camera is drawn from above into a small float map
// (height, how grassy, brightness, straw), redrawn before the field could
// reach past it: turf where the ground's texture is grassy, nothing on
// tarmac, kerbs, sand, clay or under buildings and barriers. A small mask of
// it (per 2 m tile: any turf, the ground's height range) is read back
// without waiting, so tiles on tarmac are never drawn and the rest are
// culled by their real height. The field is world tiles (grassTiles.ts):
// each frame the tiles the view can see are listed by tier, nearest first,
// and each tier is one instanced draw of its tile's blades (six draws on
// High, four on Medium). A tile's blades are blue noise, mirrored and turned
// by the tile, so no rows line up. In the vertex shader each blade finds its
// ground, keeps or drops itself by distance (well over a thousand per m²
// near the camera, fewer and wider further out, never under a pixel and a
// half), and takes its height, lean, turn and shade from hashes and noise of
// where it stands, so nothing moves or pops as the camera travels. Near
// blades curve in three segments, further ones in two, then one triangle,
// each easing into the next tier's shape before its tile changes tier.

import * as THREE from 'three'
import { patchWorldMaterial, TURF, TURF_UNIFORMS, WORLD_UNIFORMS } from './surfaces'
import { bladeLayout, fieldRadius, GRASS_QUALITY, GrassTiles, MIN_PIXELS, tierCapacities, type BladeShape, type GrassQuality, type TileMask } from './grassTiles'

export { GRASS_QUALITY, type GrassQuality }

const BAKE_VERTEX = /* glsl */`
varying float vY;
varying vec2 vUv;
void main() {
  vec4 world = modelMatrix * vec4( position, 1.0 );
  vY = world.y;
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`
// Turf: grassy where the texture is green over red and saturated (as the
// ground's shader decides, surfaces.ts), and its brightness.
const BAKE_TURF = /* glsl */`
uniform sampler2D map;
uniform vec3 color;
uniform float baseY;
varying float vY;
varying vec2 vUv;
${TURF}
void main() {
  vec2 gate = turfGate( texture2D( map, vUv, 1.6 ).rgb * color );
  float luma = dot( texture2D( map, vUv, 3.2 ).rgb * color, vec3( 0.2126, 0.7152, 0.0722 ) );
  gl_FragColor = vec4( vY - baseY, gate.x, luma, gate.y );
}
`
// Anything else on the ground: no grass.
const BAKE_SOLID = /* glsl */`
uniform float baseY;
varying float vY;
void main() { gl_FragColor = vec4( vY - baseY, 0.0, 0.0, 1.0 ); }
`

// Each tile of the map's area: how grassy its grassiest point is, and the
// lowest and highest grassy ground in it (world), from 8 × 8 points (25 cm
// apart on a 2 m tile), for the tiles' culling (grassTiles.ts TileMask).
const MASK_VERTEX = /* glsl */`
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`
const MASK_FRAGMENT = /* glsl */`
uniform sampler2D uGrassMap;
uniform vec3 uGrassOrigin;
uniform float uGrassSpan;
uniform vec3 uFirst; // the first tile (x, z); the tile's side (m)
void main() {
  vec2 corner = ( uFirst.xy + floor( gl_FragCoord.xy ) ) * uFirst.z;
  float grass = 0.0, lo = 1e4, hi = -1e4;
  for ( int y = 0; y < 8; y++ ) for ( int x = 0; x < 8; x++ ) {
    vec2 p = corner + ( vec2( float( x ), float( y ) ) + 0.5 ) * ( uFirst.z / 8.0 );
    vec2 uv = vec2( ( p.x - uGrassOrigin.x ) / uGrassSpan + 0.5, ( uGrassOrigin.y - p.y ) / uGrassSpan + 0.5 );
    if ( uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 ) continue;
    vec4 g = textureLod( uGrassMap, uv, 0.0 );
    if ( g.g > 0.3 ) { grass = max( grass, g.g ); lo = min( lo, g.r ); hi = max( hi, g.r ); }
  }
  gl_FragColor = vec4( grass, lo + uGrassOrigin.z, hi + uGrassOrigin.z, 1.0 );
}
`

const GRASS_VERTEX_PARS = /* glsl */`
// position: across the blade (-1, 1; 0 at the tip), up it (0-1).
attribute vec3 blade;   // in its tile (u, v), its rank (0-1: the order blades thin out in)
attribute vec3 coarse;  // the next tier's segment around this vertex (from, to) and the shape (0 fine, 1 plain, 2 single)
attribute vec2 tile;    // per instance: the tile (x, z), in tiles
uniform float uTileM;
uniform vec4 uDensity;  // blades per m² near, out to (m), width (m), the whole list's per m²
uniform vec4 uReach;    // thins from, gone by (m); fine blades plain by, plain single by (m)
uniform float uPixelAngle; // the narrowest blade's angle (MIN_PIXELS)
uniform sampler2D uGrassMap;
uniform vec3 uGrassOrigin; // x, z of the map's centre; its base height
uniform float uGrassSpan;
uniform vec3 uWind;        // towards x, z; strength
uniform float uTime;
uniform sampler2D uMacro;
varying vec3 vGrassColor;
${TURF}
// Four hashes of a point at once (Dave Hoskins' hash42).
vec4 grassHash4( vec2 p ) { vec4 q = fract( p.xyxy * vec4( 0.1031, 0.1030, 0.0973, 0.1099 ) ); q += dot( q, q.wzxy + 33.33 ); return fract( ( q.xxyz + q.yzzw ) * q.zywx ); }
// A blade's middle line at height t (0-1): bent over by bend (m at the tip), a little shorter for it.
vec3 grassCurve( float t, vec2 bend, float tall, float sag ) { return vec3( bend.x * t * t, tall * t * ( 1.0 - sag * t * t ), bend.y * t * t ); }
float grassWidth( float t ) { return 1.0 - t * t; }
`
// In place of beginnormal_vertex (before the normal is used); begin_vertex goes.
const GRASS_BEGIN = /* glsl */`
  // The tile's blades, mirrored and turned by the tile, so neighbours differ.
  float tileHash = turfHash( tile + 0.5 );
  vec2 inTile = tileHash > 0.5 ? blade.yx : blade.xy;
  inTile = mix( inTile, 1.0 - inTile, step( 0.5, fract( tileHash * vec2( 7.13, 13.7 ) ) ) );
  vec2 root = ( tile + inTile ) * uTileM;
  vec2 mapUv = vec2( ( root.x - uGrassOrigin.x ) / uGrassSpan + 0.5, ( uGrassOrigin.y - root.y ) / uGrassSpan + 0.5 );
  vec4 ground = textureLod( uGrassMap, mapUv, 0.0 );
  float inside = step( 0.0, mapUv.x ) * step( mapUv.x, 1.0 ) * step( 0.0, mapUv.y ) * step( mapUv.y, 1.0 );
  vec3 rootW = vec3( root.x, uGrassOrigin.z + ground.r - 0.015, root.y );
  float dist = max( distance( rootW, cameraPosition ), 0.1 );
  // Clumps (as in Ghost of Tsushima), on no grid: two samples of a value
  // noise, turned and scaled apart, make tufts of 30-50 cm. Blades stand
  // fewer between them, and share their height, shade and lean.
  vec4 tuftA = textureLod( uMacro, root * 0.37 + 0.13, 0.0 ), tuftB = textureLod( uMacro, TURF_ROT * root * 0.23 + 0.61, 0.0 );
  float c1 = smoothstep( 0.35, 0.65, 0.5 * ( tuftA.r + tuftB.r ) );
  // How many stand here (grassTiles.ts grassDensity): falling with distance,
  // and as they widen to a pixel; a little thinner in patches over tens of
  // metres and between tufts; only on clean turf.
  vec4 broad = textureLod( uMacro, root * 0.008, 0.0 );
  float patches = smoothstep( 0.25, 0.75, broad.a );
  float pixelW = dist * uPixelAngle;
  float dens = uDensity.x * min( 1.0, uDensity.y / dist ) * min( 1.0, uDensity.z / pixelW ) * ( 1.0 - smoothstep( uReach.x, uReach.y, dist ) )
    * inside * smoothstep( 0.45, 0.9, ground.g ) * mix( 0.7, 1.0, patches ) * mix( 0.75, 1.1, c1 );
  // This blade stands while the density is above its rank; the last few grow in, so none pops.
  float grow = clamp( ( dens - blade.z * uDensity.w ) / max( 0.15 * dens, 1e-4 ), 0.0, 1.0 );
  if ( grow <= 0.0 ) {
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    return;
  }
  vec4 h = grassHash4( tile * 1.618 + inTile * 23.7 );
  float h1 = h.x, h2 = h.y, h3 = h.z, h4 = h.w;
  // 4-14 cm: each clump its own height, taller in the lush patches.
  float tall = mix( 0.045, 0.1, h3 ) * mix( 0.8, 1.25, c1 ) * mix( 0.85, 1.15, patches ) * ( 0.3 + 0.7 * grow );
  float halfWidth = 0.5 * max( uDensity.z * mix( 0.7, 1.3, h4 ), pixelW ) * ( 0.5 + 0.5 * grow );
  // Turned half its own way, half its clump's; and turned partly to face
  // the view, so a blade seen edge on never thins to nothing.
  float c2 = ( tuftA.a + tuftB.a ) * 5.0;
  vec2 own = vec2( cos( h1 * 6.2832 ), sin( h1 * 6.2832 ) ), clumpTurn = vec2( cos( c2 ), sin( c2 ) );
  vec2 across = normalize( own + clumpTurn * 0.8 + 1e-4 );
  vec2 toView = normalize( cameraPosition.xz - rootW.xz + 1e-4 );
  vec2 square = vec2( -toView.y, toView.x );
  across = normalize( mix( across, square * sign( dot( across, square ) + 1e-4 ), 0.45 ) );
  vec2 facing = vec2( -across.y, across.x );
  // Bent over its flat side, some a little sideways; and with the wind, in
  // gusts that roll across the field.
  vec2 bend = ( facing * ( h2 - 0.5 ) * 0.8 + own * ( h4 - 0.5 ) * 0.4 ) * tall;
  float gust = smoothstep( 0.3, 0.75, textureLod( uMacro, ( root - uWind.xy * uTime * 1.6 ) * 0.045, 0.0 ).g );
  bend += uWind.xy * uWind.z * tall * ( 0.15 + 0.85 * gust ) * 0.8;
  bend += facing * sin( uTime * 4.3 + h3 * 6.2832 ) * 0.06 * uWind.z * tall;
  float sag = 0.35 * min( dot( bend, bend ) / ( tall * tall ), 1.2 );
  // Eased into the next tier's shape before its tile changes tier.
  float morph = coarse.z < 0.5 ? smoothstep( 0.7 * uReach.z, uReach.z, dist ) : coarse.z < 1.5 ? smoothstep( 0.7 * uReach.w, uReach.w, dist ) : 0.0;
  float t = position.y;
  float s = ( t - coarse.x ) / max( coarse.y - coarse.x, 1e-3 );
  vec3 along = mix( grassCurve( t, bend, tall, sag ), mix( grassCurve( coarse.x, bend, tall, sag ), grassCurve( coarse.y, bend, tall, sag ), s ), morph );
  float width = mix( grassWidth( t ), mix( grassWidth( coarse.x ), grassWidth( coarse.y ), s ), morph );
  vec3 transformed = rootW + along + vec3( across.x, 0.0, across.y ) * position.x * halfWidth * width;
  // Colour: the ground's own turf there (surfaces.ts), each clump and blade
  // its own shade; dark at the root, yellow-green towards the tip, some tips dry.
  vec3 turf = turfAlbedo( ground.b, ground.a, textureLod( uMacro, TURF_ROT * root * 0.07, 0.0 ).r, broad.g );
  turf *= mix( 0.95, 1.05, broad.r ) * mix( 0.86, 1.14, c1 ) * mix( 0.85, 1.15, h4 );
  vec3 tip = turfTip( mix( 0.25, 1.0, h2 * h2 ) * ( 0.5 + 0.5 * ground.a ) );
  vGrassColor = turf * mix( TURF_ROOT, tip, smoothstep( 0.0, 1.0, t ) ) / TURF_MEAN_LUMA;
  // Lit mostly like the ground under it, a little like the blade's face and lean.
  vec3 objectNormal = normalize( vec3( facing.x * 0.3, 1.0, facing.y * 0.3 ) + vec3( bend.x, 0.0, bend.y ) * ( 0.3 / tall ) );
`

const SHAPES: Record<BladeShape, { levels: number[]; coarse: number[]; kind: number }> = {
  // Three segments, eased into the plain shape's two.
  fine: { levels: [0, 0.35, 0.7], coarse: [0, 0.6, 1], kind: 0 },
  plain: { levels: [0, 0.6], coarse: [0, 1], kind: 1 },
  single: { levels: [0], coarse: [0, 1], kind: 2 },
}

// The world's sun shadow (surfaces.ts worldSunShadow) at one hardware-
// filtered tap per map.
const GRASS_SHADOW = /* glsl */`
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
float grassShadow( sampler2DShadow map, float intensity, float bias, vec4 c ) {
  c.xyz /= c.w;
  #ifdef USE_REVERSED_DEPTH_BUFFER
    c.z -= bias;
  #else
    c.z += bias;
  #endif
  if ( c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0 ) return 1.0;
  return mix( 1.0, texture( map, c.xyz ), intensity );
}
float grassSunShadow( DirectionalLightShadow s0, sampler2DShadow map0, vec4 coord0 ) {
  float shadow = coord0.z >= 0.0 ? grassShadow( map0, s0.shadowIntensity, s0.shadowBias, coord0 ) : 1.0;
  vec3 e = min( vRegionCoord.xyz, 1.0 - vRegionCoord.xyz );
  float w = uRegionShadow.w > 0.0 ? smoothstep( 0.0, uShadowEdge, min( e.z, min( e.x, e.y ) ) ) : 0.0;
  float region = w > 0.0 ? grassShadow( uRegionMap, uRegionShadow.w, uRegionShadow.y, vRegionCoord ) : 1.0;
  float far = 1.0;
  if ( w < 1.0 && uFarShadow.w > 0.0 && vFarCoord.z >= 0.0 ) far = grassShadow( uFarMap, uFarShadow.w, uFarShadow.y, vFarCoord );
  return shadow * mix( far, region, w );
}
#endif
`

/** A tile's first `count` blades (of `layout`, `total` in all) in `shape`, one instance per tile. */
function tierGeometry(layout: Float32Array, count: number, total: number, shape: BladeShape, maxTiles: number): THREE.InstancedBufferGeometry {
  const { levels, coarse, kind } = SHAPES[shape]
  const perBlade = levels.length * 2 + 1
  const vertices = count * perBlade
  const position = new Float32Array(vertices * 3), coarseAt = new Float32Array(vertices * 3), bladeAt = new Float32Array(vertices * 3)
  const index = vertices > 65535 ? new Uint32Array(count * ((levels.length - 1) * 6 + 3)) : new Uint16Array(count * ((levels.length - 1) * 6 + 3))
  const segment = (t: number): [number, number] => {
    for (let k = 1; k < coarse.length; k++) if (t <= coarse[k] || k === coarse.length - 1) return [coarse[k - 1], coarse[k]]
    return [0, 1]
  }
  let v = 0, ix = 0
  for (let b = 0; b < count; b++) {
    const base = v
    const vertex = (side: number, t: number) => {
      const [t0, t1] = segment(t)
      position.set([side, t, 0], v * 3)
      coarseAt.set([t0, t1, kind], v * 3)
      bladeAt.set([layout[b * 2], layout[b * 2 + 1], (b + 0.5) / total], v * 3)
      v++
    }
    for (const t of levels) { vertex(-1, t); vertex(1, t) }
    vertex(0, 1)
    for (let l = 0; l < levels.length - 1; l++) {
      const a = base + l * 2
      index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], ix)
      ix += 6
    }
    const top = base + (levels.length - 1) * 2
    index.set([top, top + 1, top + 2], ix)
    ix += 3
  }
  const geometry = new THREE.InstancedBufferGeometry()
  const positionAttribute = new THREE.BufferAttribute(position, 3)
  geometry.setAttribute('position', positionAttribute)
  // three shades smoothly only with a normal attribute (the shader sets the real one): the same buffer.
  geometry.setAttribute('normal', positionAttribute)
  geometry.setAttribute('coarse', new THREE.BufferAttribute(coarseAt, 3))
  geometry.setAttribute('blade', new THREE.BufferAttribute(bladeAt, 3))
  geometry.setIndex(new THREE.BufferAttribute(index, 1))
  const tiles = new THREE.InstancedBufferAttribute(new Float32Array(maxTiles * 2), 2)
  tiles.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('tile', tiles)
  geometry.instanceCount = 0
  // Placed in the shader around the camera: never culled by three.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9)
  return geometry
}

export class GrassField {
  readonly group = new THREE.Group()
  private target: THREE.WebGLRenderTarget
  private bakeScene = new THREE.Scene()
  private bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000)
  private bakeMaterials: THREE.ShaderMaterial[] = []
  private centre: THREE.Vector3 | null = null
  private meshes: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.MeshLambertMaterial>[] = []
  private material: THREE.MeshLambertMaterial
  private tiles: GrassTiles
  private quality: GrassQuality
  private size = new THREE.Vector2()
  // The tiles' mask, drawn after each map and read back without waiting for it (null where it cannot be).
  private mask: TileMask | null = null
  private maskTarget: THREE.WebGLRenderTarget | null = null
  private maskScene = new THREE.Scene()
  private maskMaterial: THREE.ShaderMaterial | null = null
  private maskCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private bakes = 0
  private disposed = false
  private uniforms = {
    uGrassMap: { value: null as THREE.Texture | null },
    uGrassOrigin: { value: new THREE.Vector3() },
    uGrassSpan: { value: 100 },
    uWind: { value: new THREE.Vector3(0.7, 0.7, 0.3) },
    uTileM: { value: 2 },
    uDensity: { value: new THREE.Vector4() },
    uReach: { value: new THREE.Vector4() },
    uPixelAngle: { value: 0.001 },
    uTime: WORLD_UNIFORMS.uTime,
    uMacro: WORLD_UNIFORMS.uMacro,
  }

  constructor(private renderer: THREE.WebGLRenderer, track: THREE.Object3D, quality: GrassQuality) {
    this.group.name = 'grass'
    this.quality = quality
    this.target = this.makeTarget(quality.mapSize)
    this.tiles = new GrassTiles(quality)
    this.material = this.makeMaterial()
    this.buildBakeScene(track)
    this.buildTiers()
  }

  private makeTarget(size: number) {
    const target = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    })
    target.texture.colorSpace = THREE.NoColorSpace
    this.uniforms.uGrassMap.value = target.texture
    return target
  }

  private makeMaterial() {
    const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide })
    // Haze and the sun's shadows as the world has them; then the blade.
    patchWorldMaterial(material, 'far', f => f
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrassColor;')
      // The sun's shadow one filtered tap a map, not five (blades are small and many).
      .replace('void main() {', `${GRASS_SHADOW}\nvoid main() {`)
      .replace('worldSunShadow( directionalLightShadow', 'grassSunShadow( directionalLightShadow')
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = vGrassColor * ( 1.0 - uWet * 0.25 );')
      // Both faces lit alike: undo three's flip of the back face's normal.
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\n  normal *= faceDirection;\n#endif'), 'grass-field')
    const world = material.onBeforeCompile
    material.onBeforeCompile = (shader, renderer) => {
      world.call(material, shader, renderer)
      Object.assign(shader.uniforms, this.uniforms)
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${GRASS_VERTEX_PARS}`)
        .replace('#include <beginnormal_vertex>', GRASS_BEGIN)
        .replace('#include <begin_vertex>', '')
    }
    return material
  }

  // Copies of the track's ground and solids (sharing their geometry) in
  // bake materials: turf from the texture, everything else no grass.
  private buildBakeScene(track: THREE.Object3D) {
    track.updateMatrixWorld(true)
    const turf = new Map<THREE.Material, THREE.ShaderMaterial>()
    const solid = new THREE.ShaderMaterial({ vertexShader: BAKE_VERTEX, fragmentShader: BAKE_SOLID, uniforms: { baseY: { value: 0 } }, side: THREE.DoubleSide })
    this.bakeMaterials.push(solid)
    track.traverse(object => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return
      const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.MeshStandardMaterial
      const kind = material.userData?.surfaceKind
      if (!kind || kind === 'foliage' || kind === 'far' || material.transparent || material.alphaTest > 0) return
      let bake = solid
      if (kind === 'ground' && material.map) {
        bake = turf.get(material) ?? new THREE.ShaderMaterial({
          vertexShader: BAKE_VERTEX, fragmentShader: BAKE_TURF, side: THREE.DoubleSide,
          uniforms: { map: { value: material.map }, color: { value: material.color.clone() }, baseY: solid.uniforms.baseY },
        })
        if (!turf.has(material)) { turf.set(material, bake); this.bakeMaterials.push(bake) }
      }
      const copy = new THREE.Mesh(mesh.geometry, bake)
      copy.matrixAutoUpdate = false
      copy.matrix.copy(mesh.matrixWorld)
      copy.matrixWorld.copy(mesh.matrixWorld)
      this.bakeScene.add(copy)
    })
    this.bakeScene.matrixWorldAutoUpdate = false
  }

  // One mesh per tier, nearest first, all of one material.
  private buildTiers() {
    for (const mesh of this.meshes) { this.group.remove(mesh); mesh.geometry.dispose() }
    this.meshes = []
    const q = this.quality
    const capacities = tierCapacities(q)
    const total = capacities[0]
    const layout = bladeLayout(total)
    const u = this.uniforms
    u.uTileM.value = q.tileM
    u.uDensity.value.set(q.densityNear, q.nearM, q.widthM, total / (q.tileM * q.tileM))
    // Fine blades are plain by the first plain tier, plain ones single by the first single tier.
    const reachOf = (shape: BladeShape) => { const i = q.tiers.findIndex(t => t.shape === shape); return i > 0 ? q.tiers[i - 1].reachM : 1e6 }
    u.uReach.value.set(q.fadeFromM, fieldRadius(q), reachOf('plain'), reachOf('single'))
    TURF_UNIFORMS.uGrassReach.value.set(q.fadeFromM, fieldRadius(q))
    q.tiers.forEach((tier, i) => {
      const mesh = new THREE.Mesh(tierGeometry(layout, capacities[i], total, tier.shape, this.tiles.maxTiles), this.material)
      mesh.name = 'grass-blades'
      mesh.frustumCulled = false
      mesh.receiveShadow = true
      mesh.castShadow = false
      // Before the world's other solids: the turf hidden behind blades is never shaded.
      mesh.renderOrder = -1
      mesh.visible = false
      this.group.add(mesh)
      this.meshes.push(mesh)
    })
  }

  setQuality(quality: GrassQuality) {
    if (quality === this.quality) return
    this.quality = quality
    if (this.target.width !== quality.mapSize) { this.target.dispose(); this.target = this.makeTarget(quality.mapSize) }
    this.tiles = new GrassTiles(quality)
    this.centre = null
    this.mask = null
    // A mask still being read back was for the last level's map.
    this.bakes++
    this.buildTiers()
  }

  /** Draw the map again before the next frame (its target is new after a lost context). */
  invalidate() { this.centre = null }

  /** Wind: where it blows towards (degrees from north) and how hard (m/s). */
  setWind(toDeg: number, mps: number) {
    const a = toDeg * Math.PI / 180
    this.uniforms.uWind.value.set(Math.sin(a), -Math.cos(a), Math.min(1.2, 0.15 + mps * 0.1))
  }

  /**
   * Per frame, with the camera the scene is drawn with and the ground's
   * height near it: the tiles in view; the map redrawn before the field
   * could reach past its edge.
   */
  update(camera: THREE.Camera, groundY: number) {
    const p = camera.position
    const q = this.quality
    const span = q.mapSpanM
    const moveM = span / 2 - fieldRadius(q) - q.tileM * 2
    if (!this.centre || Math.hypot(p.x - this.centre.x, p.z - this.centre.z) > moveM || Math.abs(p.y - this.centre.y) > 30) {
      // Snapped to texels so the map's samples stay on the same ground.
      const texel = span / q.mapSize
      this.centre = new THREE.Vector3(Math.round(p.x / texel) * texel, p.y, Math.round(p.z / texel) * texel)
      this.bake(this.centre)
      this.readMask(this.centre)
    }
    // A blade at least about a pixel wide (the screen's pixels, or the lens's a little smaller).
    const perspective = camera as THREE.PerspectiveCamera
    if (perspective.isPerspectiveCamera) {
      const height = this.renderer.getDrawingBufferSize(this.size).y
      this.uniforms.uPixelAngle.value = MIN_PIXELS * 2 * Math.tan(perspective.fov * Math.PI / 360) / (perspective.zoom * Math.max(1, height))
    }
    if (!this.tiles.select(camera, groundY, this.mask)) return
    this.meshes.forEach((mesh, i) => {
      const n = this.tiles.counts[i]
      mesh.visible = n > 0
      if (!n) return
      const attribute = mesh.geometry.getAttribute('tile') as THREE.InstancedBufferAttribute
      ;(attribute.array as Float32Array).set(this.tiles.tiles[i].subarray(0, n * 2))
      attribute.clearUpdateRanges()
      attribute.addUpdateRange(0, n * 2)
      attribute.needsUpdate = true
      mesh.geometry.instanceCount = n
    })
  }

  private bake(centre: THREE.Vector3) {
    const span = this.quality.mapSpanM
    const cam = this.bakeCamera
    Object.assign(cam, { left: -span / 2, right: span / 2, top: span / 2, bottom: -span / 2, near: 1, far: 1200 })
    cam.position.set(centre.x, centre.y + 600, centre.z)
    cam.up.set(0, 0, -1)
    cam.lookAt(centre.x, centre.y, centre.z)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    for (const m of this.bakeMaterials) if (m.uniforms.baseY) m.uniforms.baseY.value = centre.y
    this.uniforms.uGrassOrigin.value.set(centre.x, centre.z, centre.y)
    this.uniforms.uGrassSpan.value = span
    const renderer = this.renderer
    const before = { target: renderer.getRenderTarget(), color: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), shadow: renderer.shadowMap.autoUpdate }
    renderer.shadowMap.autoUpdate = false
    renderer.setRenderTarget(this.target)
    renderer.setClearColor(0x000000, 1)
    renderer.clear(true, true, false)
    renderer.render(this.bakeScene, cam)
    renderer.setRenderTarget(before.target)
    renderer.setClearColor(before.color, before.alpha)
    renderer.shadowMap.autoUpdate = before.shadow
  }

  // The tiles' mask for the map just drawn: drawn now, read back when the
  // GPU has it (a few frames); until then the last one stands.
  private readMask(centre: THREE.Vector3) {
    const renderer = this.renderer
    if (!renderer.extensions.has('EXT_color_buffer_float')) return
    const q = this.quality, s = q.tileM, span = q.mapSpanM
    const size = Math.ceil(span / s) + 1
    const i0 = Math.floor((centre.x - span / 2) / s), j0 = Math.floor((centre.z - span / 2) / s)
    if (!this.maskMaterial) {
      this.maskMaterial = new THREE.ShaderMaterial({
        vertexShader: MASK_VERTEX, fragmentShader: MASK_FRAGMENT, depthTest: false, depthWrite: false,
        uniforms: { uGrassMap: this.uniforms.uGrassMap, uGrassOrigin: this.uniforms.uGrassOrigin, uGrassSpan: this.uniforms.uGrassSpan, uFirst: { value: new THREE.Vector3() } },
      })
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.maskMaterial)
      quad.frustumCulled = false
      this.maskScene.add(quad)
    }
    if (this.maskTarget?.width !== size) {
      this.maskTarget?.dispose()
      this.maskTarget = new THREE.WebGLRenderTarget(size, size, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false })
    }
    ;(this.maskMaterial.uniforms.uFirst.value as THREE.Vector3).set(i0, j0, s)
    const target = this.maskTarget
    const before = renderer.getRenderTarget()
    renderer.setRenderTarget(target)
    renderer.render(this.maskScene, this.maskCamera)
    renderer.setRenderTarget(before)
    const bake = ++this.bakes
    const data = new Float32Array(size * size * 4)
    renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size, data).then(() => {
      if (bake !== this.bakes || this.disposed) return
      this.mask = { i0, j0, size, data }
    }, () => { /* the tiles are chosen without it */ })
  }

  dispose() {
    this.disposed = true
    this.maskTarget?.dispose()
    this.maskMaterial?.dispose()
    for (const quad of this.maskScene.children) (quad as THREE.Mesh).geometry.dispose()
    this.group.removeFromParent()
    for (const mesh of this.meshes) mesh.geometry.dispose()
    this.material.dispose()
    for (const m of this.bakeMaterials) m.dispose()
    this.target.dispose()
    TURF_UNIFORMS.uGrassReach.value.set(0, 0)
  }
}
