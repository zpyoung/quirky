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
 * Writes a pi/omp RPC stand-in under a test's temporary home; it never contacts a provider. `[tool]`
 * runs a tool, `[ui]` raises a dialog, `[hold]` waits for steer/abort, and `[reject]` refuses.
 * `[split]` splits a multibyte character across stdout writes; `[retry]` does a pi error and retry.
 * `[end-only]` omits settling; `[twice]` duplicates settlement; `[background]` delays omp settle;
 * `[no-agent]` sends an omp result without starting an agent; `[handled]` handles a pi prompt;
 * `[queued]` responds queued; `[zero-last]` follows usage with a zero-token error; `[big]` sends a
 * 6 MiB agent_end; `[crlf]` ends frames with CRLF; `[flood]` writes 2 MiB without a newline while
 * its process group ignores EOF and SIGTERM; `[unreadable]` writes malformed and non-object JSON.
 * `[settled-result]` delays omp settlement after an invoked prompt_result with sessionSettled true.
 * SIGUSR1 emits stale settle/result frames for an idle-session check.
 */
export function createFakePiRpc(
  home: string,
  options: { contextWindow?: number | null; flavor?: 'pi' | 'omp' } = {}
): FakePiRpcFixture {
  mkdirSync(home, { recursive: true })
  const executable = join(home, 'fake-pi')
  const logPath = join(home, 'fake-pi.jsonl')
  const launchPath = join(home, 'fake-pi-launch.json')
  const contextWindow = options.contextWindow === undefined ? 200000 : options.contextWindow
  const flavor = options.flavor ?? 'pi'
  const script = `#!${process.execPath}
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(launchPath)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }))
const flavor = ${JSON.stringify(flavor)}
const send = (message) => process.stdout.write(JSON.stringify(message) + lineEnding)
const assistant = (text) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10, totalTokens: 180 },
  stopReason: 'stop'
})
let lineEnding = '\\n'
let held = false
let waitingUi = false
let stubborn = false
process.on('SIGUSR1', () => {
  send({ type: 'agent_settled', aborted: false })
  send({ type: 'session_settled' })
  send({ type: 'prompt_result', agentInvoked: false, status: 'completed', sessionSettled: true })
  fs.writeFileSync(${JSON.stringify(join(home, 'idle-frames-sent'))}, '')
})
function sendAgentEnd(willRetry = false) {
  if (flavor === 'pi') send({ type: 'agent_end', messages: [], willRetry })
  else send({ type: 'agent_end', messages: [] })
}
function sendSettle(aborted = false) {
  if (flavor === 'pi') send({ type: 'agent_settled', aborted })
  else send({ type: 'session_settled' })
}
function sendAfterAgentEnd(aborted = false) {
  if (flavor === 'omp') {
    send({
      type: 'prompt_result',
      agentInvoked: true,
      status: aborted ? 'aborted' : 'completed',
      sessionSettled: true
    })
  }
  sendSettle(aborted)
}
function sendTurnEnd(aborted = false) {
  sendAgentEnd(false)
  sendAfterAgentEnd(aborted)
}
function finish(text) {
  send({ type: 'message_end', message: assistant(text) })
  sendTurnEnd()
  held = false
}
function runPrompt(text) {
  lineEnding = text.includes('[crlf]') ? '\\r\\n' : '\\n'
  if (flavor === 'pi') {
    const disposition = text.includes('[handled]') ? 'handled' : text.includes('[queued]') ? 'queued' : 'started'
    send({ type: 'response', command: 'prompt', success: true, data: { disposition } })
  } else {
    send({ type: 'response', command: 'prompt', success: true })
  }
  if (text.includes('[handled]')) return
  if (text.includes('[no-agent]') && flavor === 'omp') {
    send({ type: 'prompt_result', agentInvoked: false, status: 'completed', sessionSettled: true })
    if (text.includes('[twice]')) {
      setTimeout(() => send({ type: 'prompt_result', agentInvoked: false, status: 'completed', sessionSettled: true }), 30)
    }
    return
  }
  send({ type: 'agent_start' })
  if (text.includes('[hold]')) { held = true; return }
  if (text.includes('[reject]')) return
  if (text.includes('[end-only]')) {
    send({ type: 'message_end', message: assistant(flavor + ': ' + text) })
    sendAgentEnd(false)
    return
  }
  if (text.includes('[retry]') && flavor === 'pi') {
    send({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: 'error',
        errorMessage: '529 overloaded'
      }
    })
    sendAgentEnd(true)
    send({ type: 'auto_retry_start' })
    setTimeout(() => {
      send({ type: 'agent_start' })
      send({ type: 'message_end', message: assistant('second try') })
      send({ type: 'auto_retry_end' })
      sendTurnEnd()
    }, 40)
    return
  }
  if ((text.includes('[background]') || text.includes('[settled-result]')) && flavor === 'omp') {
    send({ type: 'message_end', message: assistant('omp: background work') })
    sendAgentEnd(false)
    send({ type: 'prompt_result', agentInvoked: true, status: 'completed', sessionSettled: text.includes('[settled-result]') })
    setTimeout(() => sendSettle(), 300)
    return
  }
  if (text.includes('[zero-last]')) {
    send({ type: 'message_end', message: assistant('first') })
    send({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: 'error',
        errorMessage: 'boom'
      }
    })
    sendTurnEnd()
    return
  }
  if (text.includes('[big]')) {
    send({ type: 'message_end', message: assistant('big') })
    const largeMessage = { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(6 * 1024 * 1024) }] }
    send({
      type: 'agent_end',
      messages: [largeMessage],
      ...(flavor === 'pi' ? { willRetry: false } : {})
    })
    sendAfterAgentEnd(false)
    return
  }
  if (text.includes('[flood]')) {
    stubborn = true
    process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(join(home, 'flood-signals'))}, 'parent\\n'))
    const descendant = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`const fs = require('node:fs'); process.on('SIGTERM', () => fs.appendFileSync(${JSON.stringify(join(home, 'flood-signals'))}, 'child\\n')); setInterval(() => {}, 1000); process.send('ready')`)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    descendant.once('message', () => {
      fs.writeFileSync(${JSON.stringify(join(home, 'flood-pids.json'))}, JSON.stringify({ parent: process.pid, child: descendant.pid }))
      process.stdout.write('x'.repeat(2 * 1024 * 1024))
    })
    return
  }
  if (text.includes('[unreadable]')) process.stdout.write('invalid-json\\n[]\\n')
  if (text.includes('[split]')) {
    const raw = Buffer.from(JSON.stringify({ type: 'message_end', message: assistant('caf\\u00e9 \\u2615') }) + '\\n')
    const cut = raw.indexOf(Buffer.from('\\u00e9')) + 1
    process.stdout.write(raw.subarray(0, cut))
    setTimeout(() => {
      process.stdout.write(raw.subarray(cut))
      sendTurnEnd()
    }, 30)
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
  finish(flavor + ': ' + text)
  if (text.includes('[twice]')) setTimeout(() => sendSettle(), 30)
}
if (flavor === 'omp') {
  send({ type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 })
  send({ type: 'extension_ui_request', id: 'w1', method: 'setWidget', widgetKey: 'autoresearch' })
  send({ type: 'available_commands_update', commands: [] })
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
      if (held) { held = false; sendTurnEnd(true) }
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
process.stdin.on('end', () => { if (!stubborn) process.exit(0) })
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
