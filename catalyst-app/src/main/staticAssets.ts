import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

function mimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.ico': return 'image/x-icon'
    case '.woff2': return 'font/woff2'
    case '.wasm': return 'application/wasm'
    default: return 'application/octet-stream'
  }
}

function isFile(filePath: string): boolean {
  try { return fs.statSync(filePath).isFile() } catch { return false }
}

/** The q-value an Accept-Encoding header gives each content coding (0: not acceptable). */
export function encodingQuality(header: string | undefined): (encoding: string) => number {
  const weights = new Map<string, number>()
  for (const part of (header ?? '').split(',')) {
    const [name, ...parameters] = part.trim().toLowerCase().split(';')
    if (!name) continue
    const quality = parameters.map(p => p.trim()).find(p => p.startsWith('q='))?.slice(2)
    const value = quality === undefined ? 1 : Number(quality)
    weights.set(name, Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0)
  }
  return encoding => weights.get(encoding) ?? (encoding === 'identity'
    ? (weights.get('*') === 0 ? 0 : 1)
    : (weights.get('*') ?? 0))
}

// ─── Precompressed model files ──────────────────────────────────────────────

export interface Precompressed {
  path: string
  encoding: 'br' | 'gzip'
  size: number
}

const MTIME_SLACK_MS = 2000

/** Stats of a file, or null. */
function statOf(file: string): fs.Stats | null {
  try { return fs.statSync(file) } catch { return null }
}

/** The uncompressed length a .gz records in its trailer (mod 2³²), or null. */
function gzipLength(file: string, size: number): number | null {
  if (size < 18) return null
  let handle: number | null = null
  try {
    handle = fs.openSync(file, 'r')
    const tail = Buffer.alloc(4)
    fs.readSync(handle, tail, 0, 4, size - 4)
    return tail.readUInt32LE(0)
  } catch {
    return null
  } finally {
    if (handle != null) fs.closeSync(handle)
  }
}

/**
 * A sidecar of `file` (<file>.br or <file>.gz, written offline by
 * scripts/compress-models.mjs) that is current: at least as new as the file
 * and, for the .gz, recording the file's length. The .br is written with
 * the .gz, so a .gz that no longer matches retires both (a file put back
 * with its old mtime is then served as it is).
 */
export function freshSidecar(file: string, encoding: 'br' | 'gzip', source: fs.Stats | null = statOf(file)): Precompressed | null {
  if (!source?.isFile()) return null
  // Within MTIME_SLACK_MS: a stamp copied through a Date (utimes) loses the
  // sub-millisecond part, and some filesystems keep 2-second times.
  const fresh = (candidate: string): fs.Stats | null => {
    const stat = statOf(candidate)
    return stat?.isFile() && stat.mtimeMs >= source.mtimeMs - MTIME_SLACK_MS ? stat : null
  }
  const gzPath = `${file}.gz`
  const gz = fresh(gzPath)
  const gzOk = !!gz && gzipLength(gzPath, gz.size) === source.size % 2 ** 32
  if (encoding === 'gzip') return gzOk ? { path: gzPath, encoding, size: gz!.size } : null
  const brPath = `${file}.br`
  const br = fresh(brPath)
  if (!br || (fs.existsSync(gzPath) && !gzOk)) return null
  return { path: brPath, encoding, size: br.size }
}

/**
 * The precompressed copy of `file` to send for this Accept-Encoding: the
 * most preferred current sidecar, brotli before gzip when both are
 * acceptable; null when none is (the file is then sent as it is).
 */
export function precompressedSidecar(file: string, acceptEncoding: string | string[] | undefined): Precompressed | null {
  const quality = encodingQuality(Array.isArray(acceptEncoding) ? acceptEncoding.join(',') : acceptEncoding)
  const source = statOf(file)
  const candidates = (['br', 'gzip'] as const)
    .filter(encoding => quality(encoding) > 0)
    .map(encoding => ({ q: quality(encoding), sidecar: freshSidecar(file, encoding, source) }))
    .filter((c): c is { q: number; sidecar: Precompressed } => !!c.sidecar)
  // A stable sort keeps brotli first among equals.
  candidates.sort((a, b) => b.q - a.q)
  return candidates[0]?.sidecar ?? null
}

/** Serve original assets or precompressed siblings without touching API/SSE responses. */
export function serveStaticAsset(req: IncomingMessage, res: ServerResponse, staticDir: string, pathname: string): void {
  const fail = (status: number, message: string) => {
    res.writeHead(status, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': Buffer.byteLength(message),
      'Cache-Control': 'no-cache',
    })
    res.end(req.method === 'HEAD' ? undefined : message)
  }
  const decoded = decodeURIComponent(pathname)
  if (decoded.includes('\0')) { fail(400, 'Invalid asset path'); return }
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  let filePath = path.resolve(staticDir, relative)
  if (!filePath.startsWith(staticDir + path.sep)) { fail(404, 'Not found'); return }
  if (!isFile(filePath)) {
    // Missing scripts/styles must not masquerade as HTML, especially after an
    // update when an already-open page requests a previous build's lazy chunk.
    if (/^(?:assets|api)(?:\/|$)/.test(relative) || path.extname(relative)) {
      fail(404, 'Not found'); return
    }
    filePath = path.join(staticDir, 'index.html')
  }

  const quality = encodingQuality(req.headers['accept-encoding'])
  const compressible = /\.(js|css|wasm)$/.test(filePath)
  const candidates = [
    ...(compressible ? [{ encoding: 'br', file: filePath + '.br' }, { encoding: 'gzip', file: filePath + '.gz' }] : []),
    { encoding: 'identity', file: filePath },
  ].filter(candidate => quality(candidate.encoding) > 0 && isFile(candidate.file))
    .sort((a, b) => quality(b.encoding) - quality(a.encoding))
  const selected = candidates[0]
  // Encoding negotiation also affects a 406 response and identity fallbacks.
  res.setHeader('Vary', 'Accept-Encoding')
  if (!selected) { fail(406, 'No acceptable asset encoding'); return }
  const isHtml = path.extname(filePath) === '.html'
  const hashed = /^assets\/.+-[\w-]{8,}\.[^/]+$/.test(path.relative(staticDir, filePath).split(path.sep).join('/'))
  res.writeHead(200, {
    'Content-Type': mimeType(filePath),
    'Content-Length': fs.statSync(selected.file).size,
    'Cache-Control': isHtml ? 'no-cache' : hashed ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
    ...(selected.encoding !== 'identity' ? { 'Content-Encoding': selected.encoding } : {}),
  })
  if (req.method === 'HEAD') res.end()
  else fs.createReadStream(selected.file).on('error', error => res.destroy(error)).pipe(res)
}
