// Developer extras (frame rate, an orbit camera on O): in `vite` dev, or
// anywhere after localStorage['catalyst:replay-debug'] = '1'.
export const REPLAY_DEBUG = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true || (() => {
  try { return localStorage.getItem('catalyst:replay-debug') === '1' } catch { return false }
})()
