import type { DuckDBConnection } from '@duckdb/node-api'

export async function initReviewSchema(con: DuckDBConnection): Promise<void> {
  await con.run(`
    ALTER TABLE sessions ADD COLUMN IF NOT EXISTS review_source_revision VARCHAR;
    CREATE TABLE IF NOT EXISTS review_conditions (
      session_guid VARCHAR PRIMARY KEY, surface VARCHAR, temperature_c DOUBLE,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS review_lap_exclusions (
      session_guid VARCHAR, lap_index INTEGER, reason VARCHAR,
      PRIMARY KEY(session_guid, lap_index)
    );
    CREATE TABLE IF NOT EXISTS review_jobs (
      session_guid VARCHAR PRIMARY KEY, state VARCHAR NOT NULL, generation INTEGER DEFAULT 1,
      priority INTEGER DEFAULT 0, error VARCHAR, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE review_jobs ADD COLUMN IF NOT EXISTS attempt_revision VARCHAR;
    CREATE TABLE IF NOT EXISTS review_aggregates (
      session_guid VARCHAR PRIMARY KEY, version INTEGER, source_revision VARCHAR,
      definition_revision VARCHAR, revision VARCHAR, summary JSON, payload JSON
    );
    CREATE TABLE IF NOT EXISTS review_lap_metrics (
      session_guid VARCHAR, lap_index INTEGER, payload JSON, PRIMARY KEY(session_guid, lap_index)
    );
    CREATE TABLE IF NOT EXISTS review_snapshots (
      revision VARCHAR PRIMARY KEY, session_guid VARCHAR, payload JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS review_settings (key VARCHAR PRIMARY KEY, value VARCHAR);
    ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS review_context JSON;
    ALTER TABLE coaching_sessions ADD COLUMN IF NOT EXISTS review_result JSON;
  `)
}

export async function markReviewDirty(con: DuckDBConnection, guid: string, priority = 0): Promise<void> {
  await con.run(`INSERT INTO review_jobs(session_guid, state, priority) VALUES (?, 'pending', ?)
    ON CONFLICT(session_guid) DO UPDATE SET state='pending', generation=review_jobs.generation+1,
      priority=GREATEST(review_jobs.priority, excluded.priority), error=NULL, updated_at=now()`, [guid, priority])
}
