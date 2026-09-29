// Focus tracking and the Overview dashboard: what the coach last asked each
// driver to work on, and whether later sessions show it working.

import type { DuckDBConnection } from '@duckdb/node-api'
import type { DashboardLayout, FocusCheck, FocusItem, FocusStatus } from '../shared/types.js'
import type { UnitSystem } from '../shared/units.js'
import { checkFocus, fetchSessionMeta, latestFocus, vehicleLabelOf } from './coachPacket.js'
import type { LapSeries } from './lapPhases.js'
import { fetchLapSeries, fetchOptimalLapTimes, fetchValidLaps, lapLabel, representativeKeys, shortSessionLabel, validLapPredicate } from './lapData.js'

export type { DashboardLayout, FocusStatus }

async function rows(con: DuckDBConnection, sql: string, params: unknown[] = []): Promise<any[]> {
  return (await con.runAndReadAll(sql, params as any)).getRowObjectsJson() as any[]
}

async function reportTitle(con: DuckDBConnection, id: string): Promise<string> {
  return String((await rows(con, 'SELECT title FROM coaching_sessions WHERE id = ?', [id]))[0]?.title ?? 'Coaching report')
}

async function checkOnSessions(con: DuckDBConnection, items: FocusItem[], sessionGuids: string[], reportId: string, createdAt: string, system: UnitSystem): Promise<FocusCheck[]> {
  const laps = await fetchValidLaps(con, sessionGuids)
  if (!laps.length) return []
  const rep = representativeKeys(laps)
  const measured: Array<{ series: LapSeries; representative: boolean; label: string }> = []
  for (const lap of laps) {
    measured.push({ series: await fetchLapSeries(con, lap.sg, lap.lapIndex), representative: rep.has(`${lap.sg}:${lap.lapIndex}`), label: lapLabel(lap.sessionStart, lap.lapIndex) })
  }
  return items.map(item => checkFocus(item, measured, reportId, createdAt, system))
}

// The focus that applied going into this session, checked on its laps.
export async function focusForSession(con: DuckDBConnection, sessionGuid: string, system: UnitSystem): Promise<FocusStatus | null> {
  const [meta] = await fetchSessionMeta(con, [sessionGuid])
  if (!meta) return null
  const stored = await latestFocus(con, { vehicleGuid: meta.vehicle_guid, meanLineGuid: meta.mean_line_guid, account: meta.account }, meta.start)
  if (!stored) return null
  return {
    reportId: stored.reportId, reportTitle: await reportTitle(con, stored.reportId), createdAt: stored.createdAt, items: stored.items,
    checks: await checkOnSessions(con, stored.items, [sessionGuid], stored.reportId, stored.createdAt, system),
  }
}

// One card per car and layout, most recent first.
export async function buildDashboard(con: DuckDBConnection, system: UnitSystem, account: string | null): Promise<DashboardLayout[]> {
  const predicate = await validLapPredicate(con)
  const layouts = await rows(con, `
    SELECT COALESCE(s.mean_line_guid, CAST(s.track_configuration_id AS VARCHAR)) AS layout, s.vehicle_guid,
      COUNT(*) AS sessions, MAX(s.session_start) AS latest
    FROM sessions s
    WHERE s.details_loaded ${account ? 'AND (s.account = ? OR s.account IS NULL)' : ''}
    GROUP BY ALL ORDER BY latest DESC LIMIT 8
  `, account ? [account] : [])
  const out: DashboardLayout[] = []
  for (const layout of layouts) {
    const guids = (await rows(con, `
      SELECT session_guid FROM sessions s
      WHERE s.details_loaded AND COALESCE(s.mean_line_guid, CAST(s.track_configuration_id AS VARCHAR)) = ?
        AND s.vehicle_guid IS NOT DISTINCT FROM ? ${account ? 'AND (s.account = ? OR s.account IS NULL)' : ''}
      ORDER BY s.session_start
    `, account ? [layout.layout, layout.vehicle_guid, account] : [layout.layout, layout.vehicle_guid])).map(r => String(r.session_guid))
    const meta = await fetchSessionMeta(con, guids)
    const last = meta[meta.length - 1]
    if (!last) continue
    const pbRow = (await rows(con, `
      SELECT l.session_guid, l.lap_index, l.duration_ms, CAST(s.session_start AS VARCHAR) AS start
      FROM laps l JOIN sessions s ON s.session_guid = l.session_guid
      WHERE ${predicate} AND l.session_guid IN (${guids.map(() => '?').join(',')})
      ORDER BY l.duration_ms LIMIT 1
    `, guids))[0]
    const lastBest = (await rows(con, `
      SELECT MIN(l.duration_ms) AS best FROM laps l WHERE ${predicate} AND l.session_guid = ?
    `, [last.session_guid]))[0]?.best
    const optimal = await fetchOptimalLapTimes(con, guids)
    let focus: FocusStatus | null = null
    const stored = await latestFocus(con, { vehicleGuid: last.vehicle_guid, meanLineGuid: last.mean_line_guid, account: last.account })
    if (stored) {
      // Check on the most recent session driven after the report's sessions.
      const after = meta.filter(m => !stored.latestSessionStart || (m.start ?? '') > stored.latestSessionStart)
      const target = after[after.length - 1]
      focus = {
        reportId: stored.reportId, reportTitle: await reportTitle(con, stored.reportId), createdAt: stored.createdAt, items: stored.items,
        checks: target ? await checkOnSessions(con, stored.items, [target.session_guid], stored.reportId, stored.createdAt, system) : [],
      }
    }
    const lastBestMs = lastBest == null ? null : Number(lastBest)
    out.push({
      key: `${layout.layout}:${layout.vehicle_guid ?? ''}`,
      trackLabel: [last.track_name, last.track_configuration_name].filter(Boolean).join(' · ') || 'Unknown track',
      vehicleLabel: vehicleLabelOf(last),
      sessionCount: guids.length,
      lastSession: { guid: last.session_guid, label: shortSessionLabel(last.start), bestMs: lastBestMs },
      pb: pbRow ? { ms: Number(pbRow.duration_ms), label: lapLabel(pbRow.start, Number(pbRow.lap_index)), guid: String(pbRow.session_guid) } : null,
      lastVsPbMs: pbRow && lastBestMs != null ? lastBestMs - Number(pbRow.duration_ms) : null,
      garminOptimalMs: optimal.size ? Math.min(...optimal.values()) : null,
      focus,
    })
  }
  return out
}
