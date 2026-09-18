import { createContext, type MutableRefObject } from 'react'

// Keep context identity outside the hot-reloaded component/hook module. The
// router retains its root element while Vite replaces the hooks that consume it.
export type NavigationGuard = { dirty: boolean; save: () => Promise<boolean>; scope: (url: string) => string }
export type NavigationOptions = { replace?: boolean; state?: Record<string, unknown> }
export const NavigationContext = createContext<{
  go: (url: string, options?: NavigationOptions) => void
  query: (values: Record<string, string | string[] | null>) => void
  guard: MutableRefObject<NavigationGuard | null>
  error: string | null
  clearWorkspace: () => void
  lastSessions: () => string
} | null>(null)
