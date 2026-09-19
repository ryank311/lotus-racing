import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { DuckDBConnection } from '@duckdb/node-api'
import { DB_PATH, MEAN_LINES_DIR } from './paths.js'
import { initSchema, withDb } from './loadToDb.js'
import { markReviewDirty } from './reviewSchema.js'
import { decodeMeanLine } from './decodePerformance.js'
import { loadTrackYaml, resolveTrackYamlPath } from './trackYaml.js'
import { aggregateLaps, buildComparison, finite, identityKey, inferSurface, measureLap, REVIEW_VERSION } from './reviewMetrics.js'
import { SURFACES, type ConditionOverride, type ProgressFilters, type ProgressResponse, type ReviewAggregate, type ReviewConditions, type ReviewLap, type ReviewRegion, type ReviewSnapshot, type ReviewStatus, type ReviewSummary, type SessionReviewResponse, type ReviewCoachingReport } from '../shared/review.js'

export const reviewHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const parse = <T>(value: unknown): T => typeof value === 'string' ? JSON.parse(value) : value as T
async function rows(con: DuckDBConnection, sql: string, params: any[] = []): Promise<any[]> {
  return (await con.runAndReadAll(sql, params)).getRowObjectsJson()
}
export function validateReviewGuid(guid: string): void {
  if (typeof guid !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(guid)) throw new Error('Invalid session ID')
}
export function validateConditions(value: ConditionOverride): void {
  if (!value || (value.surface !== null && !SURFACES.includes(value.surface))) throw new Error('Invalid surface')
  if (value.temperatureC !== null && (!finite(value.temperatureC) || value.temperatureC < -60 || value.temperatureC > 70)) throw new Error('Temperature must be between −60°C and 70°C')
}
export function validateProgressFilters(filters: ProgressFilters): void {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) throw new Error('Invalid progress filters')
  if (filters.surface !== undefined && !SURFACES.includes(filters.surface)) throw new Error('Invalid surface')
  if (filters.temperatureC !== undefined && (!finite(filters.temperatureC) || filters.temperatureC < -60 || filters.temperatureC > 70)) throw new Error('Invalid temperature')
  for (const key of ['configurationId', 'cartographyId'] as const) if (filters[key] !== undefined && !Number.isSafeInteger(filters[key])) throw new Error('Invalid track identifier')
  if (filters.reverse !== undefined && typeof filters.reverse !== 'boolean') throw new Error('Invalid direction')
  for (const key of ['account', 'vehicleGuid', 'anchorSessionGuid', 'direction'] as const) {
    if (filters[key] != null && (typeof filters[key] !== 'string' || filters[key]!.length > 200)) throw new Error('Invalid progress identifier')
  }
}

export interface ReviewDefinition { regions: ReviewRegion[]; totalM: number; revision: string; map: ReviewAggregate['map'] }
export function readReviewDefinition(session: any): ReviewDefinition {
  const resolved = resolveTrackYamlPath(session.track_name ?? '', session.track_configuration_name ?? '', session.mean_line_guid)
  const yaml = loadTrackYaml(resolved.path)
  const file = session.mean_line_guid && /^[a-zA-Z0-9_-]+$/.test(session.mean_line_guid)
    ? path.join(MEAN_LINES_DIR, `${session.mean_line_guid}.pb`) : null
  const ml = file && fs.existsSync(file) ? decodeMeanLine(new Uint8Array(fs.readFileSync(file))) : null
  const totalM = ml?.points.at(-1)?.dist ?? yaml.total_dist_m ?? 0
  // Do not apply another meanline's named corners via the legacy name fallback.
  const compatible = !!session.mean_line_guid && yaml.mean_line_guid === session.mean_line_guid
  const corners = compatible ? yaml.corners : []
  const segments = compatible && yaml.segments.length ? yaml.segments : ml?.segments ?? []
  const regions: ReviewRegion[] = [
    ...corners.map(c => ({ id: `corner:${c.turn}`, name: c.name ? `${c.turn} · ${c.name}` : c.turn, kind: 'corner' as const, startM: c.dist_idx_start, endM: c.dist_idx_end })),
    ...segments.map(s => ({ id: `segment:S${s.id}`, name: `S${s.id}`, kind: 'segment' as const, startM: s.start_dist_m, endM: s.end_dist_m })),
  ].filter(r => finite(r.startM) && finite(r.endM) && r.startM >= 0 && r.endM > r.startM)
  const origin = ml?.points[0]
  const map = origin ? ml!.points.filter((_, i) => i % 10 === 0 || i === ml!.points.length - 1).map(p => ({
    dist: p.dist, x: (p.lon - origin.lon) * 111320 * Math.cos(origin.lat * Math.PI / 180), y: -(p.lat - origin.lat) * 111320,
  })) : []
  return { regions, totalM, map, revision: reviewHash([session.mean_line_guid, regions, totalM, map]) }
}

async function sessionRows(con: DuckDBConnection): Promise<any[]> {
  return rows(con, `SELECT s.*, CAST(s.session_start AS VARCHAR) AS start,
    COALESCE(s.track_name, tc.track_name, '') AS track_label,
    COALESCE(s.track_configuration_name, tc.track_configuration_name, '') AS layout_label,
    tc.reverse, tc.direction FROM sessions s LEFT JOIN track_configs tc USING(track_configuration_id)
    ORDER BY s.session_start DESC NULLS LAST, s.session_guid`)
}
function sourceRevision(s: any): string {
  return reviewHash([s.review_source_revision, s.start, s.account, s.vehicle_guid, s.track_cartography_id, s.track_configuration_id,
    s.reverse, s.direction, s.mean_line_guid, s.weather_description, s.temperature_c, s.track_label, s.layout_label])
}

/** Owns all review writes in the existing driver process; no second DB writer. */
export class ReviewService {
  private active: Promise<void> | null = null
  private scheduled = false
  private suspended = 0
  private serial: Promise<unknown> = Promise.resolve()
  private initialized = false
  private definitionCache = new Map<string, ReviewDefinition>()
  constructor(private options: { dbPath?: string; isBusy?: () => boolean; emit?: (event: ReviewStatus) => void; definition?: (session: any) => ReviewDefinition } = {}) {}
  private db<T>(fn: (con: DuckDBConnection) => Promise<T>) { return withDb(fn, this.options.dbPath ?? DB_PATH) }
  private definition(s: any): ReviewDefinition {
    const key = String(s.mean_line_guid ?? s.track_configuration_id)
    let value = this.definitionCache.get(key)
    if (!value) { value = (this.options.definition ?? readReviewDefinition)(s); this.definitionCache.set(key, value) }
    return value
  }
  private emit(sessionGuid: string, state: ReviewStatus['state'], error?: string) { this.options.emit?.({ sessionGuid, state, error }) }
  async pause(): Promise<void> { this.suspended++; await this.active }
  resume(): void { this.suspended = Math.max(0, this.suspended - 1); this.kick() }
  private async write<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.serial.then(async () => { await this.pause(); try { return await fn() } finally { this.resume() } })
    this.serial = task.catch(() => {})
    return task
  }
  /** Foreground writers join the same queue as overrides before claiming the DB. */
  foreground<T>(fn: () => Promise<T>): Promise<T> { return this.write(fn) }
  async initialize(): Promise<void> {
    await this.write(async () => {
      await this.db(async con => {
        await initSchema(con)
        if (!this.initialized) await con.run("UPDATE review_jobs SET state='pending' WHERE state='processing'")
        this.initialized = true
        await this.discover(con)
      })
    })
  }
  private async discover(con: DuckDBConnection): Promise<void> {
    this.definitionCache.clear()
    const sessions = await sessionRows(con)
    const aggregates = new Map((await rows(con, 'SELECT session_guid, source_revision, definition_revision, version FROM review_aggregates')).map(r => [r.session_guid, r]))
    const jobs = new Map((await rows(con, 'SELECT session_guid, state, attempt_revision FROM review_jobs')).map(r => [r.session_guid, r]))
    for (const s of sessions.filter(s => s.details_loaded)) {
      const cached = aggregates.get(s.session_guid), job = jobs.get(s.session_guid)
      if (job && ['pending', 'processing'].includes(job.state)) continue
      let definition: ReviewDefinition
      try { definition = this.definition(s) }
      catch {
        // One corrupt definition must not prevent unrelated history from loading.
        if (job?.state !== 'failed') await markReviewDirty(con, s.session_guid)
        continue
      }
      if (job?.state === 'failed') {
        if (job.attempt_revision !== reviewHash([REVIEW_VERSION, sourceRevision(s), definition.revision])) await markReviewDirty(con, s.session_guid)
      } else if (!cached || cached.version !== REVIEW_VERSION || cached.source_revision !== sourceRevision(s) || cached.definition_revision !== definition.revision) await markReviewDirty(con, s.session_guid)
    }
  }
  async refresh(): Promise<void> { await this.write(() => this.db(con => this.discover(con))) }
  kick(): void {
    if (!this.initialized || this.scheduled || this.active || this.suspended || this.options.isBusy?.()) return
    this.scheduled = true
    const timer = setTimeout(() => {
      this.scheduled = false
      if (this.active || this.suspended || this.options.isBusy?.()) return
      this.active = this.processNext().catch(error => console.error('[review]', error)).finally(() => { this.active = null })
      void this.active.then(() => this.kickIfPending()).catch(error => console.error('[review]', error))
    }, 20)
    timer.unref?.()
  }
  private async kickIfPending(): Promise<void> {
    if (this.suspended || this.options.isBusy?.()) return
    const pending = await this.db(con => rows(con, "SELECT j.session_guid FROM review_jobs j JOIN sessions s USING(session_guid) WHERE j.state='pending' AND s.details_loaded=true LIMIT 1"))
    if (pending.length) this.kick()
  }
  private async processNext(): Promise<void> {
    await this.db(async con => {
      const job = (await rows(con, `SELECT j.* FROM review_jobs j JOIN sessions s USING(session_guid)
        WHERE j.state='pending' AND s.details_loaded=true ORDER BY priority DESC, s.session_start DESC NULLS LAST LIMIT 1`))[0]
      if (!job) return
      const guid = String(job.session_guid)
      await con.run("UPDATE review_jobs SET state='processing' WHERE session_guid=?", [guid]); this.emit(guid, 'processing')
      try {
        const session = (await sessionRows(con)).find(s => s.session_guid === guid)
        if (!session) throw new Error('Session unavailable')
        const definition = this.definition(session)
        await con.run('UPDATE review_jobs SET attempt_revision=? WHERE session_guid=?', [reviewHash([REVIEW_VERSION, sourceRevision(session), definition.revision]), guid])
        const aggregate = await this.extract(con, session, definition)
        await con.run('BEGIN TRANSACTION')
        try {
          await con.run('DELETE FROM review_lap_metrics WHERE session_guid=?', [guid])
          for (const lap of aggregate.laps) await con.run('INSERT INTO review_lap_metrics VALUES (?, ?, ?)', [guid, lap.index, JSON.stringify(lap)])
          await con.run(`INSERT OR REPLACE INTO review_aggregates VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [guid, REVIEW_VERSION, sourceRevision(session), definition.revision, aggregate.revision, JSON.stringify(aggregate.summary), JSON.stringify({ ...aggregate, laps: [] })])
          await con.run("UPDATE review_jobs SET state='ready', priority=0, error=NULL, updated_at=now() WHERE session_guid=? AND generation=?", [guid, job.generation])
          await con.run('COMMIT')
        } catch (error) { await con.run('ROLLBACK'); throw error }
        this.emit(guid, 'ready')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await con.run("UPDATE review_jobs SET state='failed', error=?, updated_at=now() WHERE session_guid=?", [message, guid])
        this.emit(guid, 'failed', message)
      }
    })
  }
  private async extract(con: DuckDBConnection, s: any, definition: ReviewDefinition): Promise<ReviewAggregate> {
    const guid = String(s.session_guid)
    const override = (await rows(con, 'SELECT *, CAST(updated_at AS VARCHAR) AS corrected_at FROM review_conditions WHERE session_guid=?', [guid]))[0]
    const exclusions = new Map((await rows(con, 'SELECT * FROM review_lap_exclusions WHERE session_guid=?', [guid])).map(r => [Number(r.lap_index), r.reason]))
    const rawLaps = await rows(con, 'SELECT * FROM laps WHERE session_guid=? ORDER BY lap_index', [guid])
    const laps: ReviewLap[] = []
    for (const l of rawLaps) {
      const samples = await rows(con, 'SELECT distance_m, time_ms, gnss_speed_mps FROM samples WHERE session_guid=? AND lap_index=? ORDER BY distance_m, time_ms', [guid, l.lap_index])
      laps.push(measureLap({ index: Number(l.lap_index), durationMs: Number(l.duration_ms), type: l.lap_type, descriptor: Number(l.lap_descriptor),
        excluded: exclusions.has(Number(l.lap_index)), exclusionReason: exclusions.get(Number(l.lap_index)),
        samples: samples.map(r => ({ distance: Number(r.distance_m), time: r.time_ms == null ? null : Number(r.time_ms), speed: r.gnss_speed_mps == null ? null : Number(r.gnss_speed_mps) })),
      }, definition.regions, definition.totalM))
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    const surface = override?.surface ?? inferSurface(s.weather_description)
    const conditions: ReviewConditions = { weather: s.weather_description, originalTemperatureC: s.temperature_c,
      temperatureC: override?.temperature_c ?? s.temperature_c, surface,
      surfaceSource: override?.surface != null ? 'corrected' : surface === 'unknown' ? 'unknown' : 'estimated',
      temperatureSource: override?.temperature_c != null ? 'corrected' : 'recorded', correctedAt: override?.corrected_at ?? null }
    const summary: ReviewSummary = { sessionGuid: guid, start: s.start ?? null, track: s.track_label, layout: s.layout_label,
      vehicle: [s.vehicle_year, s.vehicle_make, s.vehicle_model].filter(Boolean).join(' ') || 'Unknown vehicle',
      account: s.account ?? null, vehicleGuid: s.vehicle_guid ?? null, configurationId: s.track_configuration_id ?? null,
      cartographyId: s.track_cartography_id ?? null, reverse: s.reverse ?? null, direction: s.direction ?? null,
      meanLineGuid: s.mean_line_guid ?? null, geometryRevision: definition.revision, sourceRevision: sourceRevision(s), conditions,
      ...aggregateLaps(laps, definition.regions), qualityNotes: [] }
    if (!identityKey(summary)) summary.qualityNotes.push('Historical comparisons need a known driver, vehicle, track, layout, and direction.')
    if (surface === 'unknown' || !finite(conditions.temperatureC)) summary.qualityNotes.push('Confirm surface and temperature to enable condition-matched comparisons.')
    if (summary.fastLapCount < 3) summary.qualityNotes.push(`Only ${summary.fastLapCount} eligible lap(s); the fast-three sample is incomplete.`)
    if (!definition.regions.some(r => r.kind === 'corner')) summary.qualityNotes.push('Named corners are unavailable for this meanline. Add them in Tracks.')
    if (conditions.surfaceSource === 'estimated') summary.qualityNotes.push('Surface is estimated from weather at session start; confirm if the track changed.')
    const payload = { version: REVIEW_VERSION, summary, laps, map: definition.map }
    return { ...payload, revision: reviewHash(payload) }
  }
  async ensure(guid: string, retry = false): Promise<void> {
    validateReviewGuid(guid)
    await this.write(() => this.db(async con => {
      await initSchema(con)
      const s = (await rows(con, 'SELECT details_loaded FROM sessions WHERE session_guid=?', [guid]))[0]
      if (!s) throw new Error('Session not found')
      if (!s.details_loaded) return
      const job = (await rows(con, 'SELECT state FROM review_jobs WHERE session_guid=?', [guid]))[0]
      if (!job || retry) await markReviewDirty(con, guid, 100)
      else await con.run('UPDATE review_jobs SET priority=100 WHERE session_guid=?', [guid])
      // Prefer prior sessions for this layout over unrelated backfill.
      await con.run(`UPDATE review_jobs SET priority=GREATEST(priority, 50) WHERE state='pending' AND session_guid IN
        (SELECT a.session_guid FROM sessions a JOIN sessions b ON a.track_configuration_id=b.track_configuration_id
          WHERE b.session_guid=? AND a.session_start < b.session_start)`, [guid])
      await con.run("INSERT OR REPLACE INTO review_settings VALUES ('last_reviewed', ?)", [guid])
    }))
    this.kick()
  }
  async updateConditions(guid: string, value: ConditionOverride): Promise<void> {
    validateReviewGuid(guid); validateConditions(value)
    await this.write(() => this.db(async con => {
      if (!(await rows(con, 'SELECT 1 FROM sessions WHERE session_guid=?', [guid])).length) throw new Error('Session not found')
      await con.run('BEGIN TRANSACTION')
      try {
        await con.run('INSERT OR REPLACE INTO review_conditions VALUES (?, ?, ?, now())', [guid, value.surface, value.temperatureC])
        await markReviewDirty(con, guid, 100); await con.run('COMMIT')
      } catch (error) { await con.run('ROLLBACK'); throw error }
      this.emit(guid, 'pending')
    }))
  }
  async excludeLap(guid: string, index: number, excluded: boolean, reason?: string): Promise<void> {
    validateReviewGuid(guid)
    if (!Number.isSafeInteger(index) || index < 0 || typeof excluded !== 'boolean' || (reason != null && (typeof reason !== 'string' || reason.length > 500))) throw new Error('Invalid lap exclusion')
    await this.write(() => this.db(async con => {
      if (!(await rows(con, 'SELECT 1 FROM laps WHERE session_guid=? AND lap_index=?', [guid, index])).length) throw new Error('Lap not found')
      await con.run('BEGIN TRANSACTION')
      try {
        if (excluded) await con.run('INSERT OR REPLACE INTO review_lap_exclusions VALUES (?, ?, ?)', [guid, index, reason?.trim() || null])
        else await con.run('DELETE FROM review_lap_exclusions WHERE session_guid=? AND lap_index=?', [guid, index])
        await markReviewDirty(con, guid, 100); await con.run('COMMIT')
      } catch (error) { await con.run('ROLLBACK'); throw error }
      this.emit(guid, 'pending')
    }))
  }
  private async summaries(con: DuckDBConnection): Promise<ReviewSummary[]> {
    return (await rows(con, `SELECT a.summary FROM review_aggregates a JOIN review_jobs j USING(session_guid)
      JOIN sessions s USING(session_guid) WHERE j.state='ready' AND s.details_loaded=true AND a.version=?`, [REVIEW_VERSION])).map(r => parse<ReviewSummary>(r.summary))
  }
  private async coverage(con: DuckDBConnection): Promise<ReviewSnapshot['coverage']> {
    const r = (await rows(con, `SELECT COUNT(*) AS catalog, COUNT(*) FILTER(WHERE s.details_loaded) AS downloaded,
      COUNT(*) FILTER(WHERE j.state='ready') AS processed, COUNT(*) FILTER(WHERE j.state IN ('pending','processing')) AS pending,
      COUNT(*) FILTER(WHERE j.state='failed') AS failed FROM sessions s LEFT JOIN review_jobs j USING(session_guid)`))[0]
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)])) as ReviewSnapshot['coverage']
  }
  async get(guid: string): Promise<SessionReviewResponse> {
    validateReviewGuid(guid)
    return this.db(async con => {
      const row = (await rows(con, `SELECT s.details_loaded, j.state, j.error, a.payload FROM sessions s
        LEFT JOIN review_jobs j USING(session_guid) LEFT JOIN review_aggregates a USING(session_guid) WHERE s.session_guid=?`, [guid]))[0]
      if (!row) throw new Error('Session not found')
      const state = !row.details_loaded ? 'needs-download' : row.state ?? 'pending'
      if (state !== 'ready' || !row.payload) return { state, error: row.error ?? null, snapshot: null, coaching: null, coachingStale: false }
      const aggregate = parse<ReviewAggregate>(row.payload)
      aggregate.laps = (await rows(con, 'SELECT payload FROM review_lap_metrics WHERE session_guid=? ORDER BY lap_index', [guid])).map(r => parse<ReviewLap>(r.payload))
      const computed = buildComparison(aggregate, await this.summaries(con), await this.coverage(con))
      // Unrelated/future archive growth is not a change to coaching evidence.
      const revision = reviewHash([REVIEW_VERSION, aggregate.revision, computed.history, computed.regions])
      const snapshot: ReviewSnapshot = { ...computed, revision }
      await con.run('INSERT INTO review_snapshots(revision, session_guid, payload) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [revision, guid, JSON.stringify(snapshot)])
      const coach = (await rows(con, `SELECT id, CAST(created_at AS VARCHAR) AS created_at, model_used, review_context, review_result
        FROM coaching_sessions WHERE json_extract_string(review_context, '$.sessionGuid')=? ORDER BY created_at DESC LIMIT 1`, [guid]))[0]
      let coaching: ReviewCoachingReport | null = null
      if (coach) {
        const context = parse<any>(coach.review_context)
        coaching = { id: coach.id, sessionGuid: guid, revision: context.revision, createdAt: coach.created_at, model: coach.model_used,
          units: context.units, result: coach.review_result ? parse(coach.review_result) : null, error: context.error ?? null, evidence: context.evidence ?? {} }
      }
      return { state: 'ready', error: null, snapshot, coaching, coachingStale: !!coaching && coaching.revision !== revision }
    })
  }
  async progress(input: ProgressFilters = {}): Promise<ProgressResponse> {
    validateProgressFilters(input)
    return this.db(async con => {
      const available = (await this.summaries(con)).sort((a, b) => (a.start ?? '').localeCompare(b.start ?? ''))
      const last = (await rows(con, "SELECT value FROM review_settings WHERE key='last_reviewed'"))[0]?.value
      const anchor = available.find(s => s.sessionGuid === (input.anchorSessionGuid ?? last)) ?? available.at(-1)
      const filters: ProgressFilters = { vehicleGuid: anchor?.vehicleGuid ?? undefined, configurationId: anchor?.configurationId ?? undefined,
        cartographyId: anchor?.cartographyId ?? undefined, account: anchor?.account ?? undefined, reverse: anchor?.reverse ?? undefined,
        direction: anchor?.direction, surface: anchor?.conditions.surface, temperatureC: anchor?.conditions.temperatureC ?? undefined, ...input }
      const sessions = available.filter(s => identityKey(s) && s.vehicleGuid === filters.vehicleGuid && s.configurationId === filters.configurationId
        && s.cartographyId === filters.cartographyId && s.account === filters.account && s.reverse === filters.reverse && s.direction === filters.direction
        && filters.surface !== 'unknown' && s.conditions.surface === filters.surface && finite(filters.temperatureC)
        && finite(s.conditions.temperatureC) && Math.abs(s.conditions.temperatureC - filters.temperatureC) <= 5 + 1e-8 && s.fastLapCount > 0)
      const references = sessions.map(s => {
        const comparison = buildComparison({ summary: s, laps: [], map: [], version: REVIEW_VERSION, revision: '' }, available,
          { catalog: 0, downloaded: 0, processed: 0, pending: 0, failed: 0 })
        return { sessionGuid: s.sessionGuid, baselineMs: comparison.pace.baseline, priorBestMs: comparison.bestLap.personalBest }
      })
      return { filters, available, sessions, references, coverage: await this.coverage(con) }
    })
  }
  /** Deterministic drain for tests/CLI, yielding between sessions as in the service. */
  async drain(): Promise<void> {
    await this.pause()
    try {
      while ((await this.db(con => rows(con, "SELECT 1 FROM review_jobs j JOIN sessions s USING(session_guid) WHERE j.state='pending' AND s.details_loaded=true LIMIT 1"))).length) await this.processNext()
    } finally { this.resume() }
  }
}
