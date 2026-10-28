import { afterEach, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Session, type StructuredMessage } from '@quirky/protocol'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { createClaudeRunner } from '../claude-runner'
import { createCodexRunner } from '../codex-runner'
import type { NewStructuredMessage, StructuredContext } from '../runner'
import { createCodexAppServerFixture, isolatedProviderEnvironment } from './fakes/codex-app-server'
import { FakeQuery } from './fakes/fake-query'

const ENV_KEYS = ['HOME', 'QUIRKY_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const
let home: string | undefined
let priorEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

function isolatedHome(): string {
  home = mkdtempSync('/tmp/qs-usage-limits-')
  const claudeHome = join(home, 'providers', 'claude')
  const codexHome = join(home, 'providers', 'codex')
  mkdirSync(claudeHome, { recursive: true })
  mkdirSync(codexHome, { recursive: true })
  priorEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as typeof priorEnv
  process.env.HOME = home
  process.env.QUIRKY_HOME = home
  process.env.CLAUDE_CONFIG_DIR = claudeHome
  process.env.CODEX_HOME = codexHome
  return home
}

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true })
  home = undefined
  for (const key of ENV_KEYS) {
    const value = priorEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  priorEnv = {}
})

function session(agent: 'claude' | 'codex', cwd: string): Session {
  return {
    id: `s_${agent}_usage_limit`,
    kind: 'structured',
    agent,
    worktreeId: 'wt_test',
    cwd,
    title: `${agent} usage test`,
    status: 'starting',
    createdAt: 1,
    lastActivityAt: 1,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false
  }
}

function contextFor(options: { codexPath?: string; claudePath?: string } = {}) {
  const messages: StructuredMessage[] = []
  const statuses: string[] = []
  const context: StructuredContext = {
    appendMessage(input: NewStructuredMessage) {
      const message: StructuredMessage = {
        sessionId: input.sessionId,
        seq: messages.filter((current) => current.sessionId === input.sessionId).length + 1,
        role: input.role,
        text: input.text,
        at: input.at ?? Date.now(),
        ...(input.data === undefined ? {} : { data: input.data })
      }
      messages.push(message)
      return message
    },
    setStatus(_sessionId, status) {
      statuses.push(status)
    },
    async createAsk() {
      throw new Error('no approval expected in usage-limit tests')
    },
    async setProviderSession() {},
    async resolveClaudePath() {
      return options.claudePath ?? '/isolated/claude-fixture'
    },
    async resolveCodexPath() {
      return options.codexPath ?? '/isolated/codex-fixture'
    }
  }
  return { context, messages, statuses }
}

describe('provider usage-limit journal evidence', () => {
  test('an empty Codex start is idle and raw account/rateLimits/updated params survive in the journal', async () => {
    const testHome = isolatedHome()
    const fixture = createCodexAppServerFixture(join(testHome, 'provider-fixtures'))
    const threadId = `rate-limit-${randomUUID()}`
    const original = readFileSync(fixture.executable, 'utf8')
    const threadStart = "const id = uniqueThreads ? 'scripted-thread-' + require('node:crypto').randomUUID() : 'scripted-thread'"
    const startTurn = "      case 'turn/start':\n        startTurn(message, message.params.threadId, textInput(message.params.input))"
    expect(original.includes(threadStart)).toBe(true)
    expect(original.includes(startTurn)).toBe(true)
    const rawParams = {
      threadId,
      exhausted: true,
      rateLimits: { primary: { usedPercent: 100, resetsAt: '2030-01-02T03:04:05.000Z' } }
    }
    const updated = original
      .replace(threadStart, `const id = ${JSON.stringify(threadId)}`)
      .replace(startTurn, `      case 'turn/start':\n        notify('account/rateLimits/updated', ${JSON.stringify(rawParams)})\n        startTurn(message, message.params.threadId, textInput(message.params.input))`)
    writeFileSync(fixture.executable, updated)
    chmodSync(fixture.executable, 0o700)

    const { context, messages, statuses } = contextFor({ codexPath: fixture.executable })
    const runner = createCodexRunner(context, { env: isolatedProviderEnvironment(testHome) })
    const codexSession = session('codex', testHome)
    try {
      await runner.start(codexSession, '')
      expect(statuses.at(-1)).toBe('running')
      expect(messages).toEqual([])
      await runner.send(codexSession.id, 'inspect the limit')
      const update = await waitFor(() => messages.find((message) => {
        const data = message.data
        return message.role === 'system' && typeof data === 'object' && data !== null &&
          'method' in data && data.method === 'account/rateLimits/updated'
      }))
      expect(update?.data).toEqual({ method: 'account/rateLimits/updated', params: rawParams })
      expect(update?.data).toHaveProperty('params.exhausted', true)
      expect(update?.data).toHaveProperty('params.rateLimits.primary.resetsAt', '2030-01-02T03:04:05.000Z')
    } finally {
      await runner.stop(codexSession.id)
    }
  })

  test('an empty Claude start is idle and raw rate_limit_event data survives in the journal', async () => {
    const testHome = isolatedHome()
    const query = { value: undefined as FakeQuery | undefined }
    const { context, messages, statuses } = contextFor()
    const runner = createClaudeRunner(context, {
      query: (params) => {
        query.value = new FakeQuery(params)
        return query.value
      }
    })
    const claudeSession = session('claude', testHome)
    const rawEvent = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resets_at: '2030-01-02T03:04:05.000Z', is_exhausted: true }
    }
    try {
      await runner.start(claudeSession, '')
      expect(statuses.at(-1)).toBe('running')
      expect(messages).toEqual([])
      query.value!.emit(rawEvent)
      const update = await waitFor(() => messages.find((message) => {
        const data = message.data
        return message.role === 'system' && typeof data === 'object' && data !== null &&
          'type' in data && data.type === 'rate_limit_event'
      }))
      expect(update?.data).toEqual(rawEvent)
      expect(update?.data).toHaveProperty('rate_limit_info.is_exhausted', true)
      expect(update?.data).toHaveProperty('rate_limit_info.resets_at', '2030-01-02T03:04:05.000Z')
    } finally {
      await runner.stop(claudeSession.id)
    }
  })
})
