// CLI: pull all sessions from Garmin.
// Usage: npm run fetch -- [--token <bearer>] [--list]
//
// Auth: looks at CATALYST_BEARER env, then --token, then the cached token,
// then garmin/config.json's bearer_token. For full SSO login (with MFA)
// run the Electron app — that path uses a BrowserWindow.

import { CatalystAPI, fetchAllSessions, loadCatalystToken } from '../catalystClient.js'
import { SESSIONS_DIR } from '../paths.js'
import { loadConfig } from '../config.js'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > -1 ? process.argv[i + 1] : undefined
}

async function main() {
  const cfg = loadConfig()
  const token = process.env.CATALYST_BEARER || arg('--token') || loadCatalystToken() || cfg.auth?.bearer_token
  if (!token) {
    console.error('No bearer token. Set CATALYST_BEARER, pass --token, or sign in via the GUI first.')
    process.exit(1)
  }
  const api = new CatalystAPI(token)
  api.pageSize = cfg.api?.page_size ?? 50

  if (process.argv.includes('--list')) {
    const sessions = await api.getSessions()
    console.log(`Total: ${sessions.length} sessions`)
    for (const s of sessions) {
      console.log(`${s.sessionGuid}  ${s.sessionStart ?? ''}  ${s.trackName ?? ''}  ${s.bestLap ?? ''}`)
    }
    return
  }
  await fetchAllSessions(api, SESSIONS_DIR, e => console.log(e.message))
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
