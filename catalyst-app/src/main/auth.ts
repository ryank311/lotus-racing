// Electron-driven Garmin SSO login flow.
//
// Opens a BrowserWindow pointed at the SSO embed widget configured for the
// Catalyst client_id. The SSO redirects to a localhost-like service URL with
// `?ticket=ST-...` once the user finishes. We intercept that navigation,
// extract the ticket, close the window, and exchange the ticket for a
// Catalyst-scoped OAuth2 token (which we cache for 90 days).
//
// MFA, captcha, password resets — all handled in the BrowserWindow with no
// code changes here.

import { BrowserWindow } from 'electron'
import {
  CATALYST_CLIENT_ID,
  exchangeTicketForToken,
} from '../garmin/catalystClient.js'

const SSO_BASE = 'https://sso.garmin.com'
const SERVICE_URL = 'http://localhost:8765/callback'

// SSO param set — kept in lockstep with garth/sso.py's PARAMS (the gold standard
// Python implementation we reverse-engineered the rest of the flow from).
// Garmin recently started requiring `locale`; without it the embed page bails
// with "ERROR: locale parameter must be specified" after you advance past the
// email-first step.
function buildLoginUrl(): string {
  const params = new URLSearchParams({
    id: 'gauth-widget',
    embedWidget: 'true',
    gauthHost: SSO_BASE,
    service: SERVICE_URL,
    source: SERVICE_URL,
    redirectAfterAccountLoginUrl: SERVICE_URL,
    redirectAfterAccountCreationUrl: SERVICE_URL,
    locale: 'en_US',
    mobile: 'true',
    clientId: CATALYST_CLIENT_ID,
  })
  return `${SSO_BASE}/sso/embed?${params.toString()}`
}

export async function loginViaBrowser(parent?: BrowserWindow): Promise<{ accessToken: string; expiresIn: number }> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 720,
      parent,
      modal: false,
      title: 'Sign in to Garmin',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    })

    let finished = false
    const cleanup = () => {
      if (!win.isDestroyed()) win.close()
    }

    const handleUrl = async (url: string) => {
      if (finished) return
      const m = url.match(/[?&]ticket=([^&\s]+)/)
      if (!m) return
      finished = true
      const ticket = m[1]
      try {
        const result = await exchangeTicketForToken(ticket, SERVICE_URL)
        cleanup()
        resolve(result)
      } catch (e) {
        cleanup()
        reject(e)
      }
    }

    win.webContents.on('will-redirect', (_e, url) => handleUrl(url))
    win.webContents.on('did-navigate', (_e, url) => handleUrl(url))
    win.webContents.on('did-navigate-in-page', (_e, url) => handleUrl(url))

    win.on('closed', () => {
      if (!finished) reject(new Error('Login cancelled'))
    })

    win.loadURL(buildLoginUrl()).catch(reject)
  })
}
