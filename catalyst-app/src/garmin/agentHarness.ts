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
    return runOpenAI(
      prompt, config.apiKey, config.model, onChunk, maxTokens,
      config.tools, config.toolChoice, config.reasoningEffort ?? 'xhigh',
    )
  }
  return runAnthropic(
    prompt, config.apiKey, config.model, onChunk, maxTokens,
    config.stream ?? true, config.tools, config.toolChoice,
  )
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

function runOpenAI(
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
    store: false,
  }
  if (openAiTools.length) {
    reqObj.tools = openAiTools
    reqObj.tool_choice = toolChoice
      ? { type: 'function', name: toolChoice.name }
      : 'required'
    reqObj.parallel_tool_calls = false
  }
  const body = JSON.stringify(reqObj)

  onChunk(`[status] Connecting to ${model}…\n`)
  onChunk(`[diag] provider=openai model=${model} reasoning=${reasoningEffort} max_output_tokens=${maxTokens} prompt=${(prompt.length / 1024).toFixed(1)}KB\n`)

  return new Promise((resolve, reject) => {
    const requestStart = Date.now()
    let phraseIdx = 0
    const statusTimer = setInterval(() => {
      onChunk(`[status] ${THINKING_PHRASES[phraseIdx % THINKING_PHRASES.length]}\n`)
      onChunk(`[diag] waiting for response… ${((Date.now() - requestStart) / 1000).toFixed(0)}s elapsed\n`)
      phraseIdx++
    }, 4000)

    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/responses',
      method: 'POST',
      // xhigh analysis can be substantially slower than ordinary generation.
      timeout: 600_000,
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let rawBody = ''
      res.on('data', (chunk: Buffer) => { rawBody += chunk.toString('utf-8') })
      res.on('end', () => {
        clearInterval(statusTimer)
        let response: any
        try {
          response = JSON.parse(rawBody)
        } catch {
          reject(new Error(`OpenAI API returned an unreadable response (HTTP ${res.statusCode ?? 'unknown'})`))
          return
        }

        if (res.statusCode && res.statusCode >= 400) {
          const message = response?.error?.message ?? rawBody.slice(0, 500)
          onChunk(`[error] OpenAI HTTP ${res.statusCode}: ${message}\n`)
          reject(new Error(`OpenAI API ${res.statusCode}: ${message}`))
          return
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
        if (response.status === 'incomplete') {
          const reason = response.incomplete_details?.reason ?? 'unknown reason'
          reject(new Error(`OpenAI response was incomplete: ${reason}`))
          return
        }
        if (!full) {
          reject(new Error('OpenAI response ended without a coaching report'))
          return
        }

        onChunk(`[diag] response complete: ${(full.length / 1024).toFixed(1)}KB in ${((Date.now() - requestStart) / 1000).toFixed(1)}s\n`)
        onChunk('[status] Parsing coaching report…\n')
        resolve(full)
      })
      res.on('error', (err) => {
        clearInterval(statusTimer)
        reject(err)
      })
    })

    req.on('timeout', () => {
      clearInterval(statusTimer)
      req.destroy()
      reject(new Error('OpenAI request timed out after 10 minutes'))
    })
    req.on('error', (err) => {
      clearInterval(statusTimer)
      reject(err)
    })
    req.write(body)
    req.end()
  })
}
