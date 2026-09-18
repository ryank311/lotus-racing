import { createContext, useContext, useEffect, useState } from 'react'
import { getServerSession, isRemote, loginToServer, logoutFromServer } from '../api'

const desktopDriver = new URLSearchParams(window.location.search).get('desktopDriver')
const rememberedUsernameKey = 'catalyst-server-username'
const ServerSessionContext = createContext<{ username: string; switchUser: () => void } | null>(null)

export function ServerUserSwitcher() {
  const session = useContext(ServerSessionContext)
  if (!session) return null
  return (
    <button
      type="button"
      className="server-user-chip"
      title={`Server user: ${session.username}. Switch user`}
      aria-label={`Switch server user (currently ${session.username})`}
      onClick={session.switchUser}
    >
      <span>server ·</span>
      <span className="server-user-name">{session.username}</span>
      <span>· switch</span>
    </button>
  )
}

function initialUsername(): string {
  if (desktopDriver) return desktopDriver
  if (!isRemote) return ''
  try { return localStorage.getItem(rememberedUsernameKey) ?? '' } catch { return '' }
}

export function ServerGate({ children }: { children: JSX.Element }) {
  const [username, setUsername] = useState<string | null>(isRemote ? null : '')
  const [loading, setLoading] = useState(isRemote)
  const [entry, setEntry] = useState(initialUsername)
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
    const submit = async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      // Read the field directly so browser autofill works even without a React change event.
      const submittedUsername = String(new FormData(event.currentTarget).get('username') ?? '').trim()
      if (!submittedUsername) return
      setBusy(true); setError(null)
      try {
        const session = await loginToServer(submittedUsername)
        // Passwordless forms are not always saved by browser autofill.
        try { localStorage.setItem(rememberedUsernameKey, session.username) } catch { /* Storage may be disabled. */ }
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
          {desktopDriver && <p>Your existing desktop data is available as <strong>{desktopDriver}</strong>. Use this driver name on your other devices to share it.</p>}
          <form name="server-login" autoComplete="on" onSubmit={submit}>
            <label htmlFor="server-username">Driver name</label>
            <input
              id="server-username"
              name="username"
              type="text"
              value={entry}
              onChange={e => setEntry(e.target.value)}
              autoFocus
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              maxLength={40}
              placeholder="Username"
            />
            {error && <div className="server-login-error">{error}</div>}
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? 'Connecting…' : 'Login or create account'}
            </button>
          </form>
          <div className="server-login-note">No password is required. Anyone who knows a driver name can open that workspace.</div>
        </div>
      </main>
    )
  }

  return (
    <ServerSessionContext.Provider value={{
      username,
      switchUser: () => {
        void logoutFromServer().finally(() => {
          setUsername(null)
          setEntry(username)
        })
      },
    }}>
      {children}
    </ServerSessionContext.Provider>
  )
}
