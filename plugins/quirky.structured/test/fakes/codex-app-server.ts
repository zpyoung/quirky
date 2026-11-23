import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type CodexAppServerLogEntry = {
  id?: string | number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: unknown
}

export type CodexAppServerEnvironment = { CODEX_HOME: string | null }

type FixtureNotification = { method: string; params?: Record<string, unknown> }
type FixtureServerRequest = { method: string; params?: Record<string, unknown>; id?: string | number }
type FixtureConfigRead = {
  mcpServers?: unknown
  reply?: unknown
  error?: { code: number; message: string }
  timeout?: boolean
}
type FixtureTurnScript = {
  notifications?: FixtureNotification[]
  serverRequests?: FixtureServerRequest[]
  interrupt?: 'success' | 'error' | 'timeout'
  /**
   * Fails `turn/interrupt` for the scripted child threads only, so the parent's own interrupt still succeeds.
   * `error-once` fails just the first child interrupt.
   */
  childInterrupt?: 'error' | 'error-once'
  hold?: boolean
}
/**
 * A scripted sub-agent thread, started when the parent's scripted turn starts (needs `turnScript`).
 * `announce: false` skips its `thread/started`, for a thread the runner sees without an announcement.
 * Notifications and server requests default their params to this thread and its turn.
 */
type FixtureChildThread = {
  id: string
  parentThreadId?: string
  agentNickname?: string
  agentRole?: string
  turnId?: string
  announce?: boolean
  notifications?: FixtureNotification[]
  serverRequests?: FixtureServerRequest[]
}
type CodexAppServerOptions = {
  childThreads?: FixtureChildThread[]
  heldPrefix?: string
  uniqueThreads?: boolean
  rateLimitsUpdated?: Record<string, unknown>
  rateLimitsRead?: Record<string, unknown>
  skills?: Record<string, unknown>[] | 'silent'
  allowDenyAllEnums?: boolean
  configRead?: FixtureConfigRead
  turnScript?: FixtureTurnScript
  threadNotifications?: FixtureNotification[]
  replyDelayMs?: Record<string, number>
}

export type CodexAppServerFixture = {
  executable: string
  logPath: string
  environmentLogPath: string
  requests(): CodexAppServerLogEntry[]
  serverRequests(): CodexAppServerLogEntry[]
  environments(): CodexAppServerEnvironment[]
  arguments(): string[]
  processId(): number | null
}

function readMessages(path: string): CodexAppServerLogEntry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
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

/**
 * Writes a deterministic native-protocol app-server executable under a test's temporary home.
 * The executable accepts `app-server`, speaks JSONL on stdio, and never contacts a provider.
 */
export function createCodexAppServerFixture(home: string, options?: CodexAppServerOptions): CodexAppServerFixture {
  mkdirSync(home, { recursive: true })
  const executable = join(home, 'codex-app-server-fixture')
  const logPath = join(home, 'codex-app-server.jsonl')
  const serverRequestsPath = join(home, 'codex-app-server-server-requests.jsonl')
  const environmentLogPath = join(home, 'codex-app-server-environments.jsonl')
  const script = `#!${process.execPath}
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const logPath = ${JSON.stringify(logPath)}
const serverRequestsPath = ${JSON.stringify(serverRequestsPath)}
const environmentLogPath = ${JSON.stringify(environmentLogPath)}
const heldPrefix = ${JSON.stringify(options?.heldPrefix ?? null)}
const uniqueThreads = ${JSON.stringify(options?.uniqueThreads ?? false)}
const rateLimitsUpdated = ${JSON.stringify(options?.rateLimitsUpdated ?? null)}
const rateLimitsRead = ${JSON.stringify(options?.rateLimitsRead ?? null)}
const skills = ${JSON.stringify(options?.skills ?? [])}
const configRead = JSON.parse(${JSON.stringify(JSON.stringify(options?.configRead ?? null))})
const turnScript = ${JSON.stringify(options?.turnScript ?? null)}
const childThreads = ${JSON.stringify(options?.childThreads ?? [])}
const threadNotifications = ${JSON.stringify(options?.threadNotifications ?? [])}
let childInterruptFailed = false
const replyDelayMs = ${JSON.stringify(options?.replyDelayMs ?? {})}
let input = ''
let nextTurn = 1
let nextApproval = 1
const active = new Map()
const approvals = new Map()
const scriptedRequests = new Map()
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const notify = (method, params) => send({ method, params })
const log = (message) => fs.appendFileSync(logPath, JSON.stringify(message) + '\\n')
const serverRequest = (message) => {
  fs.appendFileSync(serverRequestsPath, JSON.stringify(message) + '\\n')
  send(message)
}
fs.appendFileSync(environmentLogPath, JSON.stringify({ CODEX_HOME: process.env.CODEX_HOME ?? null }) + '\\n')
fs.writeFileSync(logPath + '.argv', JSON.stringify(process.argv.slice(2)))
fs.writeFileSync(logPath + '.server-pid', String(process.pid))
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
    serverRequest({
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
function emitThreadNotifications(threadId) {
  if (threadNotifications.length === 0) return
  setTimeout(() => {
    for (const event of threadNotifications) notify(event.method, event.params ?? { threadId })
  }, 100)
}
function startChildThreads(threadId) {
  for (const child of childThreads) {
    const turnId = child.turnId ?? 'child-turn-1'
    if (child.announce !== false) {
      notify('thread/started', { thread: { id: child.id, parentThreadId: child.parentThreadId ?? threadId, agentNickname: child.agentNickname ?? null, agentRole: child.agentRole ?? null } })
    }
    notify('turn/started', { threadId: child.id, turn: { id: turnId, status: 'inProgress', items: [] } })
    for (const event of child.notifications ?? []) notify(event.method, event.params ?? { threadId: child.id, turnId })
    const requests = child.serverRequests ?? []
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index]
      const id = request.id ?? 'child-' + child.id + '-' + (index + 1)
      scriptedRequests.set(id, child.id)
      serverRequest({ id, method: request.method, params: request.params ?? { threadId: child.id, turnId } })
    }
  }
}
function runTurnScript(threadId, state) {
  startChildThreads(threadId)
  for (const event of turnScript.notifications ?? []) notify(event.method, event.params ?? { threadId, turnId: state.turn.id })
  const requests = turnScript.serverRequests ?? []
  state.scriptedRequestsRemaining = requests.length
  for (let index = 0; index < requests.length; index++) {
    const request = requests[index]
    const id = request.id ?? 'scripted-' + (index + 1)
    scriptedRequests.set(id, threadId)
    serverRequest({
      id,
      method: request.method,
      params: request.params ?? { threadId, turnId: state.turn.id }
    })
  }
  if (requests.length === 0 && !turnScript.hold) finish(threadId, state.turn)
}
function startTurn(message, threadId, text) {
  const turn = { id: 'turn-' + nextTurn++, status: 'inProgress', items: [] }
  const state = { turn, text, held: text.includes('[hold]') || text.includes('[descendant]'), scriptedRequestsRemaining: 0 }
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
  if (state.held) {
    if (heldPrefix) {
      const item = { id: 'prefix-' + turn.id, type: 'agentMessage', phase: 'commentary', text: heldPrefix }
      notify('item/started', { threadId, turnId: turn.id, item: { ...item, text: '' } })
      notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: item.id, delta: heldPrefix })
      notify('item/completed', { threadId, turnId: turn.id, item })
    }
    return
  }
  if (turnScript !== null) return runTurnScript(threadId, state)
  if (text.includes('[unknown]')) {
    const id = 'unknown-' + nextApproval++
    approvals.set(id, () => finish(threadId, turn))
    serverRequest({ id, method: 'fixture/unknownRequest', params: { threadId, turnId: turn.id } })
    return
  }
  if (text.includes('[native question]') || text.includes('[native secret]')) {
    const id = 'question-' + nextApproval++
    approvals.set(id, () => finish(threadId, turn))
    serverRequest({
      id,
      method: 'item/tool/requestUserInput',
      params: {
        threadId, turnId: turn.id,
        questions: [{ id: 'destination', header: 'Target', question: 'Where next?', isSecret: text.includes('[native secret]'), options: [{ label: 'Local' }, { label: 'Remote' }] }]
      }
    })
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
        (!['untrusted', 'on-request', 'never'].includes(message.params.approvalPolicy) ||
          !['read-only', 'workspace-write', 'danger-full-access'].includes(message.params.sandbox) ||
          (message.params.approvalsReviewer !== undefined && !['user', 'auto_review', 'guardian_subagent'].includes(message.params.approvalsReviewer)))) {
      send({ id: message.id, error: { code: -32602, message: 'invalid native approvalPolicy or sandbox enum' } })
      return
    }
    switch (message.method) {
      case 'initialize':
        send({ id: message.id, result: { userAgent: 'codex-fixture', platformFamily: 'unix', platformOs: 'macos' } })
        return
      case 'initialized':
        return
      case 'config/read': {
        if (configRead === null) {
          if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
          return
        }
        if (configRead.timeout) return
        if (configRead.error) {
          send({ id: message.id, error: configRead.error })
          return
        }
        const result = Object.prototype.hasOwnProperty.call(configRead, 'reply')
          ? configRead.reply
          : { config: { mcp_servers: configRead.mcpServers } }
        send({ id: message.id, result })
        return
      }
      case 'thread/start': {
        const id = uniqueThreads ? 'scripted-thread-' + require('node:crypto').randomUUID() : 'scripted-thread'
        send({ id: message.id, result: { thread: { id, sessionId: id } } })
        notify('thread/started', { thread: { id } })
        emitThreadNotifications(id)
        return
      }
      case 'thread/fork': {
        const id = 'forked-' + message.params.threadId
        send({ id: message.id, result: { thread: { id, sessionId: id, path: '/rollouts/' + id + '.jsonl' } } })
        return
      }
      case 'thread/resume': {
        const id = message.params.threadId
        send({ id: message.id, result: { thread: { id, sessionId: id } } })
        notify('thread/started', { thread: { id } })
        emitThreadNotifications(id)
        return
      }
      case 'turn/start':
        if (rateLimitsUpdated) notify('account/rateLimits/updated', rateLimitsUpdated)
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
        if (turnScript?.interrupt === 'timeout') return
        if (turnScript?.childInterrupt === 'error-once' && !childInterruptFailed && childThreads.some((child) => child.id === message.params.threadId)) {
          childInterruptFailed = true
          send({ id: message.id, error: { code: -32001, message: 'scripted child interrupt failure' } })
          return
        }
        if (turnScript?.childInterrupt === 'error' && childThreads.some((child) => child.id === message.params.threadId)) {
          send({ id: message.id, error: { code: -32001, message: 'scripted child interrupt failure' } })
          return
        }
        if (turnScript?.interrupt === 'error') {
          send({ id: message.id, error: { code: -32001, message: 'scripted interrupt failure' } })
          return
        }
        if (active.get(message.params.threadId)?.text.includes('[ignore-interrupt]')) return
        send({ id: message.id, result: {} })
        if (active.has(message.params.threadId)) finish(message.params.threadId, active.get(message.params.threadId).turn, 'interrupted')
        return
      case 'skills/list':
        if (skills === 'silent') return
        send({ id: message.id, result: { data: (message.params.cwds ?? []).map((cwd) => ({ cwd, skills, errors: [] })) } })
        return
      case 'account/rateLimits/read':
        if (rateLimitsRead === null) {
          if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
        } else send({ id: message.id, result: rateLimitsRead })
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
    return
  }
  if (scriptedRequests.has(message.id)) {
    log(message)
    const threadId = scriptedRequests.get(message.id)
    scriptedRequests.delete(message.id)
    const state = active.get(threadId)
    if (state) {
      state.scriptedRequestsRemaining -= 1
      if (state.scriptedRequestsRemaining === 0 && !turnScript.hold) finish(threadId, state.turn)
    }
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
    if (line) {
      const message = JSON.parse(line)
      const delay = message.method ? replyDelayMs[message.method] : undefined
      if (delay > 0) setTimeout(() => receive(message), delay)
      else receive(message)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`
  writeFileSync(executable, script, { mode: 0o700 })
  chmodSync(executable, 0o700)
  return {
    executable,
    logPath,
    environmentLogPath,
    requests() {
      return readMessages(logPath)
    },
    serverRequests() {
      return readMessages(serverRequestsPath)
    },
    environments() {
      if (!existsSync(environmentLogPath)) return []
      return readFileSync(environmentLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as CodexAppServerEnvironment)
    },
    arguments() {
      if (!existsSync(logPath + '.argv')) return []
      return JSON.parse(readFileSync(logPath + '.argv', 'utf8')) as string[]
    },
    processId() {
      if (!existsSync(logPath + '.server-pid')) return null
      return Number(readFileSync(logPath + '.server-pid', 'utf8'))
    }
  }
}

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
