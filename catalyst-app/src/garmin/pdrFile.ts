// Read a Corvette PDR video: the MP4's metadata and its telemetry track.
// Only the boxes needed are read, so a multi-gigabyte video costs a few
// megabytes of I/O. See shared/pdr.ts for the record format.

import fs from 'node:fs/promises'

const DATA_HEAD = 0xe000
const RECORD_BYTES = 16
const TICKS_PER_S = 1e7

export interface PdrVideoInfo {
  durationS: number
  // mvhd creation time as written by the PDR: its local clock, labelled UTC.
  recordedAt: string | null
  device: string | null
  width: number | null
  height: number | null
}

export interface PdrRecords {
  // Columnar, sorted by time then file order.
  channel: Uint16Array
  timeS: Float64Array
  value: Int32Array
  // Records whose header was not 0xE000 (left out).
  skipped: number
}

export interface PdrFile extends PdrVideoInfo {
  records: PdrRecords
}

interface Box { type: string; start: number; body: number; end: number }

// Boxes between `start` and `end` of a buffer.
function children(buf: Buffer, start: number, end: number): Box[] {
  const out: Box[] = []
  let pos = start
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    let body = pos + 8
    if (size === 1) {
      if (pos + 16 > end) break
      size = Number(buf.readBigUInt64BE(pos + 8))
      body = pos + 16
    } else if (size === 0) size = end - pos
    if (size < body - pos || pos + size > end) break
    out.push({ type, start: pos, body, end: pos + size })
    pos += size
  }
  return out
}

const child = (buf: Buffer, box: Box | undefined, type: string): Box | undefined =>
  box ? children(buf, box.body, box.end).find(b => b.type === type) : undefined

function path(buf: Buffer, box: Box | undefined, ...types: string[]): Box | undefined {
  let current = box
  for (const type of types) current = child(buf, current, type)
  return current
}

// Top-level boxes, read header by header from the file.
async function topLevel(file: fs.FileHandle, size: number): Promise<Box[]> {
  const out: Box[] = []
  const header = Buffer.alloc(16)
  let pos = 0
  while (pos + 8 <= size) {
    const { bytesRead } = await file.read(header, 0, 16, pos)
    if (bytesRead < 8) break
    let boxSize = header.readUInt32BE(0)
    const type = header.toString('latin1', 4, 8)
    let body = pos + 8
    if (boxSize === 1) { boxSize = Number(header.readBigUInt64BE(8)); body = pos + 16 }
    else if (boxSize === 0) boxSize = size - pos
    if (boxSize < body - pos) throw new Error('This is not a readable MP4 file.')
    out.push({ type, start: pos, body, end: Math.min(size, pos + boxSize) })
    pos += boxSize
  }
  return out
}

// 1904-based MP4 seconds → "YYYY-MM-DD HH:MM:SS" without a timezone shift.
function mp4Time(seconds: number): string | null {
  if (!seconds) return null
  const date = new Date(Date.UTC(1904, 0, 1) + seconds * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 19).replace('T', ' ') : null
}

interface Track { handlerType: string; handlerName: string; format: string; box: Box; width: number | null; height: number | null; durationS: number | null }

// A track's own duration from its media header.
function mediaDuration(moov: Buffer, trak: Box): number | null {
  const mdhd = path(moov, trak, 'mdia', 'mdhd')
  if (!mdhd) return null
  const v1 = moov.readUInt8(mdhd.body) === 1
  const scale = moov.readUInt32BE(mdhd.body + (v1 ? 20 : 12))
  const duration = v1 ? Number(moov.readBigUInt64BE(mdhd.body + 24)) : moov.readUInt32BE(mdhd.body + 16)
  return scale ? duration / scale : null
}

function tracks(moov: Buffer, root: Box): Track[] {
  return children(moov, root.body, root.end).filter(b => b.type === 'trak').map(trak => {
    const hdlr = path(moov, trak, 'mdia', 'hdlr')
    const stsd = path(moov, trak, 'mdia', 'minf', 'stbl', 'stsd')
    const tkhd = child(moov, trak, 'tkhd')
    let handlerName = ''
    if (hdlr && hdlr.end - hdlr.body > 24) handlerName = moov.toString('utf8', hdlr.body + 24, hdlr.end).replace(/\0[\s\S]*$/, '').trim()
    let width: number | null = null, height: number | null = null
    if (tkhd && tkhd.end - tkhd.body >= 84) {
      width = Math.round(moov.readUInt32BE(tkhd.end - 8) / 65536) || null
      height = Math.round(moov.readUInt32BE(tkhd.end - 4) / 65536) || null
    }
    return {
      handlerType: hdlr ? moov.toString('latin1', hdlr.body + 8, hdlr.body + 12) : '',
      handlerName,
      format: stsd && stsd.end - stsd.body >= 16 ? moov.toString('latin1', stsd.body + 12, stsd.body + 16) : '',
      box: trak, width, height, durationS: mediaDuration(moov, trak),
    }
  })
}

// File offset and size of every sample in a track.
function sampleTable(moov: Buffer, trak: Box): Array<{ offset: number; size: number }> {
  const stbl = path(moov, trak, 'mdia', 'minf', 'stbl')
  const stsz = child(moov, stbl, 'stsz'), stsc = child(moov, stbl, 'stsc')
  const stco = child(moov, stbl, 'stco'), co64 = child(moov, stbl, 'co64')
  if (!stsz || !stsc || (!stco && !co64)) throw new Error('The PDR telemetry track has no sample table.')
  const fixed = moov.readUInt32BE(stsz.body + 4), count = moov.readUInt32BE(stsz.body + 8)
  const sizes = Array.from({ length: count }, (_, i) => fixed || moov.readUInt32BE(stsz.body + 12 + i * 4))
  const chunks: number[] = []
  if (co64) for (let i = 0, n = moov.readUInt32BE(co64.body + 4); i < n; i++) chunks.push(Number(moov.readBigUInt64BE(co64.body + 8 + i * 8)))
  else for (let i = 0, n = moov.readUInt32BE(stco!.body + 4); i < n; i++) chunks.push(moov.readUInt32BE(stco!.body + 8 + i * 4))
  const runs: Array<{ first: number; perChunk: number }> = []
  for (let i = 0, n = moov.readUInt32BE(stsc.body + 4); i < n; i++) {
    runs.push({ first: moov.readUInt32BE(stsc.body + 8 + i * 12), perChunk: moov.readUInt32BE(stsc.body + 12 + i * 12) })
  }
  const out: Array<{ offset: number; size: number }> = []
  let sample = 0
  for (let c = 0; c < chunks.length && sample < count; c++) {
    const run = [...runs].reverse().find(r => r.first <= c + 1)
    let offset = chunks[c]
    for (let k = 0; k < (run?.perChunk ?? 1) && sample < count; k++, sample++) {
      out.push({ offset, size: sizes[sample] })
      offset += sizes[sample]
    }
  }
  return out
}

export function isPdrTrack(t: { handlerName: string; format: string }): boolean {
  return t.format === 'marl' || /\bPDR\b/i.test(t.handlerName)
}

/** Decode concatenated 16-byte telemetry records. */
export function decodeRecords(chunks: Buffer[]): PdrRecords {
  const total = chunks.reduce((n, b) => n + Math.floor(b.length / RECORD_BYTES), 0)
  const channel = new Uint16Array(total), timeS = new Float64Array(total), value = new Int32Array(total)
  let n = 0, skipped = 0
  for (const buf of chunks) {
    for (let pos = 0; pos + RECORD_BYTES <= buf.length; pos += RECORD_BYTES) {
      if (buf.readUInt16BE(pos) !== DATA_HEAD) { skipped++; continue }
      channel[n] = buf.readUInt16BE(pos + 2)
      value[n] = buf.readInt32BE(pos + 4)
      timeS[n] = (buf.readUInt32BE(pos + 8) * 2 ** 32 + buf.readUInt32BE(pos + 12)) / TICKS_PER_S
      n++
    }
  }
  // Each sample holds about two seconds of records, mostly in time order.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => timeS[a] - timeS[b] || a - b)
  return {
    channel: Uint16Array.from(order, i => channel[i]),
    timeS: Float64Array.from(order, i => timeS[i]),
    value: Int32Array.from(order, i => value[i]),
    skipped,
  }
}

interface Movie { moov: Buffer; durationS: number; recordedAt: string | null; tracks: Track[]; video: Track | undefined }

// The movie header (moov) of an open MP4: duration, creation time, tracks.
async function readMovie(file: fs.FileHandle, size: number): Promise<Movie> {
  const moovBox = (await topLevel(file, size)).find(b => b.type === 'moov')
  if (!moovBox) throw new Error('This is not a readable MP4 file (no movie header).')
  if (moovBox.end - moovBox.start > 256 * 1024 ** 2) throw new Error('The MP4 movie header is too large.')
  const moov = Buffer.alloc(moovBox.end - moovBox.start)
  await file.read(moov, 0, moov.length, moovBox.start)
  const root: Box = { type: 'moov', start: 0, body: moovBox.body - moovBox.start, end: moov.length }

  const mvhd = child(moov, root, 'mvhd')
  let durationS = 0, recordedAt: string | null = null
  if (mvhd) {
    const v1 = moov.readUInt8(mvhd.body) === 1
    const created = v1 ? Number(moov.readBigUInt64BE(mvhd.body + 4)) : moov.readUInt32BE(mvhd.body + 4)
    const scale = moov.readUInt32BE(mvhd.body + (v1 ? 20 : 12))
    const duration = v1 ? Number(moov.readBigUInt64BE(mvhd.body + 24)) : moov.readUInt32BE(mvhd.body + 16)
    durationS = scale ? duration / scale : 0
    recordedAt = mp4Time(created)
  }
  const all = tracks(moov, root)
  const video = all.filter(t => t.handlerType === 'vide' && t.format === 'avc1')
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0]
  return { moov, durationS, recordedAt, tracks: all, video }
}

/** Any MP4's duration, creation time and picture size (no telemetry needed). */
export async function readVideoInfo(filePath: string): Promise<PdrVideoInfo> {
  const file = await fs.open(filePath, 'r')
  try {
    const movie = await readMovie(file, (await file.stat()).size)
    const durationS = movie.video?.durationS ?? movie.durationS
    if (!(durationS > 0)) throw new Error('This video has no length; it may still be recording or be damaged.')
    return { durationS, recordedAt: movie.recordedAt, device: null, width: movie.video?.width ?? null, height: movie.video?.height ?? null }
  } finally {
    await file.close()
  }
}

/** The video's metadata and telemetry. Throws when the file is not a PDR video. */
export async function readPdrFile(filePath: string): Promise<PdrFile> {
  const file = await fs.open(filePath, 'r')
  try {
    const { size } = await file.stat()
    const { moov, durationS, recordedAt, tracks: all, video } = await readMovie(file, size)
    const data = all.find(isPdrTrack)
    if (!data) throw new Error('This video has no PDR telemetry track. Use the MP4 files from the PDR’s SD card or USB drive, as recorded.')

    const chunks: Buffer[] = []
    for (const { offset, size: bytes } of sampleTable(moov, data.box)) {
      if (!bytes || offset + bytes > size) continue
      const buf = Buffer.alloc(bytes)
      await file.read(buf, 0, bytes, offset)
      chunks.push(buf)
    }
    return {
      durationS: video?.durationS ?? durationS, recordedAt, device: data.handlerName || null,
      width: video?.width ?? null, height: video?.height ?? null,
      records: decodeRecords(chunks),
    }
  } finally {
    await file.close()
  }
}

/** One channel's samples in time order, in raw units. */
export interface RawSeries { t: Float64Array; v: Int32Array }

export function channelSeries(records: PdrRecords): Map<number, RawSeries> {
  const counts = new Map<number, number>()
  for (const c of records.channel) counts.set(c, (counts.get(c) ?? 0) + 1)
  const out = new Map<number, RawSeries & { n: number }>()
  for (const [c, n] of counts) out.set(c, { t: new Float64Array(n), v: new Int32Array(n), n: 0 })
  for (let i = 0; i < records.channel.length; i++) {
    const s = out.get(records.channel[i])!
    s.t[s.n] = records.timeS[i]; s.v[s.n] = records.value[i]; s.n++
  }
  return new Map([...out].map(([c, s]) => [c, { t: s.t, v: s.v }]))
}
