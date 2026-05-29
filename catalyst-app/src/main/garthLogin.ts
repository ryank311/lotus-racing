// No-browser Garmin SSO login — direct port of python-garth's flow.
//
// Sequence (mirrors garth/sso.py::login):
//   1. GET  /sso/embed?...                    — set initial cookies
//   2. GET  /sso/signin?...                   — parse hidden _csrf from HTML
//   3. POST /sso/signin?...  username+pw+csrf — main credentials check
//   4. If response references /sso/verifyMFA, pause and wait for a code via
//      submitMfaCode(sessionId, code) from the renderer.
//   5. POST /sso/verifyMFA/loginEnterMfaCode  — only when MFA is required
//   6. Parse `embed?ticket=ST-…` out of the final HTML response.
//   7. Exchange that ticket via the existing Catalyst service_ticket grant.
//
// Cookies are managed manually because Node's global fetch has no jar.
// We follow 3xx redirects ourselves so each Set-Cookie hop is captured.

import { CATALYST_CLIENT_ID, exchangeTicketForToken } from '../garmin/catalystClient.js'

const SSO = 'https://sso.garmin.com/sso'
const SSO_EMBED = `${SSO}/embed`

// Identical to garth.sso.PARAMS plus the `locale` Garmin started requiring.
const PARAMS: Record<string, string> = {
  id: 'gauth-widget',
  embedWidget: 'true',
  gauthHost: SSO,
  service: SSO_EMBED,
  source: SSO_EMBED,
  redirectAfterAccountLoginUrl: SSO_EMBED,
  redirectAfterAccountCreationUrl: SSO_EMBED,
  locale: 'en_US',
  mobile: 'true',
  clientId: CATALYST_CLIENT_ID,
}

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

// ---------------------------------------------------------------------------
// Cookie jar — flat name→value map; Garmin's session cookies don't share
// names across domains so this is enough without per-domain bookkeeping.

type CookieJar = Map<string, string>

function captureSetCookies(headers: Headers, jar: CookieJar): void {
  // Node's fetch (undici) exposes getSetCookie() to enumerate multiple
  // Set-Cookie headers — `headers.get` would collapse them into one string.
  const all = (headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
  if (!all) return
  for (const sc of all) {
    const pair = sc.split(';')[0]
    const i = pair.indexOf('=')
    if (i <= 0) continue
    const name = pair.slice(0, i).trim()
    const value = pair.slice(i + 1).trim()
    if (!value || value === 'deleted') {
      jar.delete(name)
    } else {
      jar.set(name, value)
    }
  }
}

function cookieHeader(jar: CookieJar): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ')
}

interface JarOpts {
  method?: 'GET' | 'POST'
  body?: string | URLSearchParams
  headers?: Record<string, string>
  referrer?: string
}

async function jarFetch(url: string, opts: JarOpts, jar: CookieJar): Promise<Response> {
  let currentUrl = url
  let method = opts.method ?? 'GET'
  let body: string | URLSearchParams | undefined = opts.body
  let extra = { ...(opts.headers ?? {}) }

  for (let hop = 0; hop < 6; hop++) {
    const headers = new Headers(extra)
    if (jar.size) headers.set('Cookie', cookieHeader(jar))
    headers.set('User-Agent', BROWSER_UA)
    if (opts.referrer && !headers.has('Referer')) headers.set('Referer', opts.referrer)
    if (!headers.has('Accept')) headers.set('Accept', 'text/html,application/xhtml+xml,*/*')

    const resp = await fetch(currentUrl, { method, body, headers, redirect: 'manual' })
    captureSetCookies(resp.headers, jar)

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('Location')
      if (!loc) return resp
      // Resolve relative; subsequent hops are always GET with no body.
      currentUrl = new URL(loc, currentUrl).toString()
      method = 'GET'
      body = undefined
      extra = {} // drop Content-Type from previous POST
      continue
    }
    return resp
  }
  throw new Error('too many redirects during Garmin SSO login')
}

// ---------------------------------------------------------------------------

function paramString(): string {
  return new URLSearchParams(PARAMS).toString()
}

function extractCsrf(html: string): string {
  const m = html.match(/name="_csrf"\s+value="([^"]+)"/i)
  if (!m) throw new Error('CSRF token not found on Garmin sign-in page')
  return m[1]
}

function extractTicket(html: string): string | null {
  // Garmin returns a meta-refresh / inline JS containing the final redirect:
  //   embed?ticket=ST-1234-abc-cas
  const m = html.match(/embed\?ticket=([^"'&\s]+)/)
  return m ? m[1] : null
}

function detectMfa(html: string): boolean {
  return /verifyMFA|loginEnterMfaCode|enter the.*code|verification code/i.test(html)
}

function detectBadCreds(html: string): boolean {
  return /password.*incorrect|invalid.*credentials|bad credentials|sign in failed|wrong.*password/i.test(html)
}

function detectAccountLocked(html: string): boolean {
  return /account.*locked|too many attempts/i.test(html)
}

// ---------------------------------------------------------------------------
// Public API

export type SignInResult =
  | { kind: 'token'; accessToken: string; expiresIn: number }
  | { kind: 'mfa'; sessionId: string }

interface PendingMfa {
  jar: CookieJar
  csrf: string
}

// Keep MFA state in-memory; single-user desktop app, no need to persist.
const pendingMfa = new Map<string, PendingMfa>()

export async function signInWithCredentials(email: string, password: string): Promise<SignInResult> {
  if (!email || !password) throw new Error('Email and password are required')

  const jar: CookieJar = new Map()
  const qs = paramString()
  const signinUrl = `${SSO}/signin?${qs}`
  const embedUrl = `${SSO_EMBED}?${qs}`

  // 1) Touch the embed URL so Garmin sets its first batch of cookies.
  await jarFetch(embedUrl, { method: 'GET' }, jar)

  // 2) Load the sign-in page to harvest the hidden _csrf token.
  const csrfResp = await jarFetch(signinUrl, { method: 'GET', referrer: embedUrl }, jar)
  const csrfHtml = await csrfResp.text()
  const csrf = extractCsrf(csrfHtml)

  // 3) POST credentials. The same URL handles both first-step and the
  //    "username then password" two-step flow — garth just posts both fields
  //    together and Garmin accepts it.
  const body = new URLSearchParams({
    username: email,
    password,
    embed: 'true',
    _csrf: csrf,
  })
  const resp = await jarFetch(signinUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    referrer: signinUrl,
  }, jar)
  const html = await resp.text()

  // 4) MFA path?
  if (detectMfa(html)) {
    const sessionId = `mfa_${Date.now()}_${Math.random().toString(36).slice(2)}`
    pendingMfa.set(sessionId, { jar, csrf })
    return { kind: 'mfa', sessionId }
  }

  // 5) Direct ticket path.
  const ticket = extractTicket(html)
  if (!ticket) {
    if (detectAccountLocked(html)) throw new Error('Garmin says this account is locked — sign in via the Garmin Connect website first.')
    if (detectBadCreds(html)) throw new Error('Invalid email or password.')
    throw new Error('Sign-in completed but no service ticket was returned. Garmin may have changed the SSO response format.')
  }
  const tok = await exchangeTicketForToken(ticket, SSO_EMBED)
  return { kind: 'token', accessToken: tok.accessToken, expiresIn: tok.expiresIn }
}

export async function submitMfaCode(
  sessionId: string,
  code: string,
): Promise<{ accessToken: string; expiresIn: number }> {
  const pending = pendingMfa.get(sessionId)
  if (!pending) throw new Error('MFA session expired — start sign-in over.')
  pendingMfa.delete(sessionId)

  const qs = paramString()
  const mfaUrl = `${SSO}/verifyMFA/loginEnterMfaCode?${qs}`
  const body = new URLSearchParams({
    'mfa-code': code,
    embed: 'true',
    _csrf: pending.csrf,
    fromPage: 'setupEnterMfaCode',
  })
  const resp = await jarFetch(mfaUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    referrer: `${SSO}/signin?${qs}`,
  }, pending.jar)
  const html = await resp.text()

  const ticket = extractTicket(html)
  if (!ticket) {
    if (/code.*incorrect|invalid.*code/i.test(html)) throw new Error('MFA code rejected. Try again with a fresh code.')
    throw new Error('MFA verified but no service ticket was returned.')
  }
  return exchangeTicketForToken(ticket, SSO_EMBED)
}

export function cancelMfa(sessionId: string): void {
  pendingMfa.delete(sessionId)
}
