// Garmin sign-in modal — email/password with a follow-up MFA step. Credentials
// go straight to Garmin's SSO via the main process and are never stored.

import { useState } from 'react'
import { api } from '../api'
import { Modal } from './Modal'

interface Props {
  initialEmail?: string
  onClose: () => void
  onSignedIn: (label: string, token: string, expiresAt: number) => void
}

export function LoginModal({ initialEmail = '', onClose, onSignedIn }: Props) {
  const [email, setEmail] = useState(initialEmail)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [mfa, setMfa] = useState<{ sessionId: string } | null>(null)
  const [code, setCode] = useState('')

  const submit = async () => {
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

  const cancel = async () => {
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
        <button className="btn ghost" disabled={busy} onClick={cancel}>Cancel</button>
        <button className="btn primary" disabled={busy || !email.trim() || !password} onClick={submit}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </>}
    >
      <div style={{ marginBottom: 12, color: 'var(--text-mute)', fontSize: 12 }}>
        Sign in with your Garmin Connect credentials to sync Catalyst sessions. Your
        password is sent only to Garmin's SSO and is never stored.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input
          autoFocus
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
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 8 }}>{err}</div>}
    </Modal>
  )
}
