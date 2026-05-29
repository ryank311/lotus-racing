import { useState } from 'react'
import { api } from '../api'
import {
  Account,
  AccountState,
  daysRemaining,
  loadAccounts,
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
  const [signingIn, setSigningIn] = useState(false)
  const [labelInput, setLabelInput] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const active = state.accounts.find(a => a.label === state.activeLabel) ?? null

  const signIn = async () => {
    const lbl = labelInput.trim() || (active?.label ?? '')
    if (!lbl) { setError('Enter an email or label first'); return }
    setSigningIn(true)
    setError(null)
    try {
      const { token, expiresAt } = await api.signIn()
      onChange(upsertAccount(lbl, token, expiresAt))
      setLabelInput('')
      setShowAdd(false)
    } catch (e: any) {
      setError(e.message ?? String(e))
    } finally {
      setSigningIn(false)
    }
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
            Sign in with a Garmin account to sync your Catalyst sessions.
          </div>
          {showAdd ? (
            <SignInForm
              labelInput={labelInput}
              setLabelInput={setLabelInput}
              signingIn={signingIn}
              onSignIn={signIn}
              onCancel={() => { setShowAdd(false); setError(null) }}
              error={error}
            />
          ) : (
            <button className="btn primary" onClick={() => setShowAdd(true)}>Sign in</button>
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
                labelInput={labelInput}
                setLabelInput={setLabelInput}
                signingIn={signingIn}
                onSignIn={signIn}
                onCancel={() => { setShowAdd(false); setError(null) }}
                error={error}
              />
            ) : (
              <>
                <button className="btn ghost" onClick={() => setShowAdd(true)}>+ Add account</button>
                {active && !tokenValid(active) && (
                  <button
                    className="btn primary"
                    disabled={signingIn}
                    onClick={() => { setLabelInput(active.label); setShowAdd(true) }}
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

function SignInForm({
  labelInput, setLabelInput, signingIn, onSignIn, onCancel, error,
}: {
  labelInput: string
  setLabelInput: (v: string) => void
  signingIn: boolean
  onSignIn: () => void
  onCancel: () => void
  error: string | null
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          autoFocus
          type="text"
          placeholder="account label (email)"
          value={labelInput}
          onChange={e => setLabelInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onSignIn() }}
          disabled={signingIn}
          className="text-input"
          style={{ flex: '1 1 220px', minWidth: 180 }}
        />
        <button className="btn primary" disabled={signingIn} onClick={onSignIn}>
          {signingIn ? 'Opening Garmin…' : 'Sign in'}
        </button>
        <button className="btn ghost" disabled={signingIn} onClick={onCancel}>Cancel</button>
      </div>
      {error && <div style={{ color: 'var(--red)', fontSize: 11 }}>{error}</div>}
    </div>
  )
}
