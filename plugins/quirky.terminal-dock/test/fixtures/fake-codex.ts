import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

if (process.argv.includes('--version')) {
  process.stdout.write('2.1.0 (private dock fixture)\n')
  process.exit(0)
}

const home = process.env.HOME
if (!home) throw new Error('fake Codex requires the E2E HOME')
if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') throw new Error('fake Codex requires a raw PTY')

const providerSession = 'dock-codex-defect-session'
const transcript = join(home, '.codex', 'sessions', `rollout-${providerSession}.jsonl`)
const receivedBytes = join(home, 'dock-pty-input.bin')
const consumedPrompts = join(home, 'dock-codex-consumed.jsonl')
mkdirSync(dirname(transcript), { recursive: true })
writeFileSync(transcript, '')
writeFileSync(receivedBytes, '')
writeFileSync(consumedPrompts, '')

function appendRow(row: unknown): void {
  appendFileSync(transcript, `${JSON.stringify(row)}\n`)
}

function timestamp(): string {
  return new Date().toISOString()
}

appendRow({
  type: 'event_msg',
  timestamp: timestamp(),
  payload: { type: 'user_message', message: 'stale old composer prompt' }
})

process.stdin.setRawMode(true)
process.stdin.resume()
process.stdout.write('\u001b[?2004h\u001b[2J\u001b[H> stale old composer prompt\n')

let body = ''
function submitPrompt(prompt: string): void {
  if (!prompt) return
  const at = timestamp()
  appendRow({ type: 'event_msg', timestamp: at, payload: { type: 'user_message', message: prompt } })
  appendRow({
    type: 'response_item',
    timestamp: timestamp(),
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'PONG' }] }
  })
  appendFileSync(consumedPrompts, `${JSON.stringify({ type: 'child_consumed', payload: { prompt } })}\n`)
  process.stdout.write('\r\nPONG\r\n> stale old composer prompt')
}

process.stdin.on('data', (chunk: Buffer) => {
  appendFileSync(receivedBytes, chunk)
  for (const byte of chunk) {
    if (byte === 0x15 || byte === 0x0b) {
      body = ''
    } else if (byte === 0x0d || byte === 0x0a) {
      const submitted = body
      body = ''
      submitPrompt(submitted)
    } else if (byte === 0x7f || byte === 0x08) {
      body = body.slice(0, -1)
    } else if (byte >= 0x20) {
      body += String.fromCharCode(byte)
    }
  }
})
