import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type CodexAppServerLogEntry = {
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}

export type CodexAppServerFixture = {
  executable: string
  logPath: string
  requests(): CodexAppServerLogEntry[]
}

/**
 * Writes a deterministic native-protocol app-server executable under a test's temporary home.
 * The executable accepts `app-server`, speaks JSONL on stdio, and never contacts a provider.
 */
export function createCodexAppServerFixture(home: string): CodexAppServerFixture {
  mkdirSync(home, { recursive: true })
  const executable = join(home, 'codex-app-server-fixture')
  const logPath = join(home, 'codex-app-server.jsonl')
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const logPath = ${JSON.stringify(logPath)}
let input = ''
let nextTurn = 1
let nextApproval = 1
const active = new Map()
const approvals = new Map()
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const notify = (method, params) => send({ method, params })
const log = (message) => fs.appendFileSync(logPath, JSON.stringify(message) + '\\n')
const textInput = (items) => items.filter((item) => item.type === 'text').map((item) => item.text).join('\\n')
function finish(threadId, turn, status = 'completed') {
  const state = active.get(threadId)
  if (!state || state.turn.id !== turn.id) return
  const text = 'Codex: ' + state.text
  const item = { id: 'message-' + turn.id, type: 'agentMessage', phase: 'final_answer', text }
  notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: item.id, delta: text })
  notify('item/completed', { threadId, turnId: turn.id, item })
  notify('turn/completed', { threadId, turn: { id: turn.id, status, items: [item], ...(status === 'failed' ? { error: { message: 'scripted turn failure' } } : {}) } })
  active.delete(threadId)
}
function ask(threadId, state, count) {
  let remaining = count
  for (let index = 0; index < count; index++) {
    const isCommand = index === 0
    const item = isCommand
      ? {
          id: 'command-' + state.turn.id,
          type: 'commandExecution',
          status: 'inProgress',
          command: 'printf approved',
          cwd: process.cwd()
        }
      : {
          id: 'file-' + state.turn.id,
          type: 'fileChange',
          status: 'inProgress',
          changes: [{ path: 'approved.txt', kind: 'add', diff: '+approved' }]
        }
    notify('item/started', { threadId, turnId: state.turn.id, item })
    if (isCommand) {
      notify('item/commandExecution/outputDelta', {
        threadId,
        turnId: state.turn.id,
        itemId: item.id,
        delta: 'approved'
      })
    }
    const id = index === 0 ? 'approval-' + nextApproval++ : nextApproval++
    approvals.set(id, () => {
      notify('item/completed', {
        threadId,
        turnId: state.turn.id,
        item: { ...item, status: 'completed', ...(isCommand ? { aggregatedOutput: 'approved' } : {}) }
      })
      remaining -= 1
      if (remaining === 0) finish(threadId, state.turn)
    })
    send({
      id,
      method: isCommand ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval',
      params: {
        threadId,
        turnId: state.turn.id,
        itemId: item.id,
        ...(isCommand ? { command: 'printf approved', cwd: process.cwd(), reason: 'Scripted command approval' } : { reason: 'Scripted file change approval' })
      }
    })
  }
}
function startTurn(message, threadId, text) {
  const turn = { id: 'turn-' + nextTurn++, status: 'inProgress', items: [] }
  const state = { turn, text, held: text.includes('[hold]') || text.includes('[descendant]') }
  active.set(threadId, state)
  if (text.includes('[descendant]')) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    fs.writeFileSync(logPath + '.pid', String(child.pid))
  }
  if (text.includes('[escaped-stdio]')) {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: ['ignore', 1, 2]
    })
    child.unref()
    fs.writeFileSync(logPath + '.escaped-pid', String(child.pid))
  }

  if (text.includes('[rpc-error]')) {
    send({ id: message.id, error: { code: -32001, message: 'scripted turn request error' } })
    return
  }
  send({ id: message.id, result: { turn } })
  notify('turn/started', { threadId, turn })
  if (state.held) return
  if (text.includes('[unknown]')) {
    const id = 'unknown-' + nextApproval++
    approvals.set(id, () => finish(threadId, turn))
    send({ id, method: 'fixture/unknownRequest', params: { threadId, turnId: turn.id } })
    return
  }
  if (text.includes('[approve twice]')) return ask(threadId, state, 2)
  if (text.includes('[approve]')) return ask(threadId, state, 1)
  if (text.includes('[failed]')) return finish(threadId, turn, 'failed')
  if (text.includes('[interrupted]')) return finish(threadId, turn, 'interrupted')
  if (text.includes('[malformed]')) {
    process.stdout.write('not-json\\n')
    return
  }
  finish(threadId, turn)
}
function receive(message) {
  if (message.method) {
    log(message)
    // Stable wire enum spellings from codex app-server generate-json-schema.
    if ((message.method === 'thread/start' || message.method === 'thread/resume') &&
        (message.params.approvalPolicy !== 'on-request' || message.params.sandbox !== 'workspace-write')) {
      send({ id: message.id, error: { code: -32602, message: 'invalid native approvalPolicy or sandbox enum' } })
      return
    }
    switch (message.method) {
      case 'initialize':
        send({ id: message.id, result: { userAgent: 'codex-fixture', platformFamily: 'unix', platformOs: 'macos' } })
        return
      case 'initialized':
        return
      case 'thread/start': {
        const id = 'scripted-thread'
        send({ id: message.id, result: { thread: { id, sessionId: id } } })
        notify('thread/started', { thread: { id } })
        return
      }
      case 'thread/resume': {
        const id = message.params.threadId
        send({ id: message.id, result: { thread: { id, sessionId: id } } })
        notify('thread/started', { thread: { id } })
        return
      }
      case 'turn/start':
        startTurn(message, message.params.threadId, textInput(message.params.input))
        return
      case 'turn/steer': {
        const threadId = message.params.threadId
        const state = active.get(threadId)
        send({ id: message.id, result: { turnId: message.params.expectedTurnId } })
        if (state && state.turn.id === message.params.expectedTurnId) {
          state.text += '\\n' + textInput(message.params.input)
          state.held = false
          finish(threadId, state.turn)
        }
        return
      }
      case 'turn/interrupt':
        send({ id: message.id, result: {} })
        if (active.has(message.params.threadId)) finish(message.params.threadId, active.get(message.params.threadId).turn, 'interrupted')
        return
      default:
        if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
        return
    }
  }
  if (approvals.has(message.id)) {
    log(message)
    const resolve = approvals.get(message.id)
    approvals.delete(message.id)
    resolve()
  }
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  for (;;) {
    const newline = input.indexOf('\\n')
    if (newline < 0) break
    const line = input.slice(0, newline).replace(/\\r$/, '')
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
    logPath,
    requests() {
      if (!existsSync(logPath)) return []
      return readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const message: unknown = JSON.parse(line)
          if (typeof message !== 'object' || message === null || Array.isArray(message)) {
            throw new Error('Codex fixture log contains a non-object message')
          }
          return message as CodexAppServerLogEntry
        })
    }
  }
}

/** A child environment that cannot read provider credentials/config from the user's home. */
export function isolatedProviderEnvironment(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, QUIRKY_HOME: home }
  for (const key of [
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN'
  ]) delete env[key]
  return env
}
