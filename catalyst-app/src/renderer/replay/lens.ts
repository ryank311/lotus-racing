// The Garmin Catalyst's windscreen camera: a very wide lens with visible
// barrel distortion. The scene is drawn through a wider rectilinear camera
// into a texture, then remapped: each output pixel at angle θ from the lens
// axis takes the input pixel at tan θ. θ grows with the distance from the
// centre between rectilinear (k = 0) and equidistant fisheye (k = 1).

import * as THREE from 'three'


export interface LensSettings {
  /** Output field of view across the frame, degrees. */
  horizontalFovDeg: number
  /** 0 = rectilinear, 1 = equidistant fisheye. */
  barrel: number
}

const vertexShader = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`
const fragmentShader = /* glsl */`
uniform sampler2D tScene;
uniform float aspect;   // width / height of the output
uniform float tanHalf;  // tan(half horizontal FOV of the output's rectilinear part)
uniform float halfFov;  // half horizontal FOV of the output, radians
uniform float barrel;
uniform float tanIn;    // tan(half horizontal FOV of the rendered scene)
varying vec2 vUv;
void main() {
  // Output position in units of the half width.
  vec2 p = (vUv - 0.5) * 2.0;
  p.y /= aspect;
  float r = length(p);
  float theta = mix(atan(r * tanHalf), r * halfFov, barrel);
  vec2 q = r > 1e-6 ? p / r * (tan(theta) / tanIn) : vec2(0.0);
  q.y *= aspect;
  vec2 uv = q * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  gl_FragColor = texture2D(tScene, uv);
  #include <colorspace_fragment>
}
`

export class LensPass {
  private target: THREE.WebGLRenderTarget
  private quad: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>
  private screen = new THREE.Scene()
  private screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  /** The rectilinear camera the scene is drawn with (wider than the lens). */
  readonly inner = new THREE.PerspectiveCamera()

  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, depthBuffer: true, type: THREE.HalfFloatType })
    // three applies each material's own tone mapping only when drawing to
    // the screen or to an XR target. Marking this one as such keeps the world
    // (not tone-mapped) and the car (tone-mapped) as in the other views. It
    // stays linear (half float); the pass below encodes to sRGB.
    ;(this.target as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget = true
    this.target.texture.colorSpace = THREE.LinearSRGBColorSpace
    const material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader, depthTest: false, depthWrite: false, toneMapped: false,
      uniforms: { tScene: { value: this.target.texture }, aspect: { value: 16 / 9 }, tanHalf: { value: 1 }, halfFov: { value: 1 }, barrel: { value: 0.5 }, tanIn: { value: 1 } },
    })
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material)
    this.quad.frustumCulled = false
    this.screen.add(this.quad)
  }

  private oversize = 1.1

  /** Drawn size against the screen's and multisampling: less for slower graphics. */
  setQuality(oversize: number, samples: number) {
    this.oversize = oversize
    if (this.target.samples !== samples) { this.target.dispose(); this.target.samples = samples }
  }

  /**
   * Point the inner camera like `view` and widen it to cover the lens's
   * corners (with a little margin).
   */
  configure(view: THREE.PerspectiveCamera, aspect: number, lens: LensSettings) {
    const halfFov = THREE.MathUtils.degToRad(lens.horizontalFovDeg / 2)
    const u = this.quad.material.uniforms
    u.aspect.value = aspect
    u.halfFov.value = halfFov
    u.tanHalf.value = Math.tan(halfFov)
    u.barrel.value = lens.barrel
    const corner = Math.hypot(1, 1 / aspect)
    const cornerTheta = Math.min(THREE.MathUtils.degToRad(80), (1 - lens.barrel) * Math.atan(corner * Math.tan(halfFov)) + lens.barrel * corner * halfFov)
    const tanIn = Math.tan(cornerTheta) / corner * 1.01
    u.tanIn.value = tanIn
    const inner = this.inner
    inner.position.copy(view.position)
    inner.quaternion.copy(view.quaternion)
    inner.aspect = aspect
    inner.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanIn / aspect))
    inner.near = view.near
    inner.far = view.far
    inner.updateProjectionMatrix()
    inner.updateMatrixWorld()
  }

  /**
   * Compile the programs of `object` (default: the whole scene) in `scene`
   * for this pass without drawing (and the pass's own), in parallel where the
   * browser can. three keys a material's program on the colour space of the
   * target it draws into, and this one's is linear: the screen's programs do
   * not serve it, so the first frame through the lens would compile every
   * material again while the page waits.
   */
  compile(renderer: THREE.WebGLRenderer, scene: THREE.Scene, object: THREE.Object3D = scene): Promise<unknown> {
    const before = renderer.getRenderTarget()
    let programs: Promise<unknown>
    renderer.setRenderTarget(this.target)
    try { programs = renderer.compileAsync(object, this.inner, scene) } finally { renderer.setRenderTarget(before) }
    return Promise.all([programs, renderer.compileAsync(this.screen, this.screenCamera)])
  }

  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2())
    // A little over the screen's resolution: the lens magnifies the middle
    // (by about 1.6 at 120°, so 1.1 × leaves it 1.45: soft, as the camera is).
    const w = Math.round(size.x * this.oversize), h = Math.round(size.y * this.oversize)
    if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h)
    renderer.setRenderTarget(this.target)
    renderer.render(scene, this.inner)
    renderer.setRenderTarget(null)
    renderer.render(this.screen, this.screenCamera)
  }

  dispose() {
    this.target.dispose()
    this.quad.geometry.dispose()
    this.quad.material.dispose()
  }
}
