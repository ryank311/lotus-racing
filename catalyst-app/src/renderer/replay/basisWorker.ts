// A worker of the app's own for three's Basis transcoder (KTX2Loader).
//
// KTX2Loader starts its workers from blob: URLs, and a blob: worker keeps
// the page's Content-Security-Policy, which allows no eval; the transcoder
// (Emscripten, with embind) builds functions from strings, so it failed
// there and the worker swallowed the error: models with KTX2 textures never
// finished loading. This worker is a script of the app's own origin, so the
// page's policy does not reach into it; ktx2.ts sends it KTX2Loader's worker
// source (the transcoder and its message handler) to run.
//
// If the transcoder still cannot start, every texture asked of it fails
// with that reason instead of waiting for ever.

interface Scope {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: string, listener: (event: MessageEvent & PromiseRejectionEvent & ErrorEvent) => void): void
  removeEventListener(type: string, listener: (event: MessageEvent) => void): void
}
const scope = globalThis as unknown as Scope

const waiting = new Set<number>()
let failed: string | null = null
const post = scope.postMessage.bind(scope)

// Every reply carries the id it answers.
scope.postMessage = (message: unknown, transfer?: Transferable[]) => {
  const id = (message as { id?: number } | null)?.id
  if (id != null) waiting.delete(id)
  post(message, transfer)
}

function fail(reason: unknown) {
  if (failed) return
  failed = String((reason as Error | null)?.message ?? reason ?? 'unknown error')
  for (const id of waiting) post({ type: 'error', id, error: `Basis transcoder unavailable: ${failed}` })
  waiting.clear()
}

scope.addEventListener('message', event => {
  const message = event.data as { type?: string; id?: number }
  if (message?.type !== 'transcode' || message.id == null) return
  if (failed) post({ type: 'error', id: message.id, error: `Basis transcoder unavailable: ${failed}` })
  else waiting.add(message.id)
})
scope.addEventListener('unhandledrejection', event => fail(event.reason))
scope.addEventListener('error', event => fail(event.message))

function boot(event: MessageEvent) {
  const message = event.data as { type?: string; body?: string }
  if (message?.type !== 'bootstrap') return
  scope.removeEventListener('message', boot)
  try {
    // Indirect: KTX2Loader's worker source runs as a script in this scope.
    ;(0, eval)(message.body ?? '')
  } catch (error) { fail(error) }
}
scope.addEventListener('message', boot as (event: MessageEvent & PromiseRejectionEvent & ErrorEvent) => void)

export {}
