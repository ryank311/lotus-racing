// A minimal GeoTIFF reader for USGS elevation exports: one band of 32-bit
// floats, uncompressed, in strips or tiles, either byte order. Anything else
// is refused with a clear error rather than read wrongly. Pure JavaScript, so
// the server image needs no native libraries.

export interface FloatRaster {
  width: number
  height: number
  /** Row-major, first row = top (north). */
  data: Float32Array
  /**
   * Where the raster sits, from ModelTiepoint and ModelPixelScale: (x0, y0)
   * is the top-left corner of the top-left pixel when `pixelIsArea`, its
   * centre otherwise; x grows east by sx per pixel and y falls by sy per row.
   */
  georef: { x0: number; y0: number; sx: number; sy: number; pixelIsArea: boolean } | null
  /** GDAL's no-data value, when the file names one. */
  noData: number | null
}

const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 }

export function readFloatTiff(input: Uint8Array): FloatRaster {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const fail = (why: string): never => { throw new Error(`Unsupported elevation TIFF: ${why}`) }
  if (input.byteLength < 8) fail('the file is truncated')
  const order = String.fromCharCode(input[0], input[1])
  if (order !== 'II' && order !== 'MM') fail('not a TIFF file')
  const le = order === 'II'
  const magic = view.getUint16(2, le)
  if (magic === 43) fail('BigTIFF is not supported')
  if (magic !== 42) fail('not a TIFF file')

  const ifd = view.getUint32(4, le)
  if (ifd + 2 > input.byteLength) fail('the file is truncated')
  const count = view.getUint16(ifd, le)
  const tags = new Map<number, { type: number; count: number; at: number }>()
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > input.byteLength) fail('the file is truncated')
    const tag = view.getUint16(entry, le), type = view.getUint16(entry + 2, le), n = view.getUint32(entry + 4, le)
    const size = (TYPE_SIZE[type] ?? 0) * n
    // Values of four bytes or fewer sit in the entry itself.
    const at = size <= 4 ? entry + 8 : view.getUint32(entry + 8, le)
    if (at + size > input.byteLength) fail('the file is truncated')
    tags.set(tag, { type, count: n, at })
  }
  const values = (tag: number): number[] => {
    const t = tags.get(tag)
    if (!t) return []
    const out: number[] = []
    for (let i = 0; i < t.count; i++) {
      switch (t.type) {
        case 1: case 7: out.push(view.getUint8(t.at + i)); break
        case 3: out.push(view.getUint16(t.at + i * 2, le)); break
        case 4: out.push(view.getUint32(t.at + i * 4, le)); break
        case 11: out.push(view.getFloat32(t.at + i * 4, le)); break
        case 12: out.push(view.getFloat64(t.at + i * 8, le)); break
        default: fail(`tag ${tag} has an unexpected type`)
      }
    }
    return out
  }
  const one = (tag: number, fallback?: number): number => {
    const v = values(tag)[0]
    if (v != null) return v
    if (fallback != null) return fallback
    return fail(`tag ${tag} is missing`)
  }
  const text = (tag: number): string | null => {
    const t = tags.get(tag)
    return t && t.type === 2 ? new TextDecoder().decode(input.subarray(t.at, t.at + t.count)).replace(/\0+$/, '') : null
  }

  const width = one(256), height = one(257)
  if (!width || !height) fail('the image is empty')
  if (one(277, 1) !== 1) fail('more than one band')
  if (one(258, 1) !== 32 || one(339, 1) !== 3) fail('samples are not 32-bit floats')
  const compression = one(259, 1)
  if (compression !== 1) fail(`compression ${compression} (only uncompressed files are read)`)
  if (one(317, 1) !== 1) fail('a predictor is set')

  const data = new Float32Array(width * height)
  // Copies one block (a strip or a tile) of `bw` × `bh` pixels into place.
  const copyBlock = (offset: number, bytes: number, left: number, top: number, bw: number, bh: number) => {
    // The last strip may be short; a block must reach its last pixel in the image.
    const rows = Math.min(bh, height - top)
    const need = ((rows - 1) * bw + Math.min(bw, width - left)) * 4
    if (bytes < need || offset + need > input.byteLength) fail('a strip or tile is truncated')
    for (let y = 0; y < rows; y++) {
      const row = top + y
      for (let x = 0; x < bw && left + x < width; x++) data[row * width + left + x] = view.getFloat32(offset + (y * bw + x) * 4, le)
    }
  }
  if (tags.has(322)) {
    const tw = one(322), th = one(323)
    const offsets = values(324), counts = values(325)
    const across = Math.ceil(width / tw), down = Math.ceil(height / th)
    if (offsets.length < across * down || counts.length < across * down) fail('tiles are missing')
    for (let t = 0; t < across * down; t++) copyBlock(offsets[t], counts[t], (t % across) * tw, Math.floor(t / across) * th, tw, th)
  } else {
    const offsets = values(273), counts = values(279)
    const rows = Math.min(one(278, height), height)
    const strips = Math.ceil(height / rows)
    if (offsets.length < strips || counts.length < strips) fail('strips are missing')
    for (let s = 0; s < strips; s++) copyBlock(offsets[s], counts[s], 0, s * rows, width, rows)
  }

  // GeoTIFF placement. GTRasterTypeGeoKey (1025): 1 = pixel is area, 2 = point.
  const scale = values(33550), tie = values(33922)
  let georef: FloatRaster['georef'] = null
  if (scale.length >= 2 && tie.length >= 6 && scale[0] > 0 && scale[1] > 0) {
    const keys = values(34735)
    let pixelIsArea = true
    for (let k = 4; k + 3 < keys.length; k += 4) {
      if (keys[k] === 1025 && keys[k + 1] === 0) pixelIsArea = keys[k + 3] !== 2
    }
    // The tiepoint ties raster (i, j) to model (x, y).
    georef = { x0: tie[3] - tie[0] * scale[0], y0: tie[4] + tie[1] * scale[1], sx: scale[0], sy: scale[1], pixelIsArea }
  }
  const noDataText = text(42113)
  const noData = noDataText != null && noDataText.trim() !== '' && Number.isFinite(Number(noDataText)) ? Number(noDataText) : null
  return { width, height, data, georef, noData }
}
