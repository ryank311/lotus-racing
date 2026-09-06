import { useEffect, useState } from 'react'
import { getServerSession, isRemote, loginToServer, logoutFromServer } from '../api'

export function ServerGate({ children }: { children: JSX.Element }) {
  const [username, setUsername] = useState<string | null>(isRemote ? null : '')
  const [loading, setLoading] = useState(isRemote)
  const [entry, setEntry] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isRemote) return
    void getServerSession().then(session => {
      setUsername(session?.username ?? null)
      setLoading(false)
    })
  }, [])

  if (!isRemote) return children
  if (loading) return <div className="server-login-loading">Connecting to Catalyst Coach…</div>

  if (!username) {
    const submit = async (event: React.FormEvent) => {
      event.preventDefault()
      if (!entry.trim()) return
      setBusy(true); setError(null)
      try {
        const session = await loginToServer(entry.trim())
        setUsername(session.username)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
      }
    }
    return (
      <main className="server-login-page">
        <div className="server-login-card">
          <div className="brand-mark server-login-mark" />
          <div className="page-eyebrow">// remote paddock</div>
          <h1>Catalyst <span>Coach</span></h1>
          <p>Enter your driver name. A private workspace will be created automatically the first time you connect.</p>
          <form onSubmit={submit}>
            <label htmlFor="server-username">Driver name</label>
            <input
              id="server-username"
              value={entry}
              onChange={e => setEntry(e.target.value)}
              autoFocus
              autoComplete="username"
              maxLength={40}
              placeholder="Ryan"
            />
            {error && <div className="server-login-error">{error}</div>}
            <button className="btn primary" disabled={busy || !entry.trim()}>
              {busy ? 'Connecting…' : 'Login or create account'}
            </button>
          </form>
          <div className="server-login-note">No password is required. Anyone who knows a driver name can open that workspace.</div>
        </div>
      </main>
    )
  }

  return (
    <>
      {children}
      <button
        className="server-user-chip"
        title="Switch Catalyst server user"
        onClick={() => {
          void logoutFromServer().finally(() => {
            setUsername(null)
            setEntry(username)
          })
        }}
      >
        server · {username} · switch
      </button>
    </>
  )
}

