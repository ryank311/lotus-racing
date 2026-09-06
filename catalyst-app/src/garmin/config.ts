// Read/write garmin/config.json.

import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_PATH } from './paths.js'
import type { UnitSystem } from '../shared/units.js'

export interface AppConfig {
  // Metric vs Imperial — drives all unit display across the app and the AI brief.
  units?: UnitSystem
  auth?: {
    email?: string
    password?: string
    bearer_token?: string
    x_garmin_client_id?: string
    x_garmin_unit_id?: string
  }
  output?: {
    data_dir?: string
    pretty_json?: boolean
  }
  api?: {
    page_size?: number
  }
  ai?: {
    provider?: 'anthropic' | 'openai'
    anthropic_api_key?: string
    openai_api_key?: string
    // Legacy Anthropic key location. Read for migration, but new saves use the
    // provider-specific fields above.
    api_key?: string
    model?: string
  }
}

export function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) return {}
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  } catch {
    return {}
  }
}

export function saveConfig(cfg: AppConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2))
}

export function setCredentials(email: string, password: string): void {
  const cfg = loadConfig()
  cfg.auth = { ...(cfg.auth || {}), email, password }
  saveConfig(cfg)
}

export function setAccountEmail(email: string): void {
  const cfg = loadConfig()
  cfg.auth = { ...(cfg.auth || {}), email }
  // Garmin credentials are submitted directly to SSO and are never retained
  // by the remote server. Remove a legacy blank/password field if present.
  delete cfg.auth.password
  saveConfig(cfg)
}
