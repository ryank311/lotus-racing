import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CATALYST_CLIENT_ID } from '../garmin/catalystClient.js'
import { buildGarminLoginUrl, garminTicketFromUrl } from '../shared/garminSso.js'
import type { SignInResult } from '../shared/types.js'

type Attempt = {
  username: string
  serviceUrl: string
  expiresAt: number
  status: 'pending' | 'exchanging' | 'complete' | 'error'
  result?: SignInResult
  error?: string
}

// One-use callbacks stay bound to the driver who started them. Tokens are
// exchanged and cached in that driver's worker, never in the shared server.
export class GarminSsoServer {
  private attempts = new Map<string, Attempt>()

  constructor(private complete: (username: string, ticket: string, serviceUrl: string) => Promise<SignInResult>) {}

  async handle(req: IncomingMessage, res: ServerResponse, url: URL, username: string | null): Promise<boolean> {
    const prefix = '/api/auth/garmin/'
    if (!url.pathname.startsWith(prefix)) return false
    for (const [id, attempt] of this.attempts) {
      if (attempt.expiresAt < Date.now()) this.attempts.delete(id)
    }
    const reply = (status: number, payload: unknown) => {
      res.writeHead(status, {
        'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        ...(req.headers.origin ? {
          'Access-Control-Allow-Origin': req.headers.origin,
          'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin',
        } : {}),
      })
      res.end(JSON.stringify(payload))
    }
    if (!username) { reply(401, { error: 'Sign in to your Catalyst driver workspace first.' }); return true }
    const action = url.pathname.slice(prefix.length)
    if (action === 'start' && req.method === 'POST') {
      // The browser sends its API origin explicitly so HTTPS proxies and the
      // Vite proxy retain their public callback address. Restrict it to the
      // request's Host or Origin rather than trusting forwarded headers.
      const callbackOrigin = req.headers['x-catalyst-origin']
      let base: URL
      try { base = new URL(typeof callbackOrigin === 'string' ? callbackOrigin : '') }
      catch { reply(400, { error: 'Invalid callback origin' }); return true }
      if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
          (base.host !== url.host && base.origin !== req.headers.origin)) {
        reply(400, { error: 'Invalid callback origin' }); return true
      }
      for (const [id, attempt] of this.attempts) {
        if (attempt.username === username) {
          if (attempt.status === 'exchanging') { reply(409, { error: 'Garmin sign-in is finishing. Please wait.' }); return true }
          this.attempts.delete(id)
        }
      }
      const id = randomBytes(32).toString('hex')
      const serviceUrl = `${base.origin}${prefix}callback/${id}`
      this.attempts.set(id, { username, serviceUrl, expiresAt: Date.now() + 10 * 60_000, status: 'pending' })
      reply(200, { id, url: buildGarminLoginUrl(serviceUrl, CATALYST_CLIENT_ID) })
      return true
    }
    const [operation, id] = action.split('/')
    const attempt = this.attempts.get(id)
    if (!attempt || attempt.username !== username) {
      reply(400, { error: 'SSO attempt expired or belongs to another driver. Start sign-in again.' }); return true
    }
    if (operation === 'status' && req.method === 'GET') {
      reply(200, { status: attempt.status, result: attempt.result, error: attempt.error }); return true
    }
    if (operation === 'cancel' && req.method === 'POST') {
      if (attempt.status === 'exchanging') { reply(409, { error: 'Garmin sign-in is finishing. Please wait.' }); return true }
      this.attempts.delete(id)
      reply(200, { ok: true }); return true
    }
    if (operation === 'callback' && req.method === 'GET') {
      const ticket = garminTicketFromUrl(`${new URL(attempt.serviceUrl).origin}${url.pathname}${url.search}`, attempt.serviceUrl)
      if (attempt.status !== 'pending' || !ticket) {
        reply(400, { error: 'Missing ticket or this SSO callback has already been used.' }); return true
      }
      attempt.status = 'exchanging'
      try {
        attempt.result = await this.complete(username, ticket, attempt.serviceUrl)
        attempt.status = 'complete'
      } catch {
        attempt.status = 'error'
        // Upstream errors may contain tickets/tokens. Keep diagnostics safe.
        attempt.error = 'Garmin returned a ticket, but Catalyst could not exchange it. Try again or use email/password.'
      }
      res.writeHead(attempt.status === 'complete' ? 200 : 502, {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Garmin sign-in</title></head><body style="font:18px system-ui;padding:48px;max-width:560px;margin:auto"><h1>${attempt.status === 'complete' ? 'Garmin connected' : 'Garmin sign-in failed'}</h1><p>${attempt.status === 'complete' ? 'Return to Catalyst Coach. You can close this window.' : attempt.error}</p></body></html>`)
      return true
    }
    reply(405, { error: 'Method not allowed' }); return true
  }
}
