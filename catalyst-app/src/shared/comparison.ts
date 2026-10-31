// Comparing your laps against other drivers on the same Catalyst server.
//
// Each driver has a private workspace and backend process. The renderer asks
// for another driver's sessions by name; the server fetches that driver's
// laps from their backend (read-only) and hands them to yours, so Analysis
// can overlay them on your own telemetry.

// Driver (account) names: 1–40 letters, numbers, spaces, dots, dashes or
// underscores. The server enforces the same rule at login.
export const DRIVER_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,39}$/u

// Limits keep one request (and the charts) readable.
export const MAX_COMPARE_DRIVERS = 4
export const MAX_COMPARE_SESSIONS = 20

export interface DriverAccount {
  username: string
  // False until that driver has synced telemetry into their workspace.
  hasTelemetry: boolean
}

// What the renderer asks for: these sessions of that driver.
export interface ComparisonRequest {
  driver: string
  sessionGuids: string[]
}

// URL form: one `compare=<driver>:<session guid>` value per session. Driver
// names cannot contain ':', so the first ':' always separates the two.
export function compareParam(driver: string, sessionGuid: string): string {
  return `${driver}:${sessionGuid}`
}

export function isCompareParam(value: string): boolean {
  const i = value.indexOf(':')
  if (i <= 0) return false
  const guid = value.slice(i + 1)
  return DRIVER_NAME_RE.test(value.slice(0, i)) && guid.length > 0 && guid.length <= 200 && !/[\s/\\:\u0000-\u001f]/.test(guid)
}

// Groups URL values by driver, keeping the first spelling of each name and
// dropping malformed entries and duplicates.
export function parseCompareParams(values: string[]): ComparisonRequest[] {
  const byDriver = new Map<string, ComparisonRequest>()
  for (const value of values) {
    if (!isCompareParam(value)) continue
    const i = value.indexOf(':')
    const driver = value.slice(0, i)
    const key = driverKey(driver)
    const request = byDriver.get(key) ?? { driver, sessionGuids: [] }
    byDriver.set(key, request)
    const guid = value.slice(i + 1)
    if (!request.sessionGuids.includes(guid)) request.sessionGuids.push(guid)
  }
  return [...byDriver.values()]
}

export function compareParams(requests: ComparisonRequest[]): string[] {
  return requests.flatMap(r => r.sessionGuids.map(guid => compareParam(r.driver, guid)))
}

// Account names are case-insensitive on the server.
export function driverKey(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase()
}
