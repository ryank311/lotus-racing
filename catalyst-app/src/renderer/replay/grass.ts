// Grass blades near the camera on a track model's turf: sparse clumps that
// sit in the ground's colour and sway in the session's wind.
//
// The ground around the camera is drawn from above into a small float map
// (height, how grassy, brightness), redrawn when the camera has moved a
// quarter of its width: turf where the aerial photo is grassy, nothing on
// tarmac, kerbs, sand, clay or under buildings and barriers. Two rings of
// instances (dense near, sparse further) are placed in the vertex shader on
// a world grid around the camera, each clump jittered, turned and sized by a
// hash of its world cell, so nothing moves or pops as the camera travels and
// there are no tiles. Two draw calls; nothing changes on the CPU per frame
// but a few uniforms.

import * as THREE from 'three'
import { patchWorldMaterial, TURF, WORLD_UNIFORMS } from './surfaces'

export interface GrassQuality {
  /** Map texels and side (m). */
  mapSize: number
  mapSpanM: number
  /** Near ring: cell (m) and radius (m); far ring: cell and radius. */
  nearCellM: number
  nearRadiusM: number
  farCellM: number
  farRadiusM: number
}

/** By graphics level; none on Low (a constrained device: the blades and their map go first). */
export const GRASS_QUALITY: Record<'high' | 'medium' | 'low', GrassQuality | null> = {
  high: { mapSize: 1024, mapSpanM: 150, nearCellM: 0.22, nearRadiusM: 16, farCellM: 0.75, farRadiusM: 50 },
  medium: { mapSize: 512, mapSpanM: 110, nearCellM: 0.32, nearRadiusM: 12, farCellM: 1.0, farRadiusM: 32 },
  low: null,
}

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
// Turf: grassy where the photo is green over red and saturated (as the
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

// The blade clump: placed, sized and swayed from its world cell.
const GRASS_VERTEX_PARS = /* glsl */`
attribute vec2 cellOffset;
uniform vec2 uCamCell;
uniform float uCell;
uniform float uFadeIn;
uniform float uFadeOut;
uniform float uRadius;
uniform sampler2D uGrassMap;
uniform vec3 uGrassOrigin; // x, z of the map's centre; its base height
uniform float uGrassSpan;
uniform vec3 uWind;        // towards x, z; strength
uniform float uTime;
varying vec3 vGrassColor;
${TURF}
float grassHash( vec2 p ) { vec3 q = fract( p.xyx * vec3( 0.1031, 0.1030, 0.0973 ) ); q += dot( q, q.yzx + 33.33 ); return fract( ( q.x + q.y ) * q.z ); }
`
// In place of beginnormal_vertex (before the normal is used); begin_vertex goes.
const GRASS_BEGIN = /* glsl */`
  vec2 cellId = uCamCell + cellOffset;
  float h1 = grassHash( cellId ), h2 = grassHash( cellId + 17.31 ), h3 = grassHash( cellId + 41.7 ), h4 = grassHash( cellId + 73.1 );
  vec2 root = ( cellId + vec2( h1, h2 ) ) * uCell;
  vec2 mapUv = vec2( ( root.x - uGrassOrigin.x ) / uGrassSpan + 0.5, ( uGrassOrigin.y - root.y ) / uGrassSpan + 0.5 );
  vec4 ground = textureLod( uGrassMap, mapUv, 0.0 );
  float inside = step( 0.0, mapUv.x ) * step( mapUv.x, 1.0 ) * step( 0.0, mapUv.y ) * step( mapUv.y, 1.0 );
  float dist = distance( root, cameraPosition.xz );
  // Thin out at the ring's edges; patchy (world noise); only on clean turf.
  float ring = smoothstep( uFadeIn * 0.8, uFadeIn, dist ) * ( 1.0 - smoothstep( uFadeOut, uRadius, dist ) );
  // Patchy over tens of metres, and clustered in tufts of a metre or two.
  float patches = smoothstep( 0.3, 0.7, textureLod( uMacro, root * 0.021, 0.0 ).g );
  float tufts = smoothstep( 0.35, 0.65, textureLod( uMacro, root * 0.37 + 0.13, 0.0 ).r );
  float keep = inside * smoothstep( 0.45, 0.9, ground.g ) * ring * mix( 0.3, 0.95, patches ) * mix( 0.35, 1.0, tufts );
  float grow = keep > h3 ? smoothstep( h3, h3 + 0.2, keep ) : 0.0;
  // Blades 6-16 cm, wider further out (so they never thin below a pixel).
  float far = smoothstep( 6.0, 40.0, dist );
  float tall = mix( 0.06, 0.16, h4 * h4 ) * mix( 1.0, 1.35, far ) * grow;
  float halfWidth = mix( 0.005, 0.022, far ) * grow;
  // Each blade turned by its own angle (position.z) about the clump's turn.
  float turn = h1 * 6.2832 + position.z;
  vec2 bladeDir = vec2( cos( turn ), sin( turn ) );
  vec3 transformed = vec3( bladeDir.x * position.x * halfWidth, position.y * tall, bladeDir.y * position.x * halfWidth );
  // Splayed from the clump's middle, tips further out.
  mat2 spin = mat2( cos( h1 * 6.2832 ), sin( h1 * 6.2832 ), -sin( h1 * 6.2832 ), cos( h1 * 6.2832 ) );
  transformed.xz += spin * uv * tall * ( 0.12 + 0.3 * position.y );
  // Sway: the blade bends with its height, in gusts that roll across the field.
  float gust = 0.55 + 0.45 * sin( uTime * 1.7 + dot( root, uWind.xy ) * 0.23 + h2 * 6.2832 );
  transformed.xz += uWind.xy * uWind.z * gust * position.y * position.y * tall * 0.6;
  transformed += vec3( root.x, uGrassOrigin.z + ground.r - 0.01, root.y );
  // Colour: the ground's own turf there (surfaces.ts), dark at the root, lighter and yellower at the tip.
  vec3 turf = turfAlbedo( ground.b, ground.a, textureLod( uMacro, TURF_ROT * root * 0.07, 0.0 ).r, textureLod( uMacro, root * 0.008, 0.0 ).g );
  turf *= mix( 0.95, 1.05, textureLod( uMacro, root * 0.008, 0.0 ).r );
  // As muted as the ground, where the photo's own colour still shows through.
  turf = mix( vec3( dot( turf, vec3( 0.2126, 0.7152, 0.0722 ) ) ), turf, 0.7 );
  vGrassColor = turf * mix( vec3( 0.8 ), vec3( 1.08, 1.08, 1.0 ), position.y );
  // Lit mostly like the ground under it, a little like the blade's face.
  vec3 objectNormal = normalize( vec3( -bladeDir.y * 0.15, 1.0, bladeDir.x * 0.15 ) );
`

/** The clump: three tapered blades (a quad and a tip each) at their own angles. */
function clumpGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], index: number[] = []
  // position: x across the blade (±1), y up (0–1), z the blade's own turn; uv: its offset in the clump.
  const blades: Array<[number, number, number]> = [[0, 0, 0], [2.1, 0.8, 0.5], [4.2, -0.7, 0.6]]
  for (const [turn, ox, oz] of blades) {
    const base = pos.length / 3
    for (const [x, y] of [[-1, 0], [1, 0], [-0.65, 0.55], [0.65, 0.55], [0, 1]]) {
      pos.push(x, y, turn)
      uv.push(ox, oz)
    }
    index.push(base, base + 1, base + 2, base + 1, base + 3, base + 2, base + 2, base + 3, base + 4)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  // A normal attribute keeps three's smooth shading (the shader sets the real one).
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3))
  geometry.setIndex(index)
  return geometry
}

function ring(cell: number, inner: number, outer: number): THREE.InstancedBufferGeometry {
  const offsets: number[] = []
  const n = Math.ceil(outer / cell) + 1
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
    const d = Math.hypot(i, j) * cell
    if (d <= outer + cell && d >= inner * 0.8 - cell) offsets.push(i, j)
  }
  const clump = clumpGeometry()
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.index = clump.index
  geometry.setAttribute('position', clump.getAttribute('position'))
  geometry.setAttribute('uv', clump.getAttribute('uv'))
  geometry.setAttribute('normal', clump.getAttribute('normal'))
  geometry.setAttribute('cellOffset', new THREE.InstancedBufferAttribute(new Float32Array(offsets), 2))
  geometry.instanceCount = offsets.length / 2
  // Placed in the shader around the camera: never culled.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9)
  return geometry
}

interface Ring { mesh: THREE.Mesh; uniforms: Record<string, THREE.IUniform>; cell: number }

export class GrassField {
  readonly group = new THREE.Group()
  private target: THREE.WebGLRenderTarget
  private bakeScene = new THREE.Scene()
  private bakeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 2000)
  private bakeMaterials: THREE.ShaderMaterial[] = []
  private centre: THREE.Vector3 | null = null
  private rings: Ring[] = []
  private quality: GrassQuality
  private shared = {
    uGrassMap: { value: null as THREE.Texture | null },
    uGrassOrigin: { value: new THREE.Vector3() },
    uGrassSpan: { value: 100 },
    uWind: { value: new THREE.Vector3(0.7, 0.7, 0.3) },
  }

  constructor(private renderer: THREE.WebGLRenderer, track: THREE.Object3D, quality: GrassQuality) {
    this.group.name = 'grass'
    this.quality = quality
    this.target = this.makeTarget(quality.mapSize)
    this.buildBakeScene(track)
    this.buildRings()
  }

  private makeTarget(size: number) {
    const target = new THREE.WebGLRenderTarget(size, size, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: true,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false,
    })
    target.texture.colorSpace = THREE.NoColorSpace
    this.shared.uGrassMap.value = target.texture
    return target
  }

  // Copies of the track's ground and solids (sharing their geometry) in
  // bake materials: turf from the photo, everything else no grass.
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

  private buildRings() {
    for (const ring of this.rings) { this.group.remove(ring.mesh); ring.mesh.geometry.dispose(); (ring.mesh.material as THREE.Material).dispose() }
    this.rings = []
    const q = this.quality
    for (const [cell, fadeIn, fadeOut, radius] of [
      [q.nearCellM, 0, q.nearRadiusM * 0.8, q.nearRadiusM],
      [q.farCellM, q.nearRadiusM, q.farRadiusM * 0.7, q.farRadiusM],
    ]) {
      const uniforms = {
        ...this.shared,
        uCamCell: { value: new THREE.Vector2() },
        uCell: { value: cell },
        uFadeIn: { value: fadeIn },
        uFadeOut: { value: fadeOut },
        uRadius: { value: radius },
        uTime: WORLD_UNIFORMS.uTime,
      }
      const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide })
      // Haze and the sun's shadows as the world has them; then the blade.
      patchWorldMaterial(material, 'far', f => f
        .replace('#include <common>', '#include <common>\nvarying vec3 vGrassColor;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb = vGrassColor * ( 1.0 - uWet * 0.25 );')
        // Both faces lit as the turf is: undo three's flip of the back face's normal.
        .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\n  normal *= faceDirection;\n#endif'), 'grass')
      const world = material.onBeforeCompile
      material.onBeforeCompile = (shader, renderer) => {
        world.call(material, shader, renderer)
        Object.assign(shader.uniforms, uniforms, { uMacro: WORLD_UNIFORMS.uMacro })
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${GRASS_VERTEX_PARS}\nuniform sampler2D uMacro;`)
          .replace('#include <beginnormal_vertex>', GRASS_BEGIN)
          .replace('#include <begin_vertex>', '')
      }
      const mesh = new THREE.Mesh(ring(cell, fadeIn, radius), material)
      mesh.name = 'grass-blades'
      mesh.frustumCulled = false
      mesh.receiveShadow = true
      mesh.castShadow = false
      this.group.add(mesh)
      this.rings.push({ mesh, uniforms, cell })
    }
  }

  setQuality(quality: GrassQuality) {
    if (quality === this.quality) return
    this.quality = quality
    if (this.target.width !== quality.mapSize) { this.target.dispose(); this.target = this.makeTarget(quality.mapSize) }
    this.centre = null
    this.buildRings()
  }

  /** Draw the map again before the next frame (its target is new after a lost context). */
  invalidate() { this.centre = null }

  /** Wind: where it blows towards (degrees from north) and how hard (m/s). */
  setWind(toDeg: number, mps: number) {
    const a = toDeg * Math.PI / 180
    this.shared.uWind.value.set(Math.sin(a), -Math.cos(a), Math.min(1.2, 0.15 + mps * 0.1))
  }

  /** Per frame: the rings around the camera; the map redrawn after a quarter of its width. */
  update(camera: THREE.Camera) {
    const p = camera.position
    for (const ring of this.rings) (ring.uniforms.uCamCell.value as THREE.Vector2).set(Math.floor(p.x / ring.cell), Math.floor(p.z / ring.cell))
    const span = this.quality.mapSpanM
    if (this.centre && Math.hypot(p.x - this.centre.x, p.z - this.centre.z) < span * 0.25 && Math.abs(p.y - this.centre.y) < 30) return
    // Snapped to texels so the map's samples stay on the same ground.
    const texel = span / this.quality.mapSize
    const centre = this.centre = new THREE.Vector3(Math.round(p.x / texel) * texel, p.y, Math.round(p.z / texel) * texel)
    this.bake(centre)
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
    this.shared.uGrassOrigin.value.set(centre.x, centre.z, centre.y)
    this.shared.uGrassSpan.value = span
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

  dispose() {
    this.group.removeFromParent()
    for (const ring of this.rings) { ring.mesh.geometry.dispose(); (ring.mesh.material as THREE.Material).dispose() }
    for (const m of this.bakeMaterials) m.dispose()
    this.target.dispose()
  }
}
