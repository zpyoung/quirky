import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyEvent, Session } from '@quirky/protocol'
import { startAgentsE2E, type E2E, type StartOptions } from '../support/e2e'

type Info = {
  id: string
  command: string
  commandOverridden: boolean
  args: string
  argsOverridden: boolean
  env: Record<string, string>
  permissions: { mode: string | null }
}

type Listing = {
  permissions: { summary: string }
  agents: Info[]
}

type Plan = {
  command: string
  env: Record<string, string | null>
  promptDelivery: string | null
}

let e2e: E2E | undefined

afterEach(async () => {
  await e2e?.cleanup()
  e2e = undefined
})

async function start(options?: StartOptions): Promise<E2E> {
  e2e = await startAgentsE2E(options)
  return e2e
}

async function cliJson<T>(harness: E2E, args: string[]): Promise<T> {
  const result = await harness.cli([...args, '--json'])
  if (result.code !== 0) throw new Error(`quirky ${args.join(' ')} exited ${result.code}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout) as T
}

const getAgent = (harness: E2E, agent: string) => cliJson<Info>(harness, ['agents', 'get', agent])
const planOf = (harness: E2E, agent: string, ...flags: string[]) => cliJson<Plan>(harness, ['agents', 'plan', agent, ...flags])

async function waitFor<T>(check: () => T | undefined | null | false, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(25)
  }
}

async function recordEvents(harness: E2E): Promise<QuirkyEvent[]> {
  const events: QuirkyEvent[] = []
  harness.client.onEvent((event) => events.push(event))
  await harness.client.call('events.subscribe', {})
  return events
}

const changedCount = (events: QuirkyEvent[]) => events.filter((event) => event.type === 'quirky.agents/changed').length

/** The error text of a call that is expected to fail. */
async function failureOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the call to fail')
}

function startOf(harness: E2E, name: string) {
  const started = harness.fakeLog(name).find((event) => event.type === 'start')
  if (started?.type !== 'start') throw new Error(`fake ${name} never started`)
  return started
}

async function launch(harness: E2E, name: string, params: Record<string, unknown> = {}): Promise<Session> {
  const session = (await harness.call('quirky.session/create', { worktree: `path:${harness.repo}`, agent: name, ...params })) as Session
  await harness.waitForFakeLog(name, (events) => events.some((event) => event.type === 'start'), 15_000)
  return session
}

describe('configuring an agent', () => {
  test(
    'SC-11: a command override replaces the whole command, and clearing it restores the default',
    async () => {
      const harness = await start({ fakes: { claude: true, 'my-claude': true } })

      expect((await harness.cli(['agents', 'configure', 'claude', '--command', 'my-claude'])).code).toBe(0)
      expect((await planOf(harness, 'claude')).command.startsWith('my-claude')).toBe(true)
      expect(await getAgent(harness, 'claude')).toMatchObject({ command: 'my-claude', commandOverridden: true })

      expect((await harness.cli(['agents', 'configure', 'claude', '--command', 'claude'])).code).toBe(0)
      expect((await planOf(harness, 'claude')).command.startsWith('claude')).toBe(true)
      expect(await getAgent(harness, 'claude')).toMatchObject({ command: 'claude', commandOverridden: false })

      await harness.cli(['agents', 'configure', 'claude', '--command', 'my-claude'])
      expect((await harness.cli(['agents', 'configure', 'claude', '--reset', 'command'])).code).toBe(0)
      expect(await getAgent(harness, 'claude')).toMatchObject({ command: 'claude', commandOverridden: false })

      await harness.cli(['agents', 'configure', 'claude', '--command', 'my-claude'])
      const session = (await harness.call('quirky.session/create', { worktree: `path:${harness.repo}`, agent: 'claude' })) as Session
      await harness.waitForFakeLog('my-claude', (events) => events.some((event) => event.type === 'start'), 15_000)
      expect(session.agent).toBe('claude')
      expect(startOf(harness, 'my-claude').argv).toContain('--dangerously-skip-permissions')
    },
    60_000
  )

  test(
    'SC-12: arguments are tokenized and re-quoted, so they never run as shell syntax',
    async () => {
      const harness = await start({ fakes: { claude: true } })
      const pwned = join(harness.userHome, 'pwned')
      const text = `--model "haiku 5" $(touch ${pwned}) ; rm -rf x`

      const saved = await harness.cli(['agents', 'configure', 'claude', `--args=${text}`])
      expect(saved.code).toBe(0)
      expect(await getAgent(harness, 'claude')).toMatchObject({ args: text, argsOverridden: true })

      await launch(harness, 'claude')
      const tokens = ['--model', 'haiku 5', '$(touch', `${pwned})`, ';', 'rm', '-rf', 'x']
      const argv = startOf(harness, 'claude').argv
      expect(argv.slice(0, tokens.length)).toEqual(tokens)
      expect(argv).not.toContain('--dangerously-skip-permissions')
      await Bun.sleep(300)
      expect(existsSync(pwned)).toBe(false)

      const refused = await harness.cli(['agents', 'configure', 'claude', '--args=--model "haiku'])
      expect(refused.code).not.toBe(0)
      expect(refused.stderr + refused.stdout).toContain('CLI arguments are invalid: unterminated quote')
      expect(await getAgent(harness, 'claude')).toMatchObject({ args: text, argsOverridden: true })
    },
    60_000
  )

  test(
    'SC-13: an agent environment comes from its default or the user override',
    async () => {
      const harness = await start({ fakes: { goose: true, codex: true } })

      await launch(harness, 'goose')
      expect(startOf(harness, 'goose').env.GOOSE_MODE).toBe('auto')

      await harness.call('quirky.agents/configure', { agent: 'codex', env: { CODEX_HOME: '/tmp/ch' } })
      await launch(harness, 'codex')
      expect(startOf(harness, 'codex').env.CODEX_HOME).toBe('/tmp/ch')

      for (const name of ['PATH', 'ZDOTDIR', 'QUIRKY_HOME']) {
        const message = await failureOf(harness.call('quirky.agents/configure', { agent: 'codex', env: { [name]: 'x' } }))
        expect(message).toContain(name)
      }
      expect((await getAgent(harness, 'codex')).env).toEqual({ CODEX_HOME: '/tmp/ch' })
    },
    60_000
  )
})

describe('permission modes', () => {
  test(
    'SC-14: untouched arguments mean Yolo',
    async () => {
      const harness = await start()
      const expected: [string, string][] = [
        ['claude', 'claude --dangerously-skip-permissions'],
        ['codex', 'codex --dangerously-bypass-approvals-and-sandbox'],
        ['gemini', 'gemini --yolo'],
        ['aider', 'aider --yes-always'],
        ['devin', 'devin --permission-mode bypass --respect-workspace-trust false']
      ]
      for (const [agent, command] of expected) expect((await planOf(harness, agent)).command.startsWith(command)).toBe(true)

      const goose = await planOf(harness, 'goose')
      expect(goose.command).toBe('goose')
      expect(goose.env.GOOSE_MODE).toBe('auto')
      expect((await planOf(harness, 'opencode')).command).toBe('opencode')
    },
    60_000
  )

  test(
    'SC-15: bulk modes change only preset agents, and Auto only the three that have it',
    async () => {
      const harness = await start()
      const events = await recordEvents(harness)
      await harness.cli(['agents', 'configure', 'claude', '--args=--model haiku'])
      const argsOf = async (agent: string) => (await getAgent(harness, agent)).args
      const summary = async () => (await cliJson<Listing>(harness, ['agents', 'list'])).permissions.summary

      expect((await harness.cli(['agents', 'permissions', 'auto'])).code).toBe(0)
      expect(await argsOf('codex')).toBe('--approve-for-me')
      expect(await argsOf('claude-agent-teams')).toBe('--permission-mode auto')
      expect(await argsOf('claude')).toBe('--model haiku')
      expect(await argsOf('gemini')).toBe('--yolo')
      expect(await summary()).toBe('auto')

      expect((await harness.cli(['agents', 'permissions', 'manual'])).code).toBe(0)
      for (const agent of ['codex', 'gemini', 'claude-agent-teams']) expect(await argsOf(agent)).toBe('')
      expect((await getAgent(harness, 'goose')).env).toEqual({})
      expect(await argsOf('claude')).toBe('--model haiku')
      expect(await summary()).toBe('manual')

      await Bun.sleep(300)
      const before = changedCount(events)
      const again = await cliJson<{ changed: string[] }>(harness, ['agents', 'permissions', 'manual'])
      expect(again.changed).toEqual([])
      await Bun.sleep(500)
      expect(changedCount(events)).toBe(before)
    },
    60_000
  )

  test(
    'SC-16: per-agent modes, custom rows and errors',
    async () => {
      const harness = await start()
      await harness.cli(['agents', 'configure', 'claude', '--args=--model haiku'])
      const failing = async (args: string[], message: string) => {
        const result = await harness.cli(args)
        expect(result.code).not.toBe(0)
        expect(result.stderr + result.stdout).toContain(message)
      }

      await failing(['agents', 'permissions', 'yolo', '--agent', 'claude'], 'claude has custom arguments; pass --replace-custom to replace them')
      expect((await getAgent(harness, 'claude')).args).toBe('--model haiku')

      expect((await harness.cli(['agents', 'permissions', 'yolo', '--agent', 'claude', '--replace-custom'])).code).toBe(0)
      expect((await getAgent(harness, 'claude')).args).toBe('--dangerously-skip-permissions')

      await failing(['agents', 'permissions', 'auto', '--agent', 'gemini'], 'gemini has no Auto mode')
      await failing(['agents', 'permissions', 'yolo', '--agent', 'opencode'], 'opencode has no permission modes')

      expect((await cliJson<Listing>(harness, ['agents', 'list'])).permissions.summary).toBe('yolo')
      expect((await harness.cli(['agents', 'permissions', 'manual', '--agent', 'codex'])).code).toBe(0)
      expect((await cliJson<Listing>(harness, ['agents', 'list'])).permissions.summary).toBe('mixed')
      expect((await harness.cli(['agents', 'permissions', 'yolo'])).code).toBe(0)
      expect((await cliJson<Listing>(harness, ['agents', 'list'])).permissions.summary).toBe('yolo')
    },
    60_000
  )

  test(
    'SC-17: opencode and kilo never receive the Claude bypass flag',
    async () => {
      const harness = await start()
      await harness.call('quirky.agents/configure', { agent: 'opencode', args: '--dangerously-skip-permissions --model x' })

      expect((await harness.call('quirky.agents/plan', { agent: 'opencode' })) as Plan).toMatchObject({ command: 'opencode --model x' })
    },
    60_000
  )
})

describe('plan', () => {
  test(
    'SC-29: plan shows a launch without starting it',
    async () => {
      const harness = await start({ fakes: { grok: true } })

      const text = await harness.cli(['agents', 'plan', 'grok', '--prompt', 'help'])
      expect(text.code).toBe(0)
      expect(text.stdout).toContain("grok --permission-mode bypassPermissions -- 'help'")
      expect(text.stdout).toContain('command-line')
      expect(text.stdout).toContain('env:')

      const plan = await planOf(harness, 'grok', '--prompt', 'help')
      expect(plan).toMatchObject({ command: "grok --permission-mode bypassPermissions -- 'help'", promptDelivery: 'command-line' })

      expect(await cliJson<Session[]>(harness, ['session', 'list'])).toEqual([])
      expect(harness.fakeLog('grok')).toEqual([])
    },
    60_000
  )
})
