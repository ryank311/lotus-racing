// Session Review's video panel: one session's videos, laps, corners and the
// car data on every lap a video covers.

import type { DuckDBConnection } from '@duckdb/node-api'
import { fetchSessionMeta } from './coachPacket.js'
import { layoutForSession } from './trackStore.js'
import { fetchValidLaps } from './lapData.js'
import { segmentBounds } from './lapPhases.js'
import { carDataForLaps, listSessionVideos } from './videoStore.js'
import { pressureUnitLabel, speedUnitLabel, tempUnitLabel, DEFAULT_UNIT_SYSTEM, type UnitSystem } from '../shared/units.js'
import type { SessionCarData } from '../shared/pdr.js'

export async function sessionCarData(con: DuckDBConnection, sessionGuid: string, system: UnitSystem = DEFAULT_UNIT_SYSTEM): Promise<SessionCarData> {
  const [meta] = await fetchSessionMeta(con, [sessionGuid])
  if (!meta) throw new Error('That session is not in your workspace.')
  const attached = await listSessionVideos(con, sessionGuid)
  const valid = await fetchValidLaps(con, [sessionGuid])
  const best = valid.length ? Math.min(...valid.map(l => l.durationMs)) : null
  const laps = valid.sort((a, b) => a.lapIndex - b.lapIndex)
    .map(l => ({ lapIdx: l.lapIndex, durationMs: l.durationMs, label: `L${l.lapIndex + 1}`, isBest: l.durationMs === best }))
  const layout = await layoutForSession(con, meta)
  const corners = (layout?.corners ?? []).map(c => ({ turn: c.turn, name: c.name ?? '', apexM: c.apex_idx, startM: c.dist_idx_start, endM: c.dist_idx_end }))
  // Garmin's segments, tiled end to end: the cuts for the stitched optimal lap.
  const splits = segmentBounds(layout?.segments ?? [], layout?.totalDistM ?? 0).map(({ id, startM, endM }) => ({ id, startM, endM }))
  const car = attached.length ? await carDataForLaps(con, laps.map(l => ({ sg: sessionGuid, lapIdx: l.lapIdx })), system) : null
  return {
    sessionGuid, attached, laps, corners, splits,
    videos: car?.videos ?? [], traces: car?.traces ?? [], speedUnit: car?.speedUnit ?? speedUnitLabel(system),
    lapStats: car?.lapStats ?? [], tempUnit: tempUnitLabel(system), pressureUnit: pressureUnitLabel(system),
  }
}
