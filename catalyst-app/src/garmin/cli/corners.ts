// CLI: detect corners on a meanline.
// Usage: npm run corners -- <meanline.pb> [--out <path>]

import { detectCornersFromFile } from '../detectCorners.js'

async function main() {
  const args = process.argv.slice(2)
  const inputArg = args.find(a => !a.startsWith('--'))
  if (!inputArg) {
    console.error('Usage: corners <meanline.pb> [--out path]')
    process.exit(1)
  }
  const outIdx = args.indexOf('--out')
  const out = outIdx > -1 ? args[outIdx + 1] : undefined
  detectCornersFromFile(inputArg, out)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
