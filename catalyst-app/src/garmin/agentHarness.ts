// Agent harness — sends a prompt to the Anthropic Messages API and returns the
// response. Remote-only. Main-process only — never imported in the renderer.

import https from 'node:https'

export interface HarnessConfig {
  apiKey: string
  model: string
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
  return runRemote(
    prompt, config.apiKey, config.model, onChunk,
    config.maxTokens ?? 32000, config.stream ?? true,
    config.tools, config.toolChoice,
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
  'Watching onboard footage…',
  'Talking to the engineers…',
  'Reviewing telemetry traces…',
  'Dialing in the suspension…',
]

function runRemote(
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
