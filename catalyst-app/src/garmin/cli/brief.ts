// CLI: generate a coaching brief.

import { runBrief } from '../promptPack.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > -1 ? process.argv[i + 1] : undefined
}
function flag(name: string): boolean {
  return process.argv.includes(name)
}

async function main() {
  const lastNStr = arg('--last')
  const all = flag('--all')
  const sessions: string[] = []
  let i = 0
  while ((i = process.argv.indexOf('--session', i + 1)) > -1) sessions.push(process.argv[i + 1])

  const result = await runBrief({
    scope: (arg('--scope') as any) ?? 'overview',
    profile: arg('--profile'),
    mode: sessions.length ? 'selected' : all ? 'all' : 'last',
    lastN: lastNStr ? parseInt(lastNStr, 10) : 5,
    sessionGuids: sessions.length ? sessions : undefined,
    csv: flag('--csv'),
    includeGuides: flag('--include-guides'),
    outPath: arg('--output'),
  })
  console.log(`[ok] wrote ${result.outPath} for ${result.sessions} session(s)`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
