// Read/write garmin/config.json.

import fs from 'node:fs'
import path from 'node:path'
import { CONFIG_PATH } from './paths.js'

export interface AppConfig {
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
    harness?: 'local' | 'remote'
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
