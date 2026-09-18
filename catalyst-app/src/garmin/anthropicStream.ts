import { StringDecoder } from 'node:string_decoder'

// Decode SSE incrementally: neither UTF-8 characters, lines, nor events are
// guaranteed to align with network chunks. Never expose thinking text in logs.
export class AnthropicStream {
  private decoder = new StringDecoder('utf8')
  private pending = ''
  private data: string[] = []
  private blocks = new Map<number, { type: string; name?: string; json: string; input?: object; closed: boolean }>()
  private text = ''
  private stopReason: string | undefined
  done = false
  events = 0
  lastEvent = 'none'
  reportChars = 0
  thinkingChars = 0

  constructor(
    private toolName: string | undefined,
    private onEvent: (event: Record<string, any>) => void,
  ) {}

  push(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk)
    let end: number
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).replace(/\r$/, '')
      this.pending = this.pending.slice(end + 1)
      if (line === '') this.dispatch()
      else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''))
    }
  }

  private dispatch(): void {
    if (!this.data.length || this.done) return
    const data = this.data.join('\n')
    this.data = []
    let event: Record<string, any>
    try { event = JSON.parse(data) } catch {
      throw new Error('Anthropic sent a malformed streaming event')
    }
    if (!event || typeof event.type !== 'string') throw new Error('Anthropic sent an invalid streaming event')
    this.events++
    this.lastEvent = event.type
    if (event.type === 'error') {
      const type = event.error?.type ?? 'unknown_error'
      const status = ({ overloaded_error: 529, api_error: 500, rate_limit_error: 429 } as Record<string, number>)[type]
      throw Object.assign(new Error(`Anthropic stream error (${type}): ${event.error?.message ?? 'Unknown error'}`), { status })
    }
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block?.type) {
        this.blocks.set(event.index, { type: block.type, name: block.name, input: block.input, json: '', closed: false })
        if (block.type === 'text') {
          this.text += block.text ?? ''
          this.reportChars += (block.text ?? '').length
        }
      }
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (delta?.type === 'text_delta') {
        this.text += delta.text ?? ''
        this.reportChars += (delta.text ?? '').length
      } else if (delta?.type === 'input_json_delta') {
        const block = this.blocks.get(event.index)
        if (!block || block.type !== 'tool_use' || block.closed) {
          throw new Error('Anthropic sent tool input without an active tool block')
        }
        block.json += delta.partial_json ?? ''
        this.reportChars += (delta.partial_json ?? '').length
      } else if (delta?.type === 'thinking_delta') {
        this.thinkingChars += (delta.thinking ?? '').length
      }
    }
    if (event.type === 'content_block_stop') {
      const block = this.blocks.get(event.index)
      if (block) block.closed = true
    }
    if (event.type === 'message_delta') this.stopReason = event.delta?.stop_reason ?? this.stopReason
    if (event.type === 'message_stop') this.done = true
    this.onEvent(event)
  }

  finish(): string {
    if (!this.done) {
      throw Object.assign(new Error('Anthropic stream ended before message_stop; the report is incomplete'), { code: 'ECONNRESET' })
    }
    checkAnthropicStopReason(this.stopReason)
    if ([...this.blocks.values()].some(block => !block.closed)) {
      throw new Error('Anthropic response ended with an unfinished content block')
    }
    const tool = [...this.blocks.values()].find(block => block.type === 'tool_use' && (!this.toolName || block.name === this.toolName))
    if (tool) {
      let input: unknown
      try { input = tool.json ? JSON.parse(tool.json) : tool.input } catch {
        throw new Error('Anthropic returned invalid JSON for the coaching tool')
      }
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('Anthropic returned invalid input for the coaching tool')
      }
      return JSON.stringify(input)
    }
    if (!this.text.trim()) throw new Error('Anthropic response ended without a coaching report')
    return this.text
  }
}

export function checkAnthropicStopReason(reason: string | undefined): void {
  if (reason === 'max_tokens') {
    throw new Error('Anthropic reached the output token limit before finishing the coaching report. Try the Top 3 lap filter to reduce the analysis size.')
  }
  if (reason && !['end_turn', 'tool_use', 'stop_sequence'].includes(reason)) {
    throw new Error(`Anthropic did not complete the coaching report (stop_reason=${reason})`)
  }
}
