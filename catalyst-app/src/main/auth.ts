// Desktop fallback: Garmin owns the login/MFA UI in an isolated browser window.
import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import { CATALYST_CLIENT_ID, exchangeTicketForToken } from '../garmin/catalystClient.js'
import { buildGarminLoginUrl, garminTicketFromUrl } from '../shared/garminSso.js'

let activeLogin: BrowserWindow | null = null

export async function loginViaBrowser(parent?: BrowserWindow): Promise<{ accessToken: string; expiresIn: number }> {
  if (activeLogin && !activeLogin.isDestroyed()) {
    activeLogin.focus()
    throw new Error('A Garmin sign-in window is already open.')
  }
  // This URL is intercepted before any network request; no fixed local port.
  const serviceUrl = `https://sso.garmin.com/sso/embed/${randomUUID()}`
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520, height: 720, parent, modal: false,
      title: 'Sign in to Garmin', autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        // In-memory and isolated from the app's preload, cookies and account.
        partition: `garmin-sso-${randomUUID()}`,
      },
    })
    activeLogin = win
    let finished = false
    const cleanup = () => {
      clearTimeout(timer)
      if (activeLogin === win) activeLogin = null
      if (!win.isDestroyed()) win.close()
    }
    const fail = (message: string) => {
      if (finished) return
      finished = true
      cleanup()
      reject(new Error(message))
    }
    const timer = setTimeout(() => fail('Garmin sign-in timed out. Please try again.'), 10 * 60_000)
    const handleUrl = (url: string, event?: { preventDefault(): void }) => {
      const ticket = garminTicketFromUrl(url, serviceUrl)
      if (!ticket) return
      event?.preventDefault()
      if (finished) return
      finished = true
      cleanup()
      void exchangeTicketForToken(ticket, serviceUrl).then(resolve, () => {
        reject(new Error('Garmin returned a ticket, but Catalyst could not exchange it. Try again or use email/password.'))
      })
    }
    win.webContents.on('will-frame-navigate', event => handleUrl(event.url, event))
    win.webContents.on('will-redirect', (event, url) => handleUrl(url, event))
    win.webContents.on('did-navigate-in-page', (_event, url) => handleUrl(url))
    win.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) fail(`Garmin sign-in page could not load (${code}). Please try again.`)
    })
    win.webContents.setWindowOpenHandler(({ url }) => {
      // Keep Garmin's own links in the sandboxed sign-in window.
      try {
        if (new URL(url).origin === 'https://sso.garmin.com') {
          void win.loadURL(url).catch(() => fail('Garmin sign-in page could not load.'))
        }
      } catch { /* reject malformed links */ }
      return { action: 'deny' }
    })
    win.on('closed', () => fail('Garmin sign-in cancelled.'))
    void win.loadURL(buildGarminLoginUrl(serviceUrl, CATALYST_CLIENT_ID))
      .catch(() => fail('Garmin sign-in page could not load. Please try again.'))
  })
}
