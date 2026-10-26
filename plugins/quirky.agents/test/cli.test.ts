import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ApiDescription, CliContext, QuirkyClient } from '@quirky/protocol'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import { testCliContext } from '../../quirky.session/test/support'
import { commands } from '../cli'

const PLUGIN_DIR = join(import.meta.dir, '..')
const ENV_NAMES = ['HOME', 'QUIRKY_AGENT_SEARCH_DIRS'] as const
const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]))

type Fixture = { h: Harness; client: QuirkyClient }
const fixtures: Fixture[] = []

/** A daemon whose login shell sees only fake `claude` and `codex`, with trust writing off and HOME in a temp dir. */
async function start(plugins: Record<string, unknown>[] = []): Promise<Fixture> {
  const home = mkdtempSync('/tmp/qag-c-')
  const userHome = join(home, 'user')
  const bin = join(home, 'bin')
  mkdirSync(userHome, { recursive: true })
  mkdirSync(bin, { recursive: true })
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, name), 0o755)
  }
  const shell = join(home, 'login-shell')
  writeFileSync(shell, `#!/bin/sh\necho ${bin}\n`)
  chmodSync(shell, 0o755)
  const builtin = join(home, 'builtin')
  mkdirSync(builtin)
  symlinkSync(PLUGIN_DIR, join(builtin, 'quirky.agents'))
  for (const manifest of plugins) writePlugin(join(home, 'plugins'), { version: '1.0.0', ...manifest, name: manifest.id })

  process.env.HOME = userHome
  process.env.QUIRKY_AGENT_SEARCH_DIRS = ''
  const h = await startHarness({ home, shell, builtinPluginsDir: builtin })
  const client = await h.connect('cli')
  await client.callAny('setting.set', { id: 'setting:quirky.agents/workspace-trust', value: false })
  const fixture = { h, client }
  fixtures.push(fixture)
  return fixture
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.h.cleanup()
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

const run = async (name: keyof typeof commands, ctx: CliContext, positionals: string[] = [], flags: Record<string, unknown> = {}) =>
  commands[name]!({ positionals, flags }, ctx)

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { kind?: string }
  }
  throw new Error('expected a failure')
}

const cells = (line: string) => line.trim().split(/\s{2,}/)

describe('agents list', () => {
  test('SC-1: prints the table and the default and permission summary', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('list', ctx)
    const rows = lines[0]!.split('\n')
    expect(cells(rows[0]!)).toEqual(['ID', 'LABEL', 'INSTALLED', 'ENABLED', 'DEFAULT', 'PERMISSIONS', 'PROMPT', 'RESUME'])
    expect(rows).toHaveLength(1 + 45 + 1)
    expect(cells(rows[1]!)).toEqual(['claude', 'Claude', 'yes', 'yes', 'no', 'yolo', 'argv', 'yes'])
    const opencode = rows.find((row) => row.startsWith('opencode '))!
    expect(cells(opencode)[5]).toBe('-')
    expect(cells(rows.find((row) => row.startsWith('aider '))!)).toEqual(['aider', 'Aider', 'no', 'yes', 'no', 'yolo', 'stdin-after-start', 'no'])
    expect(rows.at(-1)).toBe('default: auto  permissions: yolo')
  })

  test('--json prints the method result', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client, { json: true })
    await run('list', ctx)
    expect(JSON.parse(lines[0]!)).toEqual(await client.callAny('quirky.agents/list', {}))
  })

  test('SC-4: --all prints the problems after the summary', async () => {
    const { client } = await start([{ id: 'acme.bad', contributes: { agent: [{ id: 'broken', label: 'Broken', prompt: 'argv' }] } }])
    const plain = testCliContext(client)
    await run('list', plain.ctx)
    expect(plain.lines[0]).not.toContain('acme.bad')

    const { ctx, lines } = testCliContext(client)
    await run('list', ctx, [], { all: true })
    const rows = lines[0]!.split('\n')
    expect(rows.slice(-2)).toEqual(['default: auto  permissions: yolo', 'acme.bad broken invalid: detect command is required'])

    const json = testCliContext(client, { json: true })
    await run('list', json.ctx, [], { all: true })
    expect(JSON.parse(json.lines[0]!).problems).toHaveLength(1)
  })
})

describe('agents get', () => {
  test('prints a record and refuses an unknown agent', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('get', ctx, ['claude'])
    expect(lines[0]).toContain('id: claude')
    expect(lines[0]).toContain('label: Claude')
    expect(lines[0]).toContain('installed: yes')
    expect(lines[0]).toContain('command: claude')
    expect(lines[0]).toContain('command override: no')
    expect(lines[0]).toContain('args: --dangerously-skip-permissions')
    expect(lines[0]).toContain('permissions: yolo')
    expect(lines[0]).toContain('homepage: https://code.claude.com/docs')

    const json = testCliContext(client, { json: true })
    await run('get', json.ctx, ['codex'])
    expect(JSON.parse(json.lines[0]!)).toMatchObject({ id: 'codex', installed: true })

    expect((await failure(run('get', ctx, ['nope']))).message).toBe('unknown agent: nope')
    expect(await failure(run('get', ctx))).toMatchObject({ message: 'missing <agent>', kind: 'usage' })
  })
})

describe('agents refresh', () => {
  test('re-detects and prints the listing', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('refresh', ctx)
    expect(lines[0]!.split('\n')[0]).toContain('INSTALLED')
    const json = testCliContext(client, { json: true })
    await run('refresh', json.ctx)
    expect(JSON.parse(json.lines[0]!).agents).toHaveLength(45)
  })
})

describe('enable, disable and default', () => {
  test('SC-10: disable then enable one agent and print one line each', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('default', ctx, ['claude'])
    await run('disable', ctx, ['claude'])
    expect(lines).toEqual(['default agent: claude', 'disabled claude'])
    const listing: any = await client.callAny('quirky.agents/list', {})
    expect(listing.defaultAgent).toBe('auto')
    expect(listing.agents.find((a: any) => a.id === 'claude').enabled).toBe(false)

    lines.length = 0
    await run('enable', ctx, ['claude'])
    expect(lines).toEqual(['enabled claude'])
    expect(((await client.callAny('quirky.agents/get', { agent: 'claude' })) as any).enabled).toBe(true)
  })

  test('--json prints the method result', async () => {
    const { client } = await start()
    const json = testCliContext(client, { json: true })
    await run('disable', json.ctx, ['codex'])
    await run('default', json.ctx, ['shell'])
    expect(JSON.parse(json.lines[0]!)).toMatchObject({ id: 'codex', enabled: false })
    expect(JSON.parse(json.lines[1]!)).toMatchObject({ defaultAgent: 'shell' })
  })

  test('need an agent, and refuse an unknown one', async () => {
    const { client } = await start()
    const { ctx } = testCliContext(client)
    for (const name of ['enable', 'disable', 'default'] as const) {
      expect(await failure(run(name, ctx))).toMatchObject({ message: 'missing <agent>', kind: 'usage' })
    }
    expect((await failure(run('disable', ctx, ['nope']))).message).toBe('unknown agent: nope')
  })
})

describe('agents configure', () => {
  test('SC-11: a command override replaces the command, and --reset command restores it', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('configure', ctx, ['claude'], { command: 'my-claude' })
    expect(lines).toEqual(['configured claude'])
    expect(await client.callAny('quirky.agents/get', { agent: 'claude' })).toMatchObject({ command: 'my-claude', commandOverridden: true })

    await run('configure', ctx, ['claude'], { reset: ['command'] })
    expect(await client.callAny('quirky.agents/get', { agent: 'claude' })).toMatchObject({ command: 'claude', commandOverridden: false })
  })

  test('SC-12: arguments are saved as given, and bad quoting is refused', async () => {
    const { client } = await start()
    const { ctx } = testCliContext(client)
    await run('configure', ctx, ['claude'], { args: '--model "haiku 5" $(touch /tmp/pwned)' })
    expect(await client.callAny('quirky.agents/get', { agent: 'claude' })).toMatchObject({
      args: '--model "haiku 5" $(touch /tmp/pwned)',
      argsOverridden: true
    })
    const error = await failure(run('configure', ctx, ['claude'], { args: '--model "haiku' }))
    expect(error.message).toBe('CLI arguments are invalid: unterminated quote')
    expect(await client.callAny('quirky.agents/get', { agent: 'claude' })).toMatchObject({ args: '--model "haiku 5" $(touch /tmp/pwned)' })
  })

  test('repeated --env flags become one environment, and a reserved name is refused', async () => {
    const { client } = await start()
    const { ctx } = testCliContext(client)
    await run('configure', ctx, ['codex'], { env: ['CODEX_HOME=/tmp/ch', 'A=b=c', 'EMPTY='] })
    expect(await client.callAny('quirky.agents/get', { agent: 'codex' })).toMatchObject({
      env: { CODEX_HOME: '/tmp/ch', A: 'b=c', EMPTY: '' },
      envOverridden: true
    })
    await run('configure', ctx, ['codex'], { reset: ['env', 'args'] })
    expect(await client.callAny('quirky.agents/get', { agent: 'codex' })).toMatchObject({ envOverridden: false, argsOverridden: false })
    await failure(run('configure', ctx, ['codex'], { env: ['PATH=/x'] }))
  })

  test('--env without = is a usage error that saves nothing', async () => {
    const { client } = await start()
    const { ctx } = testCliContext(client)
    expect(await failure(run('configure', ctx, ['codex'], { env: ['CODEX_HOME'] }))).toMatchObject({
      message: '--env expects KEY=VALUE, got "CODEX_HOME"',
      kind: 'usage'
    })
    expect(await failure(run('configure', ctx, ['codex'], { env: ['=x'] }))).toMatchObject({ kind: 'usage' })
    expect(await failure(run('configure', ctx))).toMatchObject({ message: 'missing <agent>', kind: 'usage' })
    expect(await client.callAny('quirky.agents/get', { agent: 'codex' })).toMatchObject({ envOverridden: false })
  })

  test('--json prints the updated agent', async () => {
    const { client } = await start()
    const json = testCliContext(client, { json: true })
    await run('configure', json.ctx, ['claude'], { command: 'my-claude' })
    expect(JSON.parse(json.lines[0]!)).toMatchObject({ id: 'claude', command: 'my-claude' })
  })
})

describe('agents permissions', () => {
  test('SC-15: bulk modes print the agents they changed, then "no changes"', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('configure', ctx, ['claude'], { args: '--model haiku' })
    lines.length = 0
    await run('permissions', ctx, ['auto'])
    expect(lines[0]).toMatch(/^changed: .*codex/)
    expect(lines[0]).toContain('claude-agent-teams')
    expect(lines[0]).not.toContain('gemini')

    lines.length = 0
    await run('permissions', ctx, ['manual'])
    expect(lines[0]).toMatch(/^changed: /)
    lines.length = 0
    await run('permissions', ctx, ['manual'])
    expect(lines).toEqual(['no changes'])
    expect(await client.callAny('quirky.agents/get', { agent: 'claude' })).toMatchObject({ args: '--model haiku' })
  })

  test('SC-16: per-agent modes, custom rows and errors', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('configure', ctx, ['claude'], { args: '--model haiku' })
    lines.length = 0
    expect((await failure(run('permissions', ctx, ['yolo'], { agent: 'claude' }))).message).toBe(
      'claude has custom arguments; pass --replace-custom to replace them'
    )
    await run('permissions', ctx, ['yolo'], { agent: 'claude', 'replace-custom': true })
    expect(lines).toEqual(['changed: claude'])
    expect(await client.callAny('quirky.agents/get', { agent: 'claude' })).toMatchObject({ args: '--dangerously-skip-permissions' })
    expect((await failure(run('permissions', ctx, ['auto'], { agent: 'gemini' }))).message).toBe('gemini has no Auto mode')
    expect((await failure(run('permissions', ctx, ['yolo'], { agent: 'opencode' }))).message).toBe('opencode has no permission modes')
  })

  test('--json prints the method result, and the mode must be known', async () => {
    const { client } = await start()
    const json = testCliContext(client, { json: true })
    await run('permissions', json.ctx, ['manual'])
    const result = JSON.parse(json.lines[0]!)
    expect(result.summary).toBe('manual')
    expect(result.changed.length).toBeGreaterThan(0)

    const { ctx } = testCliContext(client)
    expect(await failure(run('permissions', ctx, ['bypass']))).toMatchObject({
      message: 'mode must be one of manual, auto, yolo',
      kind: 'usage'
    })
    expect(await failure(run('permissions', ctx))).toMatchObject({ message: 'missing <mode>', kind: 'usage' })
  })
})

describe('agents plan', () => {
  test('SC-29: prints the command, the prompt delivery and the environment without starting anything', async () => {
    const { h, client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('plan', ctx, ['grok'], { prompt: 'help' })
    expect(lines[0]).toBe("command: grok --permission-mode bypassPermissions -- 'help'\nprompt: command-line\nenv: -")
    expect(h.pty.requests.some((r) => r.type === 'create')).toBe(false)
  })

  test('shows the environment additions, no prompt as none and a draft as pending', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('plan', ctx, ['goose'])
    expect(lines[0]).toContain('prompt: none')
    expect(lines[0]).toContain('env: GOOSE_MODE=auto')

    lines.length = 0
    await run('plan', ctx, ['claude'], { prompt: 'x', draft: true })
    expect(lines[0]).toContain('--prefill')
    expect(lines[0]).toContain('prompt: command-line')

    const json = testCliContext(client, { json: true })
    await run('plan', json.ctx, ['codex'], { prompt: 'x' })
    expect(JSON.parse(json.lines[0]!)).toMatchObject({ agent: 'codex', promptDelivery: expect.any(String) })
  })

  test('needs an agent and refuses an unknown one', async () => {
    const { client } = await start()
    const { ctx } = testCliContext(client)
    expect(await failure(run('plan', ctx))).toMatchObject({ message: 'missing <agent>', kind: 'usage' })
    expect((await failure(run('plan', ctx, ['nope']))).message).toBe('unknown agent: nope')
  })
})

describe('the CLI catalog', () => {
  test('lists the agents group with every command and the methods each calls', async () => {
    const { client } = await start()
    const api = (await client.callAny('api.describe', {})) as ApiDescription
    expect(api.cli.groups.find((g) => g.plugin === 'quirky.agents')).toEqual({ plugin: 'quirky.agents', words: 'agents', aliases: [] })
    const own = api.cli.commands.filter((c) => c.plugin === 'quirky.agents')
    expect(own.map((c) => c.words).sort()).toEqual([
      'agents configure',
      'agents default',
      'agents disable',
      'agents enable',
      'agents get',
      'agents list',
      'agents permissions',
      'agents plan',
      'agents refresh'
    ])
    expect(own.every((c) => c.module?.endsWith('/quirky.agents/cli.ts'))).toBe(true)
    expect(own.find((c) => c.words === 'agents disable')!.methods).toEqual(['quirky.agents/setEnabled'])
  })

  test('quirky agents list --json resolves through the real CLI', async () => {
    const { h, client } = await start()
    const result = await runCli(['agents', 'list', '--json'], { home: h.home })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(await client.callAny('quirky.agents/list', {}))
  })
})
