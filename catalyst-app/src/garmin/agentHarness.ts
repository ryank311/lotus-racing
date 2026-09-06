// Agent harness — sends a prompt to the selected remote provider and returns a
// structured coaching response. Main-process only — never imported in renderer.

import https from 'node:https'

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
    // OpenAI reasoning runs use background mode and short polling requests, so
    // a dropped connection never discards several minutes of model work.
    return runOpenAI(
      prompt, config.apiKey, config.model, onChunk, maxTokens,
      config.tools, config.toolChoice, config.reasoningEffort ?? 'xhigh',
    )
  }

  const maxAttempts = 3

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runAnthropic(
        prompt, config.apiKey, config.model, onChunk, maxTokens,
        config.stream ?? true, config.tools, config.toolChoice,
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
  return error instanceof Error ? error.message : String(error)
}

export function isTransientProviderError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : ''
  if (TRANSIENT_NETWORK_CODES.has(code)) return true

  const message = errorMessage(error)
  return /socket hang up|network socket disconnected|connection (?:closed|reset)|timed? out|fetch failed/i.test(message)
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

const THINKING_PHRASES = [
  'Reviewing lap data…',
  'Studying the sectors…',
  'Scrubbing tires…',
  'Analyzing corner entries…',
  'Checking brake points…',
  'Calculating time deltas…',
  'Studying your racing line…',
  'Fueling up the analysis…',
  'Mapping the circuit…',
  'Cross-referencing segments…',
  'Computing theoretical best…',
  'Comparing representative laps…',
  'Talking to the engineers…',
  'Reviewing telemetry traces…',
  'Dialing in the suspension…',
]

function runAnthropic(
  prompt: string,
  apiKey: string,
  model: string,
  onChunk: (text: string) => void,
  maxTokens: number,
  stream: boolean,
  tools?: object[],
  toolChoice?: { type: 'tool'; name: string },
): Promise<string> {
  const reqObj: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    stream,
    messages: [{ role: 'user', content: prompt }],
  }
  if (tools?.length) {
    reqObj.tools = tools
    reqObj.tool_choice = toolChoice ?? { type: 'any' }
  }
  const body = JSON.stringify(reqObj)

  onChunk(`[status] Connecting to ${model}…\n`)
  onChunk(`[diag] model=${model} max_tokens=${maxTokens} stream=${stream} prompt=${(prompt.length/1024).toFixed(1)}KB\n`)

  return new Promise((resolve, reject) => {
    const requestStart = Date.now()
    let phraseIdx = 0
    const statusTimer = setInterval(() => {
      onChunk(`[status] ${THINKING_PHRASES[phraseIdx % THINKING_PHRASES.length]}\n`)
      const elapsed = ((Date.now() - requestStart) / 1000).toFixed(0)
      onChunk(`[diag] waiting for response… ${elapsed}s elapsed\n`)
      phraseIdx++
    }, 4000)

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      // 5-minute overall timeout — surfaced as an error if the server goes silent
      timeout: 300_000,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        clearInterval(statusTimer)
        let errBody = ''
        res.on('data', (c: Buffer) => { errBody += c.toString() })
        res.on('end', () => {
          onChunk(`[error] HTTP ${res.statusCode}: ${errBody}\n`)
          reject(new Error(`Anthropic API ${res.statusCode}: ${errBody.slice(0, 500)}`))
        })
        return
      }

      let rawBody = ''
      res.on('data', (chunk: Buffer) => { rawBody += chunk.toString('utf-8') })
      res.on('end', () => {
        clearInterval(statusTimer)

        let full = ''
        if (stream) {
          // Parse SSE — each line is "data: {...}"
          let generatingStarted = false
          let toolInputJson = ''
          let inToolUse = false
          for (const line of rawBody.split('\n')) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (raw === '[DONE]') continue
            let evt: any
            try { evt = JSON.parse(raw) } catch { continue }
            // Text response
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              full += evt.delta.text ?? ''
            }
            // Tool use — collect JSON fragments
            if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
              inToolUse = true
              toolInputJson = ''
            }
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'input_json_delta') {
              toolInputJson += evt.delta.partial_json ?? ''
            }
            if (evt.type === 'content_block_stop' && inToolUse) {
              inToolUse = false
              full = toolInputJson  // tool input replaces text output
            }
            if (evt.type === 'message_start') {
              if (!generatingStarted) {
                generatingStarted = true
                onChunk('[status] Generating response…\n')
                onChunk(`[diag] first-token latency: ${((Date.now() - requestStart) / 1000).toFixed(1)}s\n`)
              }
              if (evt.message?.usage) {
                const u = evt.message.usage
                onChunk(`[diag] input_tokens=${u.input_tokens ?? '?'}\n`)
              }
            }
            if (evt.type === 'message_delta' && evt.usage) {
              onChunk(`[diag] output_tokens=${evt.usage.output_tokens ?? '?'}\n`)
            }
          }
        } else {
          // Non-streaming: single JSON response object
          try {
            const resp = JSON.parse(rawBody)
            // Tool use response
            const toolBlock = resp.content?.find((b: any) => b.type === 'tool_use')
            if (toolBlock?.input) {
              full = JSON.stringify(toolBlock.input)
            } else {
              full = resp.content?.find((b: any) => b.type === 'text')?.text ?? ''
            }
          } catch {
            onChunk('[error] Failed to parse non-streaming response\n')
          }
        }

        if (!full) {
          onChunk('[error] Response ended with no content\n')
        } else {
          const elapsed = ((Date.now() - requestStart) / 1000).toFixed(1)
          onChunk(`[diag] response complete: ${(full.length / 1024).toFixed(1)}KB in ${elapsed}s\n`)
          onChunk('[status] Parsing coaching report…\n')
        }
        resolve(full)
      })
      res.on('error', (err) => {
        clearInterval(statusTimer)
        onChunk(`[error] ${err.message}\n`)
        reject(err)
      })
    })

    req.on('timeout', () => {
      clearInterval(statusTimer)
      onChunk('[error] Request timed out (5 min)\n')
      req.destroy()
      reject(new Error('Request timed out after 5 minutes'))
    })
    req.on('error', (err) => {
      clearInterval(statusTimer)
      onChunk(`[error] ${err.message}\n`)
      reject(err)
    })
    req.write(body)
    req.end()
  })
}

// ─── OpenAI Responses API (structured function call) ────────────────────────

async function runOpenAI(
  prompt: string,
  apiKey: string,
  model: string,
  onChunk: (text: string) => void,
  maxTokens: number,
  tools?: object[],
  toolChoice?: { type: 'tool'; name: string },
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' = 'xhigh',
): Promise<string> {
  // The app's canonical schema uses Anthropic's input_schema spelling. Convert
  // it at the provider boundary so both providers are constrained identically.
  const openAiTools = (tools ?? []).map((tool: any) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema ?? tool.parameters,
    // The shared schema intentionally has optional fields, so it is not a
    // strict-schema-compatible shape. Forced function choice still guarantees
    // a machine-readable arguments object.
    strict: false,
  }))
  const reqObj: Record<string, unknown> = {
    model,
    input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    reasoning: { effort: reasoningEffort },
    max_output_tokens: maxTokens,
    // Reasoning can take several minutes. Background mode lets the provider
    // continue the job independently while we poll over short-lived requests.
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
  onChunk(`[diag] provider=openai mode=background model=${model} reasoning=${reasoningEffort} max_output_tokens=${maxTokens} prompt=${(prompt.length / 1024).toFixed(1)}KB\n`)

  const requestStart = Date.now()
  let response = await openAiJsonRequestWithRetry(
    'POST', '/v1/responses', apiKey, reqObj, onChunk, 'starting background analysis',
  )
  const responseId = typeof response.id === 'string' ? response.id : null

  if ((response.status === 'queued' || response.status === 'in_progress') && !responseId) {
    throw new Error('OpenAI started the coaching analysis but did not return a response ID')
  }

  let phraseIdx = 0
  let nextStatusAt = 0
  const deadline = requestStart + 15 * 60_000
  while (response.status === 'queued' || response.status === 'in_progress') {
    if (Date.now() >= deadline) {
      throw new Error('OpenAI background analysis did not finish within 15 minutes')
    }

    // Poll promptly at first, then ease off for longer x-high reasoning runs.
    const elapsedMs = Date.now() - requestStart
    await wait(elapsedMs < 60_000 ? 2000 : 5000)
    response = await openAiJsonRequestWithRetry(
      'GET', `/v1/responses/${encodeURIComponent(responseId!)}`, apiKey,
      undefined, onChunk, 'checking analysis status',
    )

    if (Date.now() >= nextStatusAt && (response.status === 'queued' || response.status === 'in_progress')) {
      onChunk(`[status] ${THINKING_PHRASES[phraseIdx % THINKING_PHRASES.length]}\n`)
      onChunk(`[diag] background status=${response.status} elapsed=${Math.round((Date.now() - requestStart) / 1000)}s\n`)
      phraseIdx++
      nextStatusAt = Date.now() + 4000
    }
  }

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

  const functionCall = response.output?.find(
    (item: any) => item.type === 'function_call' && (!toolChoice || item.name === toolChoice.name),
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

async function openAiJsonRequestWithRetry(
  method: 'GET' | 'POST',
  requestPath: string,
  apiKey: string,
  requestBody: Record<string, unknown> | undefined,
  onChunk: (text: string) => void,
  operation: string,
): Promise<any> {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await openAiJsonRequest(method, requestPath, apiKey, requestBody)
    } catch (error) {
      if (!isTransientProviderError(error) || attempt === maxAttempts) {
        if (isTransientProviderError(error)) throw providerConnectionError('openai', error, attempt)
        throw error
      }
      const delayMs = attempt === 1 ? 1200 : 3000
      onChunk(`[status] OpenAI connection interrupted while ${operation} · retrying ${attempt + 1}/${maxAttempts}…\n`)
      onChunk(`[diag] transient provider error: ${errorMessage(error)}\n`)
      await wait(delayMs)
    }
  }
  throw new Error(`OpenAI failed while ${operation}`)
}

function openAiJsonRequest(
  method: 'GET' | 'POST',
  requestPath: string,
  apiKey: string,
  requestBody?: Record<string, unknown>,
): Promise<any> {
  const body = requestBody ? JSON.stringify(requestBody) : ''
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      fn()
    }
    const headers: Record<string, string | number> = {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
    }
    if (body) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = Buffer.byteLength(body)
    }

    const req = https.request({
      hostname: 'api.openai.com',
      path: requestPath,
      method,
      timeout: 60_000,
      headers,
    }, (res) => {
      let rawBody = ''
      res.on('data', (chunk: Buffer) => { rawBody += chunk.toString('utf-8') })
      res.on('error', error => finish(() => reject(error)))
      res.on('end', () => finish(() => {
        let parsed: any = null
        try { parsed = rawBody ? JSON.parse(rawBody) : null } catch { /* handled below */ }

        if (res.statusCode && res.statusCode >= 400) {
          const message = parsed?.error?.message ?? (rawBody.slice(0, 500) || 'request failed')
          reject(new Error(`OpenAI API ${res.statusCode}: ${message}`))
          return
        }
        if (!parsed) {
          reject(new Error(`OpenAI API returned an unreadable response (HTTP ${res.statusCode ?? 'unknown'})`))
          return
        }
        resolve(parsed)
      }))
    })

    req.on('timeout', () => {
      req.destroy()
      finish(() => reject(Object.assign(new Error('OpenAI network request timed out after 60 seconds'), { code: 'ETIMEDOUT' })))
    })
    req.on('error', error => finish(() => reject(error)))
    if (body) req.write(body)
    req.end()
  })
}
