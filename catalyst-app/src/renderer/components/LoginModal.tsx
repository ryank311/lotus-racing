// Garmin sign-in: existing credentials/MFA flow or Garmin's hosted SSO UI.

import { useEffect, useRef, useState } from 'react'
import { api, isRemote, signInWithGarminSso } from '../api'
import { Modal } from './Modal'

interface Props {
  initialEmail?: string
  onClose: () => void
  onSignedIn: (label: string, token: string, expiresAt: number) => void
}

export function LoginModal({ initialEmail = '', onClose, onSignedIn }: Props) {
  const [method, setMethod] = useState<'password' | 'sso'>('password')
  const ssoAbort = useRef<AbortController | null>(null)
  useEffect(() => () => ssoAbort.current?.abort(), [])
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [mfa, setMfa] = useState<{ sessionId: string } | null>(null)
  const [code, setCode] = useState('')

  const submit = async () => {
    if (busy) return
    if (!email.trim() || !password) { setErr('Enter email and password'); return }
    setBusy(true); setErr(null)
    try {
      const r = await api.signInWithCreds(email.trim(), password)
      if (r.needsMfa) {
        setMfa({ sessionId: r.sessionId })
        setPassword('')  // wipe pw from memory once Garmin has it
      } else {
        onSignedIn(email.trim(), r.token, r.expiresAt)
      }
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitMfa = async () => {
    if (busy) return
    if (!mfa || !code.trim()) { setErr('Enter the MFA code'); return }
    setBusy(true); setErr(null)
    try {
      const r = await api.signInMfa(mfa.sessionId, code.trim())
      onSignedIn(email.trim(), r.token, r.expiresAt)
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const submitSso = async () => {
    if (busy) return
    setBusy(true); setErr(null); setPassword('')
    const controller = new AbortController()
    ssoAbort.current = controller
    try {
      const result = await signInWithGarminSso(controller.signal)
      if (!controller.signal.aborted) onSignedIn(email.trim(), result.token, result.expiresAt)
    } catch (error: any) {
      if (!controller.signal.aborted) setErr(error.message ?? String(error))
    } finally {
      ssoAbort.current = null
      setBusy(false)
    }
  }

  const cancel = async () => {
    ssoAbort.current?.abort()
    if (mfa) { try { await api.cancelMfa(mfa.sessionId) } catch { /* ignore */ } }
    onClose()
  }

  if (mfa) {
    return (
      <Modal
        eyebrow="// garmin connect"
        title="Enter verification code"
        onClose={cancel}
        dismissable={!busy}
        actions={<>
          <button className="btn ghost" disabled={busy} onClick={cancel}>Cancel</button>
          <button className="btn primary" disabled={busy || !code.trim()} onClick={submitMfa}>
            {busy ? 'Verifying…' : 'Verify'}
          </button>
        </>}
      >
        <div style={{ marginBottom: 10 }}>
          Garmin sent a verification code to <strong style={{ color: 'var(--text)' }}>{email}</strong>. Enter it below.
        </div>
        <input
          autoFocus
          type="text"
          inputMode="numeric"
          placeholder="6-digit code"
          value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
          onKeyDown={e => { if (e.key === 'Enter') void submitMfa() }}
          disabled={busy}
          className="text-input"
          style={{ width: '100%', letterSpacing: '0.2em', fontFamily: 'var(--font-mono)' }}
        />
        {err && <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 8 }}>{err}</div>}
      </Modal>
    )
  }

  return (
    <Modal
      eyebrow="// garmin connect"
      title="Sign in"
      onClose={cancel}
      dismissable={!busy}
      actions={<>
        <button className="btn ghost" disabled={busy && !(method === 'sso' && isRemote)} onClick={cancel}>Cancel</button>
        <button className="btn primary" disabled={busy || !email.trim() || (method === 'password' && !password)} onClick={method === 'sso' ? submitSso : submit}>
          {busy ? (method === 'sso' ? 'Waiting for Garmin…' : 'Signing in…') : (method === 'sso' ? 'Continue with Garmin SSO' : 'Sign in')}
        </button>
      </>}
    >
      <div role="group" aria-label="Sign-in method" style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className={`btn ${method === 'password' ? 'primary' : 'ghost'}`} aria-pressed={method === 'password'} disabled={busy} onClick={() => { setMethod('password'); setErr(null) }}>Email / password</button>
        <button className={`btn ${method === 'sso' ? 'primary' : 'ghost'}`} aria-pressed={method === 'sso'} disabled={busy} onClick={() => { setMethod('sso'); setPassword(''); setErr(null) }}>Garmin SSO · experimental</button>
      </div>
      <div style={{ marginBottom: 12, color: 'var(--text-mute)', fontSize: 12 }}>
        {method === 'sso'
          ? 'Sign in on Garmin’s website in a separate window. Garmin handles your password and verification steps. Enter the account email below to label this connection; use the same account on Garmin.'
          : <>Sign in with your Garmin Connect credentials to sync Catalyst sessions. Your password is {isRemote ? 'relayed by this Catalyst server to' : 'sent only to'} Garmin’s SSO and is never stored.</>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input
          autoFocus
          type="email"
          placeholder="Garmin Connect email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void (method === 'sso' ? submitSso() : submit()) }}
          disabled={busy}
          className="text-input"
          style={{ width: '100%' }}
        />
        {method === 'password' && <input
          type="password"
          placeholder="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submit() }}
          disabled={busy}
          className="text-input"
          style={{ width: '100%' }}
        />}
      </div>
      {busy && method === 'sso' && <div role="status" style={{ marginTop: 10 }}>Complete sign-in in the Garmin window, then return here.{!isRemote && ' Close the Garmin window to cancel.'}</div>}
      {err && <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 8 }}>{err}</div>}
    </Modal>
  )
}
