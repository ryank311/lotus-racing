// Renderer-side account state — persisted in localStorage.
//
// An account is a labeled Catalyst session token. Sign-in opens the SSO browser
// window (via main), receives a token, and stores it here. Sync calls pass the
// active account's token + label to the main process so synced sessions are
// tagged with that account in the DB.

const LS_KEY = 'catalyst.accounts.v1'

export interface Account {
  label: string          // user-facing identifier (typically email)
  token: string          // Catalyst OAuth2 bearer
  expiresAt: number      // epoch seconds
  addedAt: number        // epoch ms (when token was stored)
}

export interface AccountState {
  accounts: Account[]
  activeLabel: string | null
}

const EMPTY: AccountState = { accounts: [], activeLabel: null }

export function loadAccounts(): AccountState {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw)
    if (!parsed || !Array.isArray(parsed.accounts)) return EMPTY
    return parsed as AccountState
  } catch {
    return EMPTY
  }
}

export function saveAccounts(state: AccountState): void {
  localStorage.setItem(LS_KEY, JSON.stringify(state))
}

export function getActiveAccount(state?: AccountState): Account | null {
  const s = state ?? loadAccounts()
  if (!s.activeLabel) return null
  return s.accounts.find(a => a.label === s.activeLabel) ?? null
}

export function upsertAccount(label: string, token: string, expiresAt: number): AccountState {
  const s = loadAccounts()
  const i = s.accounts.findIndex(a => a.label === label)
  const acct: Account = { label, token, expiresAt, addedAt: Date.now() }
  if (i >= 0) s.accounts[i] = acct
  else s.accounts.push(acct)
  s.activeLabel = label
  saveAccounts(s)
  return s
}

export function setActiveAccount(label: string | null): AccountState {
  const s = loadAccounts()
  s.activeLabel = label && s.accounts.some(a => a.label === label) ? label : null
  saveAccounts(s)
  return s
}

export function removeAccount(label: string): AccountState {
  const s = loadAccounts()
  s.accounts = s.accounts.filter(a => a.label !== label)
  if (s.activeLabel === label) s.activeLabel = s.accounts[0]?.label ?? null
  saveAccounts(s)
  return s
}

export function tokenValid(a: Account | null): boolean {
  if (!a) return false
  return a.expiresAt - 300 > Date.now() / 1000
}

export function daysRemaining(a: Account | null): number | null {
  if (!a) return null
  return Math.max(0, Math.floor((a.expiresAt - Date.now() / 1000) / 86_400))
}
