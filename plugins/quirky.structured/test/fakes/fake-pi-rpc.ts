import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type FakePiRpcFixture = {
  executable: string
  /** The argv and cwd the runner started the process with. */
  launch(): { argv: string[]; cwd: string } | null
  /** Every JSON line the runner wrote to the process's stdin. */
  commands(): Record<string, any>[]
}

/**
 * Writes a scripted `pi --mode rpc` stand-in under a test's temporary home. It speaks JSON lines
 * on stdio and never contacts a provider. The prompt text picks the script: `[tool]` runs a tool,
 * `[ui]` raises an extension dialog, `[hold]` waits for a steer or abort, `[reject]` refuses the
 * prompt, `[split]` answers with one message whose multibyte character straddles two stdout writes,
 * anything else answers with one assistant message.
 */
export function createFakePiRpc(home: string, options: { contextWindow?: number | null } = {}): FakePiRpcFixture {
  mkdirSync(home, { recursive: true })
  const executable = join(home, 'fake-pi')
  const logPath = join(home, 'fake-pi.jsonl')
  const launchPath = join(home, 'fake-pi-launch.json')
  const contextWindow = options.contextWindow === undefined ? 200000 : options.contextWindow
  const script = `#!${process.execPath}
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(launchPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const assistant = (text) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, totalTokens: 180 },
  stopReason: 'stop'
})
let held = false
let waitingUi = false
function finish(text) {
  send({ type: 'message_end', message: assistant(text) })
  send({ type: 'agent_end', messages: [] })
  held = false
}
function runPrompt(text) {
  send({ type: 'response', command: 'prompt', success: true })
  send({ type: 'agent_start' })
  if (text.includes('[reject]')) return
  if (text.includes('[hold]')) { held = true; return }
  if (text.includes('[split]')) {
    const raw = Buffer.from(JSON.stringify({ type: 'message_end', message: assistant('caf\u00e9 \u2615') }) + '\\n')
    const cut = raw.indexOf(Buffer.from('\u00e9')) + 1
    process.stdout.write(raw.subarray(0, cut))
    setTimeout(() => { process.stdout.write(raw.subarray(cut)); send({ type: 'agent_end', messages: [] }) }, 30)
    return
  }
  if (text.includes('[ui]')) {
    waitingUi = true
    send({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'Allow?', message: 'run it' })
    return
  }
  if (text.includes('[tool]')) {
    held = true
    send({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'ls -la' } })
    if (text.includes('[allowed]')) {
      send({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: 'file.txt' }] }, isError: false })
      finish('listed')
    }
    return
  }
  finish('pi: ' + text)
}
function receive(message) {
  fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(message) + '\\n')
  switch (message.type) {
    case 'get_state':
      send({ id: message.id, type: 'response', command: 'get_state', success: true, data: { model: { id: 'fake', contextWindow: ${JSON.stringify(contextWindow)} } } })
      return
    case 'prompt':
      if (message.message.includes('[reject]')) {
        send({ type: 'response', command: 'prompt', success: false, error: 'scripted rejection' })
        return
      }
      runPrompt(message.message)
      return
    case 'steer':
      if (held) finish('steered: ' + message.message)
      return
    case 'abort':
      send({ type: 'response', command: 'abort', success: true })
      if (held) { held = false; send({ type: 'agent_end', messages: [] }) }
      return
    case 'extension_ui_response':
      if (waitingUi) { waitingUi = false; finish(message.cancelled ? 'dialog cancelled' : 'dialog answered') }
      return
  }
}
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  for (;;) {
    const newline = input.indexOf('\\n')
    if (newline < 0) break
    const line = input.slice(0, newline)
    input = input.slice(newline + 1)
    if (line) receive(JSON.parse(line))
  }
})
process.stdin.on('end', () => process.exit(0))
`
  writeFileSync(executable, script, { mode: 0o700 })
  chmodSync(executable, 0o700)
  return {
    executable,
    launch() {
      return existsSync(launchPath) ? JSON.parse(readFileSync(launchPath, 'utf8')) : null
    },
    commands() {
      if (!existsSync(logPath)) return []
      return readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    }
  }
}
