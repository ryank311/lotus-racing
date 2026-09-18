// Garmin sign-in: existing credentials/MFA flow or Garmin's hosted SSO UI.

import { useEffect, useId, useRef, useState } from 'react'
import { api, isRemote, signInWithGarminSso } from '../api'
import { Modal } from './Modal'

interface Props {
  initialEmail?: string
  onClose: () => void
  onSignedIn: (label: string, token: string, expiresAt: number) => void
}

export function LoginModal({ initialEmail = '', onClose, onSignedIn }: Props) {
  const tabsId = useId()
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
      onSignedIn('Garmin SSO', result.token, result.expiresAt)
    } catch (error: any) {
      if (controller.signal.aborted) onClose()
      else setErr(error.message ?? String(error))
    } finally {
      ssoAbort.current = null
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (ssoAbort.current) { ssoAbort.current.abort(); return }
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
        <button className="btn primary" disabled={busy || (method === 'password' && (!email.trim() || !password))} onClick={method === 'sso' ? submitSso : submit}>
          {busy ? (method === 'sso' ? 'Waiting for Garmin…' : 'Signing in…') : (method === 'sso' ? 'Continue with Garmin' : 'Sign in')}
        </button>
      </>}
    >
      <div className="login-tabs" role="tablist" aria-label="Sign-in method">
        {(['password', 'sso'] as const).map((value, index) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${tabsId}-${value}`}
            aria-selected={method === value}
            aria-controls={`${tabsId}-panel`}
            tabIndex={method === value ? 0 : -1}
            disabled={busy}
            onClick={() => { setMethod(value); setErr(null); if (value === 'sso') setPassword('') }}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index
              setMethod(next === 0 ? 'password' : 'sso'); setErr(null)
              if (next === 1) setPassword('')
              const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
              tabs?.[next].focus()
            }}
          >
            {value === 'password' ? 'Email / password' : 'Garmin SSO'}
          </button>
        ))}
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${method}`}>
        <div className="login-description">
          {method === 'sso'
            ? <>Sign in securely on Garmin’s website in a separate window. Garmin handles your credentials and verification.<span className="login-experimental">Experimental sign-in option</span></>
            : <>Sign in with your Garmin Connect credentials to sync Catalyst sessions. Your password is {isRemote ? 'relayed by this Catalyst server to' : 'sent only to'} Garmin’s SSO and is never stored.</>}
        </div>
        {method === 'password' && <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            type="email"
            placeholder="Garmin Connect email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void submit() }}
            disabled={busy}
            className="text-input"
            style={{ width: '100%' }}
          />
          <input
            type="password"
            placeholder="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void submit() }}
            disabled={busy}
            className="text-input"
            style={{ width: '100%' }}
          />
        </div>}
      </div>
      {busy && method === 'sso' && <div role="status" style={{ marginTop: 10 }}>Complete sign-in in the Garmin window, then return here.{!isRemote && ' Close the Garmin window to cancel.'}</div>}
      {err && <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 8 }}>{err}</div>}
    </Modal>
  )
}
