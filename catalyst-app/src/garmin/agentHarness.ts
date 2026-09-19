// Agent harness — sends a prompt to the selected remote provider and returns a
// structured coaching response. Main-process only — never imported in renderer.

import https from 'node:https'
import { StringDecoder } from 'node:string_decoder'
import { AnthropicStream, checkAnthropicStopReason } from './anthropicStream.js'
import OpenAI from 'openai'
import { receiveOpenAiResponse } from './openaiResponse.js'
import type {
  FunctionTool,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
} from 'openai/resources/responses/responses'

export interface HarnessConfig {
  provider: 'anthropic' | 'openai'
  apiKey: string
  model: string
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  maxTokens?: number
  stream?: boolean
  tools?: object[]
  toolChoice?: { type: 'tool'; name: string }
}

export async function runAgent(
  prompt: string,
  config: HarnessConfig,
  onChunk: (text: string) => void,
): Promise<string> {
  const maxTokens = config.maxTokens ?? 32000
  if (config.provider === 'openai') {
    // Stream background runs so progress is visible and dropped connections
    // can resume without discarding several minutes of model work.
    return runOpenAI(
      prompt, config.apiKey, config.model, onChunk, maxTokens,
      config.tools, config.toolChoice, config.reasoningEffort ?? 'xhigh', config.stream ?? true,
    )
  }

  const maxAttempts = 3
  const deadline = Date.now() + 15 * 60_000

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (Date.now() >= deadline) throw new Error('Anthropic analysis exceeded the 15-minute total limit, including retries')
    try {
      return await runAnthropic(
        prompt, config.apiKey, config.model, onChunk, maxTokens,
        config.stream ?? true, deadline, config.tools, config.toolChoice,
      )
    } catch (error) {
      if (!isTransientProviderError(error) || attempt === maxAttempts) {
        if (isTransientProviderError(error)) {
          throw providerConnectionError(config.provider, error, attempt)
        }
        throw error
      }

      const delayMs = attempt === 1 ? 1200 : 3000
      onChunk(`[status] Anthropic connection interrupted · retrying ${attempt + 1}/${maxAttempts}…\n`)
      onChunk(`[diag] transient provider error: ${errorMessage(error)}\n`)
      await wait(delayMs)
    }
  }

  throw new Error('Coaching request failed unexpectedly')
}

const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENETDOWN', 'ENETRESET', 'ENETUNREACH', 'EHOSTDOWN', 'EHOSTUNREACH',
])

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const cause = error instanceof Error && error.cause instanceof Error
    ? error.cause.message
    : ''
  return cause && cause !== message ? `${message}: ${cause}` : message
}

export function isTransientProviderError(error: unknown): boolean {
  const errorObj = typeof error === 'object' && error !== null
    ? error as { code?: unknown; status?: unknown; name?: unknown; cause?: unknown; retryable?: boolean }
    : null
  if (errorObj?.retryable === false) return false
  const causeObj = typeof errorObj?.cause === 'object' && errorObj.cause !== null
    ? errorObj.cause as { code?: unknown }
    : null
  const code = String(errorObj?.code ?? causeObj?.code ?? '')
  if (TRANSIENT_NETWORK_CODES.has(code)) return true

  const status = Number(errorObj?.status)
  if (status === 408 || status === 409 || status === 429 || status >= 500) return true

  const name = String(errorObj?.name ?? '')
  if (name === 'APIConnectionError' || name === 'APIConnectionTimeoutError') return true

  const message = errorMessage(error)
  return /socket hang up|network socket disconnected|connection (?:closed|reset|error)|timed? out|fetch failed/i.test(message)
    || /(?:OpenAI|Anthropic) API (?:408|409|429|5\d\d)\b/i.test(message)
}

function providerConnectionError(provider: HarnessConfig['provider'], error: unknown, attempts: number): Error {
  const label = provider === 'openai' ? 'OpenAI' : 'Anthropic'
  const detail = errorMessage(error)
  return new Error(
    `${label} connection failed after ${attempts} attempts (${detail}). ` +
    `Check the internet connection, VPN/firewall, and provider status, then try again. ` +
    `If it continues, run coaching with the Top 3 lap filter to reduce the request size.`,
  )
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── Anthropic Messages API (SSE streaming) ──────────────────────────────────

function runAnthropic(
  prompt: string,
  apiKey: string,
  model: string,
  onChunk: (text: string) => void,
  maxTokens: number,
  stream: boolean,
  deadline: number,
  tools?: object[],
  toolChoice?: { type: 'tool'; name: string },
): Promise<string> {
  const reqObj: Record<string, unknown> = {
    model, max_tokens: maxTokens, stream,
    messages: [{ role: 'user', content: prompt }],
  }
  if (tools?.length) {
    reqObj.tools = tools
    // Fable 5.1 rejects forced tool use; auto allows its adaptive thinking.
    reqObj.tool_choice = model === 'claude-fable-5-1'
      ? { type: 'auto', disable_parallel_tool_use: true }
      : toolChoice ?? { type: 'any' }
  }
  const body = JSON.stringify(reqObj)
  onChunk(`[diag] model=${model} max_tokens=${maxTokens} stream=${stream} prompt=${(Buffer.byteLength(prompt) / 1024).toFixed(1)}KB\n`)

  return new Promise((resolve, reject) => {
    const requestStart = Date.now()
    let settled = false
    let phase = 'Connecting to Anthropic'
    let receivedBytes = 0
    let lastActivityAt = requestStart
    let responseReceived = false
    let requestId = ''
    let firstDelta = false
    let res: import('node:http').IncomingMessage | undefined
    let req: import('node:http').ClientRequest | undefined
    let idleTimer: ReturnType<typeof setTimeout>
    let statusTimer: ReturnType<typeof setInterval>
    let deadlineTimer: ReturnType<typeof setTimeout>
    const elapsed = () => ((Date.now() - requestStart) / 1000).toFixed(1)
    const parser = new AnthropicStream(toolChoice?.name, event => {
      if (parser.events === 1) onChunk(`[diag] first stream event: ${elapsed()}s\n`)
      if (event.type === 'message_start') {
        setPhase('Request accepted; waiting for model output')
        onChunk(`[diag] message_id=${event.message?.id ?? '?'} input_tokens=${event.message?.usage?.input_tokens ?? '?'}\n`)
      }
      if (event.type === 'content_block_start') {
        const type = event.content_block?.type
        if (type === 'thinking' || type === 'redacted_thinking') setPhase('Model is thinking')
        else if (type === 'tool_use') setPhase('Receiving coaching report')
        else if (type === 'text') setPhase('Receiving model response')
      }
      if (event.type === 'content_block_delta' && !firstDelta) {
        firstDelta = true
        onChunk(`[diag] first content delta: ${elapsed()}s\n`)
      }
      if (event.type === 'message_delta') {
        onChunk(`[diag] output_tokens=${event.usage?.output_tokens ?? '?'} stop_reason=${event.delta?.stop_reason ?? '?'}\n`)
      }
    })
    function progress(): void {
      if (settled) return
      const idle = ((Date.now() - lastActivityAt) / 1000).toFixed(0)
      const report = parser.reportChars ? ` · ${parser.reportChars.toLocaleString()} report chars` : ''
      onChunk(`[status] ${phase} · ${elapsed()}s${report}\n`)
      onChunk(`[diag] phase=${phase} elapsed=${elapsed()}s received=${(receivedBytes / 1024).toFixed(1)}KB events=${parser.events} last_event=${parser.lastEvent} idle=${idle}s report_chars=${parser.reportChars} thinking_chars=${parser.thinkingChars}\n`)
    }
    function setPhase(next: string): void {
      if (phase === next || settled) return
      phase = next
      progress()
    }
    function cleanup(): void {
      clearTimeout(idleTimer)
      clearTimeout(deadlineTimer)
      clearInterval(statusTimer)
    }
    function fail(error: Error): void {
      if (settled) return
      progress()
      settled = true
      cleanup()
      onChunk(`[error] ${error.message}${requestId ? ` (request_id=${requestId})` : ''}\n`)
      reject(error)
      res?.destroy()
      req?.destroy()
    }
    function resetIdle(): void {
      lastActivityAt = Date.now()
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => fail(Object.assign(new Error(
        `Anthropic received no data for 5 minutes while ${phase.toLowerCase()} (${elapsed()}s elapsed)`,
      ), { code: 'ETIMEDOUT' })), 300_000)
    }
    function succeed(full: string): void {
      if (settled) return
      settled = true
      cleanup()
      onChunk(`[diag] response complete: ${(Buffer.byteLength(full) / 1024).toFixed(1)}KB in ${elapsed()}s\n`)
      onChunk('[status] Parsing coaching report…\n')
      resolve(full)
      // message_stop completes SSE even if the HTTP connection stays open.
      res?.destroy()
      req?.destroy()
    }
    resetIdle()
    statusTimer = setInterval(progress, 4000)
    deadlineTimer = setTimeout(() => fail(Object.assign(new Error(
      'Anthropic analysis exceeded the 15-minute total limit, including retries. Try the Top 3 lap filter to reduce the analysis size.',
    ), { retryable: false })), Math.max(0, deadline - Date.now()))
    progress()

    try {
      req = https.request({
        hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
        headers: {
          'x-api-key': apiKey, 'anthropic-version': '2023-06-01',
          'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
          accept: stream ? 'text/event-stream' : 'application/json',
        },
      }, response => {
        res = response
        if (settled) { res.destroy(); return }
        responseReceived = true
        resetIdle()
        requestId = String(res.headers['request-id'] ?? '')
        const status = res.statusCode ?? 0
        const contentType = String(res.headers['content-type'] ?? '')
        onChunk(`[diag] HTTP ${status} headers after ${elapsed()}s${requestId ? ` request_id=${requestId}` : ''}\n`)
        setPhase('Connected; waiting for model output')
        const httpError = status < 200 || status >= 300
        let rawBody = ''
        const decoder = new StringDecoder('utf8')
        res.on('error', fail)
        res.on('aborted', () => fail(Object.assign(new Error('Anthropic response was aborted before completion'), { code: 'ECONNRESET' })))
        res.on('close', () => {
          if (!settled) fail(Object.assign(new Error('Anthropic connection closed before completion'), { code: 'ECONNRESET' }))
        })
        res.on('data', (chunk: Buffer) => {
          if (settled) return
          receivedBytes += chunk.length
          resetIdle()
          try {
            if (httpError) rawBody = (rawBody + decoder.write(chunk)).slice(0, 16_384)
            else if (stream) {
              parser.push(chunk)
              if (parser.done) succeed(parser.finish())
            } else rawBody += decoder.write(chunk)
          } catch (error) { fail(error as Error) }
        })
        res.on('end', () => {
          if (settled) return
          try {
            if (httpError) {
              throw Object.assign(new Error(`Anthropic API ${status}: ${rawBody.slice(0, 500)}`), { status })
            }
            if (stream) { succeed(parser.finish()); return }
            let result: any
            try { result = JSON.parse(rawBody + decoder.end()) } catch {
              throw new Error('Anthropic returned an invalid JSON response')
            }
            if (result.error) throw new Error(`Anthropic error: ${result.error.message ?? result.error.type}`)
            checkAnthropicStopReason(result.stop_reason)
            const tool = result.content?.find((block: any) => block.type === 'tool_use' && (!toolChoice || block.name === toolChoice.name))
            const full = tool?.input ? JSON.stringify(tool.input) : (result.content ?? [])
              .filter((block: any) => block.type === 'text').map((block: any) => block.text ?? '').join('')
            if (!full.trim()) throw new Error('Anthropic response ended without a coaching report')
            succeed(full)
          } catch (error) { fail(error as Error) }
        })
        if (!httpError && stream && !contentType.includes('text/event-stream')) {
          fail(new Error(`Anthropic returned ${contentType || 'no content type'} instead of an event stream`))
        }
      })
      req.on('finish', () => { if (!responseReceived) setPhase('Request sent; waiting for response headers') })
      req.on('error', fail)
      req.end(body)
    } catch (error) { fail(error as Error) }
  })
}

// ─── OpenAI Responses API (structured function call) ────────────────────────

const OPENAI_REQUEST_TIMEOUT_MS = 60_000
const OPENAI_MAX_RETRIES = 2

async function runOpenAI(
  prompt: string,
  apiKey: string,
  model: string,
  onChunk: (text: string) => void,
  maxTokens: number,
  tools?: object[],
  toolChoice?: { type: 'tool'; name: string },
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'xhigh',
  streaming = true,
): Promise<string> {
  // The app's canonical schema uses Anthropic's input_schema spelling. Convert
  // it at the provider boundary so both providers are constrained identically.
  const openAiTools: FunctionTool[] = (tools ?? []).map((tool: any) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema ?? tool.parameters,
    // The shared schema intentionally has optional fields, so it is not a
    // strict-schema-compatible shape. Forced function choice still guarantees
    // a machine-readable arguments object.
    strict: false,
  }))
  const reqObj: ResponseCreateParamsNonStreaming = {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    reasoning: { effort: reasoningEffort },
    max_output_tokens: maxTokens,
    // Reasoning can take several minutes. Background mode lets the provider
    // continue the job independently while a stream reconnects.
    background: true,
    store: false,
  }
  if (openAiTools.length) {
    reqObj.tools = openAiTools
    reqObj.tool_choice = toolChoice
      ? { type: 'function', name: toolChoice.name }
      : 'required'
    reqObj.parallel_tool_calls = false
  }
  onChunk(`[status] Connecting to ${model}…\n`)
  onChunk(`[diag] provider=openai mode=background stream=${streaming} model=${model} reasoning=${reasoningEffort} max_output_tokens=${maxTokens} prompt=${(prompt.length / 1024).toFixed(1)}KB\n`)

  // The SDK owns request timeouts, transient retries, response parsing, and API
  // errors. Background mode keeps the model job independent from any one request.
  const client = new OpenAI({
    apiKey,
    timeout: OPENAI_REQUEST_TIMEOUT_MS,
    maxRetries: OPENAI_MAX_RETRIES,
  })
  const requestStart = Date.now()
  const response = await receiveOpenAiResponse(client, reqObj, onChunk, streaming, isTransientProviderError)

  if (response.status === 'failed') {
    throw new Error(`OpenAI background analysis failed: ${response.error?.message ?? 'unknown provider error'}`)
  }
  if (response.status === 'cancelled') {
    throw new Error('OpenAI background analysis was cancelled')
  }
  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason ?? 'unknown reason'
    throw new Error(`OpenAI response was incomplete: ${reason}`)
  }

  if (response.status !== 'completed') throw new Error(`OpenAI did not complete the coaching report (${response.status ?? 'unknown status'})`)

  const functionCall = response.output?.find(
    (item): item is ResponseFunctionToolCall =>
      item.type === 'function_call' && (!toolChoice || item.name === toolChoice.name),
  )
  let full = typeof functionCall?.arguments === 'string' ? functionCall.arguments : ''
  if (!full) {
    full = (response.output ?? [])
      .filter((item: any) => item.type === 'message')
      .flatMap((item: any) => item.content ?? [])
      .filter((item: any) => item.type === 'output_text')
      .map((item: any) => item.text ?? '')
      .join('')
  }

  const usage = response.usage
  if (usage) {
    onChunk(`[diag] input_tokens=${usage.input_tokens ?? '?'} output_tokens=${usage.output_tokens ?? '?'} reasoning_tokens=${usage.output_tokens_details?.reasoning_tokens ?? '?'}\n`)
  }
  if (!full) throw new Error('OpenAI response ended without a coaching report')

  onChunk(`[diag] response complete: ${(full.length / 1024).toFixed(1)}KB in ${((Date.now() - requestStart) / 1000).toFixed(1)}s\n`)
  onChunk('[status] Parsing coaching report…\n')
  return full
}
