import { useState } from 'react'
import { api } from '../api'
import {
  Account,
  AccountState,
  daysRemaining,
  removeAccount,
  setActiveAccount,
  tokenValid,
  upsertAccount,
} from '../accounts'

interface Props {
  state: AccountState
  onChange: (next: AccountState) => void
}

export function AccountWidget({ state, onChange }: Props) {
  const [showAdd, setShowAdd] = useState(false)
  const [initialEmail, setInitialEmail] = useState('')

  const active = state.accounts.find(a => a.label === state.activeLabel) ?? null

  const openAdd = (email = '') => {
    setInitialEmail(email)
    setShowAdd(true)
  }

  const handleSignedIn = (label: string, token: string, expiresAt: number) => {
    onChange(upsertAccount(label, token, expiresAt))
    setShowAdd(false)
  }

  const signOut = (label: string) => {
    if (!confirm(`Remove account "${label}" and its token?`)) return
    onChange(removeAccount(label))
  }

  const switchTo = (label: string) => {
    onChange(setActiveAccount(label))
  }

  return (
    <div className="card" style={{ padding: '20px 22px 18px' }}>
      <div className="card-label">Account</div>
      <div className="card-corner-marks"><i /></div>

      {state.accounts.length === 0 ? (
        <div style={{ marginTop: 8 }}>
          <div className="muted small" style={{ marginBottom: 10 }}>
            Sign in with your Garmin Connect credentials to sync Catalyst sessions.
            Your password is sent only to Garmin's SSO and is never stored.
          </div>
          {showAdd ? (
            <SignInForm
              initialEmail={initialEmail}
              onCancel={() => setShowAdd(false)}
              onSignedIn={handleSignedIn}
            />
          ) : (
            <button className="btn primary" onClick={() => openAdd()}>Sign in</button>
          )}
        </div>
      ) : (
        <>
          <table className="tbl" style={{ background: 'transparent', border: 0, marginTop: 4 }}>
            <tbody>
              {state.accounts.map(a => (
                <AccountRow
                  key={a.label}
                  acct={a}
                  active={a.label === state.activeLabel}
                  onSwitch={() => switchTo(a.label)}
                  onRemove={() => signOut(a.label)}
                />
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {showAdd ? (
              <SignInForm
                initialEmail={initialEmail}
                onCancel={() => setShowAdd(false)}
                onSignedIn={handleSignedIn}
              />
            ) : (
              <>
                <button className="btn ghost" onClick={() => openAdd()}>+ Add account</button>
                {active && !tokenValid(active) && (
                  <button
                    className="btn primary"
                    onClick={() => openAdd(active.label)}
                  >
                    Re-auth {active.label}
                  </button>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function AccountRow({
  acct, active, onSwitch, onRemove,
}: { acct: Account; active: boolean; onSwitch: () => void; onRemove: () => void }) {
  const valid = tokenValid(acct)
  const days = daysRemaining(acct)
  const status = valid
    ? { cls: 'ok', text: days != null ? `${days}d` : 'valid' }
    : { cls: 'err', text: 'expired' }
  return (
    <tr style={{ cursor: 'pointer' }} onClick={onSwitch}>
      <td className="num" style={{ borderBottom: 0, paddingLeft: 0, color: active ? 'var(--signal)' : 'var(--text)' }}>
        {active ? '●' : '○'} {acct.label}
      </td>
      <td className="num" style={{ borderBottom: 0 }}>
        <span className={`pill ${status.cls}`}>{status.text}</span>
      </td>
      <td className="num" style={{ borderBottom: 0, textAlign: 'right' }}>
        <button
          className="btn tiny ghost"
          onClick={e => { e.stopPropagation(); onRemove() }}
        >Sign out</button>
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Sign-in form — two states: (1) email + password, (2) MFA code input.
// Talks directly to the no-browser garth-equivalent flow in the main process.

interface SignInFormProps {
  initialEmail: string
  onCancel: () => void
  onSignedIn: (label: string, token: string, expiresAt: number) => void
}

function SignInForm({ initialEmail, onCancel, onSignedIn }: SignInFormProps) {
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
    onCancel()
  }

  if (mfa) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
        <div className="muted small">
          Garmin sent a verification code to <strong style={{ color: 'var(--text)' }}>{email}</strong>. Enter it below.
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
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
            style={{ flex: '1 1 160px', minWidth: 140, letterSpacing: '0.2em', fontFamily: 'var(--font-mono)' }}
          />
          <button className="btn primary" disabled={busy || !code.trim()} onClick={submitMfa}>
            {busy ? 'Verifying…' : 'Verify'}
          </button>
          <button className="btn ghost" disabled={busy} onClick={cancel}>Cancel</button>
        </div>
        {err && <div style={{ color: 'var(--red)', fontSize: 11 }}>{err}</div>}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          autoFocus
          type="email"
          placeholder="Garmin Connect email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submit() }}
          disabled={busy}
          className="text-input"
        />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void submit() }}
          disabled={busy}
          className="text-input"
        />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={busy || !email.trim() || !password} onClick={submit}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={cancel}>Cancel</button>
      </div>
      {err && <div style={{ color: 'var(--red)', fontSize: 11 }}>{err}</div>}
    </div>
  )
}
