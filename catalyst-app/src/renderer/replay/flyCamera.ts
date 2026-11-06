// A free camera for looking over the track (the replay's debug "fly"
// view): W A S D move along the view, E and Q rise and sink, Shift is
// faster and Alt slower, the wheel sets the speed. A click on the view
// locks the pointer so the mouse turns the head (Esc lets it go); without
// pointer lock (a touch screen), a drag turns it. The lap plays on below.

import * as THREE from 'three'

const KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight'])
const SPEED: [number, number] = [2, 400]
const PITCH = Math.PI / 2 - 0.01
const euler = new THREE.Euler(0, 0, 0, 'YXZ')
const forward = new THREE.Vector3(), right = new THREE.Vector3(), move = new THREE.Vector3()

export class FlyCamera {
  private keys = new Set<string>()
  private yaw = 0
  private pitch = 0
  private drag: { id: number; x: number; y: number } | null = null
  /** Metres a second at the plain pace. */
  speed = 25

  constructor(private camera: THREE.PerspectiveCamera, private element: HTMLElement, private onSpeed?: (speed: number) => void) {
    euler.setFromQuaternion(camera.quaternion, 'YXZ')
    this.yaw = euler.y; this.pitch = euler.x
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    element.addEventListener('pointerdown', this.onPointerDown)
    element.addEventListener('pointermove', this.onPointerMove)
    element.addEventListener('pointerup', this.onPointerUp)
    element.addEventListener('pointercancel', this.onPointerUp)
    element.addEventListener('wheel', this.onWheel, { passive: false })
    document.addEventListener('mousemove', this.onMouseMove)
    element.classList.add('flying')
  }

  /** Moves the camera for this frame. */
  update(dt: number) {
    const k = this.keys
    const fast = k.has('ShiftLeft') || k.has('ShiftRight'), slow = k.has('AltLeft') || k.has('AltRight')
    const pace = this.speed * (fast ? 4 : 1) * (slow ? 0.2 : 1) * Math.min(dt, 0.1)
    // Forward along the view (pitch included: noclip); sideways level.
    forward.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch))
    right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    move.set(0, 0, 0)
    if (k.has('KeyW')) move.add(forward)
    if (k.has('KeyS')) move.sub(forward)
    if (k.has('KeyD')) move.add(right)
    if (k.has('KeyA')) move.sub(right)
    if (k.has('KeyE')) move.y += 1
    if (k.has('KeyQ')) move.y -= 1
    if (move.lengthSq() > 0) this.camera.position.addScaledVector(move.normalize(), pace)
    euler.set(this.pitch, this.yaw, 0, 'YXZ')
    this.camera.quaternion.setFromEuler(euler)
  }

  dispose() {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.element.removeEventListener('pointerdown', this.onPointerDown)
    this.element.removeEventListener('pointermove', this.onPointerMove)
    this.element.removeEventListener('pointerup', this.onPointerUp)
    this.element.removeEventListener('pointercancel', this.onPointerUp)
    this.element.removeEventListener('wheel', this.onWheel)
    document.removeEventListener('mousemove', this.onMouseMove)
    this.element.classList.remove('flying')
    if (document.pointerLockElement === this.element) document.exitPointerLock()
  }

  private turn(dx: number, dy: number, perPx: number) {
    this.yaw -= dx * perPx
    this.pitch = Math.max(-PITCH, Math.min(PITCH, this.pitch - dy * perPx))
  }

  private typing(event: Event): boolean {
    return event.target instanceof Element && !!event.target.closest('input, select, textarea, [contenteditable="true"]')
  }

  private onKeyDown = (event: KeyboardEvent) => {
    if (!KEYS.has(event.code) || event.metaKey || event.ctrlKey || this.typing(event)) return
    this.keys.add(event.code)
    // Alt alone would open the window menu on some systems.
    if (event.code.startsWith('Alt') || event.code.startsWith('Key')) event.preventDefault()
  }

  private onKeyUp = (event: KeyboardEvent) => { this.keys.delete(event.code) }
  private onBlur = () => { this.keys.clear() }

  private onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button === 0 && this.element.requestPointerLock && document.pointerLockElement !== this.element) {
      try { void (this.element.requestPointerLock() as unknown as Promise<void> | undefined)?.catch?.(() => {}) } catch { /* not allowed here */ }
      event.preventDefault()
      return
    }
    if (event.pointerType !== 'mouse' || document.pointerLockElement !== this.element) {
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY }
      try { this.element.setPointerCapture(event.pointerId) } catch { /* gone */ }
    }
  }

  private onPointerMove = (event: PointerEvent) => {
    const drag = this.drag
    if (!drag || drag.id !== event.pointerId) return
    this.turn(event.clientX - drag.x, event.clientY - drag.y, Math.PI / Math.max(320, this.element.clientWidth))
    drag.x = event.clientX; drag.y = event.clientY
  }

  private onPointerUp = (event: PointerEvent) => { if (this.drag?.id === event.pointerId) this.drag = null }

  private onMouseMove = (event: MouseEvent) => {
    if (document.pointerLockElement === this.element) this.turn(event.movementX, event.movementY, 0.0022)
  }

  private onWheel = (event: WheelEvent) => {
    event.preventDefault()
    this.speed = Math.max(SPEED[0], Math.min(SPEED[1], this.speed * Math.exp(-event.deltaY * 0.0015)))
    this.onSpeed?.(this.speed)
  }
}
