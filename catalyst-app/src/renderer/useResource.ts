import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'

interface ResourceState<T> {
  scope: string
  data: T | undefined
  pending: boolean
  error: string | null
}

/** Keep successful values during refresh, but never across a different data scope. */
export function useResource<T>(loader: () => Promise<T>, scope = '', revision?: unknown) {
  const [state, setState] = useState<ResourceState<T>>({ scope, data: undefined, pending: true, error: null })
  const latest = useRef({ loader, scope })
  latest.current = { loader, scope }
  const request = useRef(0)
  const reload = useCallback(async () => {
    const sequence = ++request.current
    const current = () => sequence === request.current && scope === latest.current.scope
    setState(previous => ({ scope, data: previous.scope === scope ? previous.data : undefined, pending: true, error: null }))
    try {
      const data = await latest.current.loader()
      if (current()) setState({ scope, data, pending: false, error: null })
    } catch (error) {
      if (current()) setState(previous => ({ ...previous, pending: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }, [scope])
  useEffect(() => {
    void reload()
    return () => { request.current++ }
  }, [reload, revision])
  const setData = useCallback((value: SetStateAction<T | undefined>) => {
    setState(previous => {
      if (previous.scope !== scope) return previous
      const data = typeof value === 'function' ? (value as (old: T | undefined) => T | undefined)(previous.data) : value
      return { ...previous, data }
    })
  }, [scope])
  const visible = state.scope === scope ? state : { scope, data: undefined, pending: true, error: null }
  return { ...visible, initialLoading: visible.pending && visible.data === undefined, reload, setData }
}
