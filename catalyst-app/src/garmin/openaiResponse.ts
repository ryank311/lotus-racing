import type OpenAI from 'openai'
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses'

// Keep the background job alive across transport failures. Only a completed
// response is returned; partial tool arguments are progress, never a report.
export async function receiveOpenAiResponse(
  client: OpenAI,
  request: ResponseCreateParamsNonStreaming,
  onChunk: (text: string) => void,
  streaming: boolean,
  isTransient: (error: unknown) => boolean,
): Promise<Response> {
  const started = Date.now()
  const deadline = new AbortController()
  const timeout = setTimeout(() => deadline.abort(), 15 * 60_000)
  let phase = 'Connecting to OpenAI'
  let reportChars = 0
  let lastProgress = 0
  let responseId: string | undefined
  let cursor: number | undefined
  const reportItems = new Set<string>()
  const progress = () => {
    lastProgress = Date.now()
    onChunk(`[status] ${phase} · ${Math.floor((Date.now() - started) / 1000)}s elapsed${reportChars ? ` · ${reportChars.toLocaleString()} report chars received` : ''}\n`)
  }
  const setPhase = (next: string) => {
    if (next === phase) return
    phase = next
    progress()
  }
  const statusTimer = setInterval(progress, 4000)
  progress()
  try {
    if (!streaming) {
      let response = await client.responses.create(request, { signal: deadline.signal })
      while (response.status === 'queued' || response.status === 'in_progress') {
        if (!response.id) throw new Error('OpenAI started the coaching analysis but did not return a response ID')
        setPhase(response.status === 'queued' ? 'Queued at OpenAI' : 'Analysis in progress; waiting for model output')
        await new Promise<void>(resolve => setTimeout(resolve, 2000))
        response = await client.responses.retrieve(response.id, {}, { signal: deadline.signal })
      }
      return response
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
      // The SDK's request timeout covers headers, not an idle SSE body. Abort
      // stalled streams too, then resume the same job from its last event.
      const connection = new AbortController()
      const signal = AbortSignal.any([deadline.signal, connection.signal])
      let idleTimer: ReturnType<typeof setTimeout>
      const resetIdle = () => {
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => connection.abort(), 5 * 60_000)
      }
      resetIdle()
      try {
        const stream = responseId
          ? await client.responses.retrieve(responseId, { stream: true, starting_after: cursor }, { signal })
          : await client.responses.create({ ...request, stream: true }, { signal })
        for await (const event of stream) {
          resetIdle()
          if (cursor !== undefined && event.sequence_number <= cursor) continue
          cursor = event.sequence_number
          switch (event.type) {
            case 'response.created':
            case 'response.queued':
            case 'response.in_progress':
              responseId = event.response.id
              setPhase(event.response.status === 'queued' ? 'Queued at OpenAI' : 'Analysis in progress; waiting for model output')
              break
            case 'response.output_item.added':
              if (event.item.type === 'reasoning') setPhase('Model is thinking')
              if (event.item.type === 'function_call' &&
                  (typeof request.tool_choice !== 'object' || request.tool_choice.type !== 'function' || event.item.name === request.tool_choice.name)) {
                reportItems.add(event.item.id!)
                setPhase('Receiving coaching report')
              }
              break
            case 'response.function_call_arguments.delta':
              if (reportItems.has(event.item_id)) {
                reportChars += event.delta.length
                setPhase('Receiving coaching report')
                if (reportChars === event.delta.length || Date.now() - lastProgress >= 1000) progress()
              }
              break
            case 'response.output_text.delta':
              setPhase('Receiving model response')
              break
            case 'response.completed':
            case 'response.failed':
            case 'response.incomplete':
              return event.response
            case 'error':
              throw Object.assign(new Error(`OpenAI stream error: ${event.message}`), {
                retryable: false,
              })
          }
        }
        throw Object.assign(new Error('OpenAI stream ended before the report was complete'), { code: 'ECONNRESET' })
      } catch (error) {
        if (deadline.signal.aborted) throw error
        if (connection.signal.aborted) {
          error = Object.assign(new Error('OpenAI received no data for 5 minutes while waiting for the coaching report'), { code: 'ETIMEDOUT' })
        }
        // Never create a replacement analysis after an interrupted stream:
        // without its ID we cannot safely recover the existing model job.
        if (!responseId || attempt === 3 || (!connection.signal.aborted && !isTransient(error))) throw error
        setPhase(`Connection interrupted; reconnecting to analysis (${attempt}/2)`)
      } finally {
        clearTimeout(idleTimer!)
        connection.abort()
      }
    }
    throw new Error('OpenAI analysis could not be resumed')
  } catch (error) {
    if (deadline.signal.aborted) throw new Error('OpenAI analysis did not finish within 15 minutes')
    throw error
  } finally {
    clearTimeout(timeout)
    clearInterval(statusTimer)
  }
}
