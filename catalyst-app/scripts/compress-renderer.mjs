import { readdir, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const outputDir = fileURLToPath(new URL('../dist-renderer/', import.meta.url))
const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)
for (const name of await readdir(outputDir, { recursive: true })) {
  if (!/\.(js|css)$/.test(name)) continue
  const file = path.join(outputDir, name)
  const source = await readFile(file)
  const [br, gz] = await Promise.all([
    brotliAsync(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }),
    gzipAsync(source, { level: 9 }),
  ])
  await Promise.all([writeFile(file + '.br', br), writeFile(file + '.gz', gz)])
}
