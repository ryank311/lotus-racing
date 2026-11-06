// The grass field's layout (src/renderer/replay/grassTiles.ts): density by
// distance, tiers that always hold the blades that stand at their distance,
// a blade layout with no lattice whose every prefix is spread evenly, and
// the tiles chosen for a view (in the frustum, by tier, none without turf).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { bladeLayout, fieldRadius, GRASS_QUALITY, GrassTiles, grassDensity, REFERENCE_PIXEL_ANGLE, tierAt, tierCapacities, type TileMask } from '../src/renderer/replay/grassTiles'

const high = GRASS_QUALITY.high!, medium = GRASS_QUALITY.medium!

test('Low has no blades; High reaches further and stands denser than Medium', () => {
  assert.equal(GRASS_QUALITY.low, null)
  assert.ok(fieldRadius(high) > fieldRadius(medium))
  assert.ok(high.densityNear > medium.densityNear)
  // Tiers nearest first; the last one's reach is the field's edge, after it starts thinning.
  for (const q of [high, medium]) {
    q.tiers.forEach((t, i) => i && assert.ok(t.reachM > q.tiers[i - 1].reachM))
    assert.ok(q.fadeFromM < fieldRadius(q))
  }
})

test('density falls with distance, as blades widen to a pixel, and is gone at the edge', () => {
  let last = Infinity
  for (let d = 0.5; d <= fieldRadius(high); d += 0.5) {
    const n = grassDensity(high, d, REFERENCE_PIXEL_ANGLE)
    assert.ok(n <= last + 1e-9, `${d} m`)
    last = n
  }
  assert.equal(grassDensity(high, high.nearM), high.densityNear)
  assert.equal(grassDensity(high, fieldRadius(high)), 0)
  // A sharper screen (smaller pixels) keeps more of them.
  assert.ok(grassDensity(high, 30, 0.0005) > grassDensity(high, 30, 0.001))
})

test('each tier holds every blade that stands at its nearest distance (at the reference pixel)', () => {
  for (const q of [high, medium]) {
    const caps = tierCapacities(q)
    const area = q.tileM * q.tileM
    caps.forEach((c, i) => {
      if (i) assert.ok(c <= caps[i - 1], 'a prefix of the tier before')
      const from = i ? q.tiers[i - 1].reachM : 0.1
      assert.ok(c >= grassDensity(q, from, REFERENCE_PIXEL_ANGLE) * area - 1e-6)
    })
    // Few enough vertices a tile for 16-bit indices on the near tier (seven a blade).
    assert.ok(caps[0] * 7 < 65536)
  }
})

test('tiers by distance, and none past the edge', () => {
  assert.equal(tierAt(high, 0), 0)
  assert.equal(tierAt(high, high.tiers[0].reachM), 1)
  assert.equal(tierAt(high, fieldRadius(high) - 0.01), high.tiers.length - 1)
  assert.equal(tierAt(high, fieldRadius(high)), -1)
})

test('the blade layout is blue noise: every prefix spread evenly, wrapping at the edges', () => {
  const n = 2000
  const layout = bladeLayout(n)
  assert.equal(layout.length, n * 2)
  for (const v of layout) assert.ok(v >= 0 && v < 1)
  assert.equal(bladeLayout(n), layout, 'cached')
  const spacing = (k: number) => {
    let min = Infinity, sum = 0
    for (let i = 0; i < k; i++) {
      let m = Infinity
      for (let j = 0; j < k; j++) {
        if (i === j) continue
        let dx = layout[i * 2] - layout[j * 2], dy = layout[i * 2 + 1] - layout[j * 2 + 1]
        dx -= Math.round(dx); dy -= Math.round(dy)
        m = Math.min(m, Math.hypot(dx, dy))
      }
      min = Math.min(min, m)
      sum += m
    }
    return { min: min * Math.sqrt(k), mean: sum / k * Math.sqrt(k) }
  }
  // Uniform random points: mean nearest-neighbour 0.5 / √k, and some nearly touching.
  for (const k of [40, 400, n]) {
    const s = spacing(k)
    assert.ok(s.mean > 0.7, `${k}: mean ${s.mean}`)
    assert.ok(s.min > 0.25, `${k}: min ${s.min}`)
  }
})

test('no lattice: the points do not fall into rows along any direction', () => {
  const n = 1500
  const layout = bladeLayout(n)
  // Project on many directions: a lattice (R2, a grid) piles points into
  // a few narrow bands for some direction; blue noise spreads them evenly.
  let worst = 0
  for (let a = 0; a < 180; a += 1) {
    const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180)
    const bins = new Array(150).fill(0)
    for (let i = 0; i < n; i++) {
      const p = layout[i * 2] * c + layout[i * 2 + 1] * s
      bins[Math.floor((p - Math.floor(p)) * bins.length)]++
    }
    const mean = n / bins.length
    const variance = bins.reduce((v, b) => v + (b - mean) ** 2, 0) / bins.length
    worst = Math.max(worst, variance / mean)
  }
  // Poisson counts have variance ≈ mean (this layout: 1.4); rows give far more (the R2 sequence: 3.6).
  assert.ok(worst < 2, `worst ${worst}`)
})

function camera(at: THREE.Vector3, look: THREE.Vector3) {
  const c = new THREE.PerspectiveCamera(60, 2, 0.1, 5000)
  c.position.copy(at)
  c.lookAt(look)
  c.updateMatrixWorld()
  return c
}

test('tiles: in front of the camera, nearest first, by tier; none behind it', () => {
  const tiles = new GrassTiles(high)
  const cam = camera(new THREE.Vector3(0.5, 2, 0.5), new THREE.Vector3(0.5, 0, -20))
  assert.equal(tiles.select(cam, 0), true)
  const all: Array<[number, number, number]> = []
  tiles.counts.forEach((n, tier) => {
    for (let k = 0; k < n; k++) all.push([tiles.tiles[tier][k * 2], tiles.tiles[tier][k * 2 + 1], tier])
  })
  assert.ok(all.length > 100)
  for (const [i, j, tier] of all) {
    // Looking towards -z: nothing well behind the camera.
    assert.ok(j * high.tileM < 3, `tile ${i}, ${j}`)
    // At the tier its nearest point's distance gives.
    const s = high.tileM, dx = Math.max(i * s - 0.5, 0, 0.5 - i * s - s), dz = Math.max(j * s - 0.5, 0, 0.5 - j * s - s)
    assert.equal(tier, tierAt(high, Math.hypot(dx, dz)))
  }
  // The same view again: nothing to do.
  assert.equal(tiles.select(cam, 0), false)
})

test('tiles: the mask drops tiles without turf and sets their height', () => {
  const tiles = new GrassTiles(high)
  const cam = camera(new THREE.Vector3(0.5, 2, 0.5), new THREE.Vector3(0.5, 0, -20))
  tiles.select(cam, 0)
  const without = tiles.counts.reduce((a, b) => a + b, 0)
  // Turf only where x < 0 (tiles i < 0); the rest tarmac.
  const size = 80, i0 = -40, j0 = -40
  const data = new Float32Array(size * size * 4)
  for (let b = 0; b < size; b++) for (let a = 0; a < size; a++) {
    const m = (b * size + a) * 4
    data[m] = a + i0 < 0 ? 1 : 0
    data[m + 1] = 0
    data[m + 2] = 0.1
  }
  const mask: TileMask = { i0, j0, size, data }
  assert.equal(tiles.select(cam, 0, mask), true, 'a new mask is a new choice')
  const kept = tiles.counts.reduce((a, b) => a + b, 0)
  assert.ok(kept > 0 && kept < without * 0.7, `${kept} of ${without}`)
  tiles.counts.forEach((n, tier) => { for (let k = 0; k < n; k++) assert.ok(tiles.tiles[tier][k * 2] < 0) })
  // Turf far below the view (a valley 60 m down, the camera looking level): none.
  for (let m = 0; m < data.length; m += 4) { data[m] = 1; data[m + 1] = -60; data[m + 2] = -59.9 }
  const level = camera(new THREE.Vector3(0.5, 2, 0.5), new THREE.Vector3(0.5, 2, -20))
  tiles.select(level, 0, { ...mask })
  const near = tiles.counts.slice(0, 3).reduce((a, b) => a + b, 0)
  assert.equal(near, 0)
})
