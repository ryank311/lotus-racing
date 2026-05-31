// Agent harness — sends a prompt to an LLM and streams the response back.
// Two implementations: local (spawns the `claude` CLI) and remote (Anthropic API via https).
// Main-process only — never imported in the renderer.
//
// KEY RULES:
//   - Never use spawnSync/execSync — they block the Electron main thread and freeze the UI.
//   - Write large prompts to a temp file; piping 100K+ bytes to stdin deadlocks the OS pipe.

import { spawn } from 'node:child_process'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'

export type HarnessConfig =
  | { harness: 'local'; cliPath?: string }
  | { harness: 'remote'; apiKey: string; model: string; maxTokens?: number; stream?: boolean }

export async function runAgent(
  prompt: string,
  config: HarnessConfig,
  onChunk: (text: string) => void,
): Promise<string> {
  if (config.harness === 'local') return runLocal(prompt, config.cliPath, onChunk)
  return runRemote(prompt, config.apiKey, config.model, onChunk, config.maxTokens ?? 32000, config.stream ?? true)
}

// ─── Async helpers ────────────────────────────────────────────────────────────

// Non-blocking version check — resolves with stdout or rejects on error/timeout.
function checkVersion(bin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    proc.stdout.on('data', (c: Buffer) => { out += c.toString() })
    proc.stderr.on('data', (c: Buffer) => { err += c.toString() })
    const t = setTimeout(() => { proc.kill(); reject(new Error('--version timed out')) }, 8000)
    proc.on('error', e => { clearTimeout(t); reject(e) })
    proc.on('close', code => {
      clearTimeout(t)
      if (code !== 0) reject(new Error(`exit ${code}${err ? ': ' + err.slice(0, 200) : ''}`))
      else resolve(out.trim())
    })
  })
}

// Locate the claude binary without blocking the UI.
async function resolveClaudeBin(cliPath?: string, onChunk?: (t: string) => void): Promise<string> {
  if (cliPath) return cliPath
  const candidates = [
    path.join(os.homedir(), '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ]
  for (const c of candidates) {
    try { await checkVersion(c); return c } catch { /* try next */ }
  }
  // Fall back to PATH — version check will surface the error if it's not there
  return 'claude'
}

// ─── Local: claude CLI ────────────────────────────────────────────────────────

async function runLocal(
  prompt: string,
  cliPath: string | undefined,
  onChunk: (text: string) => void,
): Promise<string> {
  const bin = await resolveClaudeBin(cliPath, onChunk)

  // ── Diagnostics (non-blocking) ──────────────────────────────────────────
  onChunk(`[diag] binary : ${bin}\n`)
  onChunk(`[diag] user   : ${os.userInfo().username}\n`)
  onChunk(`[diag] PATH   : ${process.env.PATH?.slice(0, 120)}…\n`)

  let version = '(unknown)'
  try { version = await checkVersion(bin) } catch (e: any) {
    throw new Error(`'${bin} --version' failed: ${e.message}\nSet a custom cliPath in AI Coach settings if the binary is elsewhere.`)
  }
  onChunk(`[diag] version : ${version.slice(0, 80)}\n`)

  onChunk(`[diag] prompt  : ${(prompt.length / 1024).toFixed(1)} KB\n`)
  onChunk(`[harness] spawning: ${bin} --print "<prompt>"\n`)
  return spawnWithArg(bin, prompt, onChunk)
}

// Pass the prompt as a positional argument — matches the documented CLI usage:
//   claude [options] [command] [prompt]
// stdin is ignored entirely, avoiding all pipe/stream issues.
function spawnWithArg(bin: string, prompt: string, onChunk: (t: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    onChunk(`[harness] spawn ${bin} --print "<prompt>" (no stdin)\n`)

    const proc = spawn(bin, ['--print', prompt], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' },
    })
    onChunk(`[harness] pid=${proc.pid ?? '?'}\n`)

    let full = ''

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8')
      full += text
      onChunk(text)
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8').trim()
      if (text) onChunk(`[stderr] ${text}\n`)
    })

    proc.on('error', err => reject(new Error(`spawn error: ${err.message}`)))

    proc.on('close', (code, signal) => {
      onChunk(`[harness] exited code=${code} signal=${signal}\n`)
      if (code !== 0 && code !== null) {
        reject(new Error(`claude CLI exited ${code} — check [stderr] lines above`))
      } else {
        resolve(full)
      }
    })

    // Heartbeat: every 30 s confirm the process is still alive.
    // claude --print buffers all output until done, so silence is expected.
    let elapsed = 0
    const heartbeat = setInterval(() => {
      elapsed += 30
      const ps = spawn('ps', ['-p', String(proc.pid), '-o', 'pid,stat'])
      let psOut = ''
      ps.stdout.on('data', (c: Buffer) => { psOut += c.toString() })
      ps.on('close', () => {
        const alive = psOut.includes(String(proc.pid))
        if (alive) {
          onChunk(`[harness] still running (${elapsed}s elapsed, waiting for API response…)\n`)
        } else {
          onChunk('[harness] process no longer in ps — may have exited before close event\n')
        }
      })
    }, 30_000)
    proc.on('close', () => clearInterval(heartbeat))
  })
}

// ─── Remote: Anthropic Messages API (SSE streaming) ──────────────────────────

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
): Promise<string> {
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    stream,
    messages: [{ role: 'user', content: prompt }],
  })

  onChunk(`Connecting to ${model}…\n`)

  return new Promise((resolve, reject) => {
    // Cycle through fun status phrases while waiting for the response.
    let phraseIdx = 0
    const statusTimer = setInterval(() => {
      onChunk(`${THINKING_PHRASES[phraseIdx % THINKING_PHRASES.length]}\n`)
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
          for (const line of rawBody.split('\n')) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (raw === '[DONE]') continue
            let evt: any
            try { evt = JSON.parse(raw) } catch { continue }
            if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
              full += evt.delta.text ?? ''
            }
            if (evt.type === 'message_start' && !generatingStarted) {
              generatingStarted = true
              onChunk('Generating response…\n')
            }
          }
        } else {
          // Non-streaming: single JSON response object
          try {
            const resp = JSON.parse(rawBody)
            full = resp.content?.[0]?.text ?? ''
          } catch {
            onChunk('[error] Failed to parse non-streaming response\n')
          }
        }

        if (!full) {
          onChunk('[error] Response ended with no content\n')
        } else {
          onChunk(`Done — ${(full.length / 1024).toFixed(1)} KB\n`)
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
