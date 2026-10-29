import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliContext, QuirkyClient } from '@quirky/protocol'
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

  test('runtime config changes execute on the saved owner target and phone-target rejection never falls back locally', async () => {
    const source = await start()
    const target = await start()
    const targetIdentity = {
      id: 'runtime-target-id',
      name: 'Target owner',
      endpoint: 'wss://target.invalid',
      grantId: 'owner-grant-id'
    }
    const { ctx, lines } = testCliContext(source.client)
    const localCall = ctx.call
    const routed: { runtime: string; method: string; params: Record<string, unknown> }[] = []
    ctx.call = async (method, params = {}) => {
      if (method !== 'quirky.cli/runtimeCall') return localCall(method, params)
      const runtime = params.runtime
      const remoteMethod = params.method
      const remoteParams = params.params
      if (typeof runtime !== 'string' || typeof remoteMethod !== 'string' ||
        typeof remoteParams !== 'object' || remoteParams === null || Array.isArray(remoteParams)) {
        throw new Error('malformed runtime call')
      }
      routed.push({ runtime, method: remoteMethod, params: remoteParams as Record<string, unknown> })
      if (runtime === 'phone-only') throw ctx.fail('phone credentials cannot administer owner runtimes')
      return { runtime: targetIdentity, result: await target.client.callAny(remoteMethod, remoteParams as Record<string, unknown>) }
    }

    await run('configure', ctx, ['claude'], { host: 'runtime:target-owner', command: 'remote-claude' })
    expect(routed).toEqual([{
      runtime: 'target-owner',
      method: 'quirky.agents/configure',
      params: { agent: 'claude', command: 'remote-claude' }
    }])
    expect(lines[0]).toContain('Target owner')
    expect(await target.client.callAny('quirky.agents/get', { agent: 'claude' }))
      .toMatchObject({ command: 'remote-claude', commandOverridden: true })
    expect(await source.client.callAny('quirky.agents/get', { agent: 'claude' }))
      .toMatchObject({ command: 'claude', commandOverridden: false })
    await run('discoverModels', ctx, ['claude'], { host: 'runtime:target-owner' })
    expect(routed[1]).toEqual({
      runtime: 'target-owner',
      method: 'quirky.agents/discoverModels',
      params: { agent: 'claude', host: 'local' }
    })
    expect(lines[1]).toContain('Runtime: Target owner')
    expect(lines[1]).toContain('claude on local')


    const phoneFailure = await failure(run('configure', ctx, ['claude'], { host: 'runtime:phone-only', command: 'must-not-run' }))
    expect(phoneFailure.message).toBe('phone credentials cannot administer owner runtimes')
    expect(await source.client.callAny('quirky.agents/get', { agent: 'claude' }))
      .toMatchObject({ command: 'claude', commandOverridden: false })
    expect(await target.client.callAny('quirky.agents/get', { agent: 'claude' }))
      .toMatchObject({ command: 'remote-claude', commandOverridden: true })
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
    expect(lines[0]).toBe("command: grok --permission-mode bypassPermissions -- 'help'\nlaunch: Grok\nprompt: command-line\nenv: -")
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

describe('agents options', () => {
  test('SC-1: prints a table of models with the choices each offers, then the unlisted and extra argument lines', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('options', ctx, ['claude'])
    const rows = lines[0]!.split('\n')
    expect(cells(rows[0]!)).toEqual(['MODEL', 'LABEL', 'OPTIONS', 'DESCRIPTION'])
    const effort = 'effort: low|medium|high|xhigh|max'
    expect(rows.slice(1, 5).map((row) => cells(row))).toEqual([
      ['fable', 'Fable', effort, 'Most capable for the hardest, longest-running tasks'],
      ['opus', 'Opus', effort, 'Best for everyday, complex tasks'],
      ['sonnet', 'Sonnet', effort, 'Efficient for routine tasks'],
      ['haiku', 'Haiku', '-', 'Fastest for quick answers']
    ])
    expect(rows[5]).toBe('unlisted models: accepted, with effort: low|medium|high|xhigh|max')
    expect(rows[6]).toBe('extra arguments: --model, --effort, --add-dir (for example --model opus --effort high --add-dir docs)')
  })

  test('SC-2: a boolean option lists true|false and each model keeps its own ceiling', async () => {
    const { client } = await start()
    const codex = testCliContext(client)
    await run('options', codex.ctx, ['codex'])
    const luna = codex.lines[0]!.split('\n').find((row) => row.startsWith('gpt-5.6-luna '))!
    expect(cells(luna)[2]).toBe('effort: minimal|low|medium|high|xhigh|max')

    const cursor = testCliContext(client)
    await run('options', cursor.ctx, ['cursor'])
    const row = cursor.lines[0]!.split('\n').find((line) => line.startsWith('gpt-5.3-codex '))!
    expect(cells(row)[2]).toContain('fastMode: true|false')
    expect(cursor.lines[0]).toContain('unlisted models: refused')
  })

  test('SC-3: an agent without a catalog says so, and --json prints the method result', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('options', ctx, ['aider'])
    expect(lines[0]).toBe(
      "Agent aider does not support launch-time model selection.\nextra arguments: Extra arguments aren't supported for this agent yet."
    )

    const omp = testCliContext(client)
    await run('options', omp.ctx, ['omp'])
    expect(omp.lines[0]).toStartWith('no listed models\nunlisted models: accepted\n')

    const json = testCliContext(client, { json: true })
    await run('options', json.ctx, ['codex'])
    expect(JSON.parse(json.lines[0]!)).toEqual(await client.callAny('quirky.agents/options', { agent: 'codex' }))
  })

  test('discover-models requires an exact host and reports the provider result as JSON', async () => {
    const { client } = await start()
    const missingHost = testCliContext(client)
    expect(await failure(run('discoverModels', missingHost.ctx, ['codex'])))
      .toMatchObject({ message: 'missing --host', kind: 'usage' })

    const json = testCliContext(client, { json: true })
    await run('discoverModels', json.ctx, ['codex'], { host: 'local' })
    expect(JSON.parse(json.lines[0]!)).toMatchObject({
      agent: 'codex',
      host: 'local',
      authoritative: false,
      status: 'unavailable'
    })
  })

  test('needs an agent and refuses an unknown one', async () => {
    const { client } = await start()
    const { ctx } = testCliContext(client)
    expect(await failure(run('options', ctx))).toMatchObject({ message: 'missing <agent>', kind: 'usage' })
    expect((await failure(run('options', ctx, ['nope']))).message).toBe('unknown agent: nope')
  })
})

describe('agents resolve', () => {
  test('SC-6: prints what the pick adds, the full arguments, the structured options and the summary', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('resolve', ctx, ['claude'], { model: 'opus', effort: 'high' })
    expect(lines[0]).toBe(
      [
        'added: --model opus --effort high',
        'args: --dangerously-skip-permissions --model opus --effort high',
        'structured: model=opus effort=high',
        'set by extra args: -',
        'launch: Claude · Opus · Effort: high'
      ].join('\n')
    )
  })

  test('SC-7: Codex\'s effort goes through -c', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('resolve', ctx, ['codex'], { model: 'gpt-5.5', effort: 'low' })
    expect(lines[0]).toContain('added: -m gpt-5.5 -c model_reasoning_effort=low')
    expect(lines[0]).toContain('launch: Codex · GPT-5.5 · Reasoning effort: low')
  })

  test('SC-8: no pick shows only the inherited arguments', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('resolve', ctx, ['claude'])
    expect(lines[0]).toBe(
      ['added: -', 'args: --dangerously-skip-permissions', 'structured: -', 'set by extra args: -', 'launch: Claude'].join('\n')
    )
  })

  test('SC-13: extra arguments win, and the row names the option they set', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('resolve', ctx, ['claude'], { model: 'opus', effort: 'low', 'extra-args': '--effort high --add-dir docs' })
    expect(lines[0]).toBe(
      [
        'added: --model opus',
        'args: --dangerously-skip-permissions --effort high --add-dir docs --model opus',
        'structured: model=opus',
        'set by extra args: effort',
        'launch: Claude · Opus'
      ].join('\n')
    )
  })

  test('--json prints the method result, with --option values as typed', async () => {
    const { client } = await start()
    const json = testCliContext(client, { json: true })
    await run('resolve', json.ctx, ['cursor'], { model: 'gpt-5.3-codex', option: ['effort=low', 'fastMode=true'] })
    const result = JSON.parse(json.lines[0]!)
    expect(result.added).toEqual(['--model', 'gpt-5.3-codex-low-fast'])
    expect(result).toEqual(
      await client.callAny('quirky.agents/resolveLaunch', { agent: 'cursor', model: 'gpt-5.3-codex', options: { effort: 'low', fastMode: true } })
    )
  })

  test('SC-9: the daemon\'s refusals reach the user unchanged', async () => {
    const { client } = await start()
    const { ctx } = testCliContext(client)
    expect((await failure(run('resolve', ctx, ['claude'], { model: 'haiku', effort: 'low' }))).message).toBe(
      'Agent claude model haiku does not support effort low.'
    )
    expect((await failure(run('resolve', ctx, ['aider'], { model: 'gpt-4o' }))).message).toBe(
      'Agent aider does not support launch-time model selection.'
    )
    expect((await failure(run('resolve', ctx, ['claude'], { 'extra-args': '--verbose' }))).message).toContain('"--verbose" isn\'t allowed')
  })

  test('SC-9: usage errors come before any call to the daemon', async () => {
    const { client } = await start()
    const { ctx } = testCliContext(client)
    const usage = async (flags: Record<string, unknown>, message: string) =>
      expect(await failure(run('resolve', ctx, ['claude'], flags))).toMatchObject({ message, kind: 'usage' })
    await usage({ effort: 'high' }, '--effort requires --model')
    await usage({ option: ['effort=high'] }, '--option requires --model')
    await usage({ model: 'opus', effort: 'high', option: ['effort=low'] }, 'effort is set by both --effort and --option effort=…')
    await usage({ model: 'opus', option: ['speed=fast', 'speed=slow'] }, '--option speed given more than once')
    await usage({ model: 'opus', option: ['speed'] }, '--option expects KEY=VALUE, got "speed"')
    await usage({ model: 'opus', option: ['=fast'] }, '--option needs a key before "=", got "=fast"')
    expect(await failure(run('resolve', ctx))).toMatchObject({ message: 'missing <agent>', kind: 'usage' })
  })

  test('the first = splits a --option, so a value may contain =', async () => {
    const { client } = await start()
    const { ctx } = testCliContext(client)
    expect((await failure(run('resolve', ctx, ['claude'], { model: 'opus', option: ['speed=a=b'] }))).message).toBe(
      'Agent claude model opus does not support speed a=b.'
    )
  })
})

describe('agents plan with a pick', () => {
  test('passes the flags through and prints a launch row', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client)
    await run('plan', ctx, ['claude'], { model: 'opus', effort: 'high', prompt: 'hi' })
    expect(lines[0]).toBe(
      "command: claude --dangerously-skip-permissions --model opus --effort high 'hi'\nlaunch: Claude · Opus · Effort: high\nprompt: command-line\nenv: -"
    )
  })
})

describe('the CLI catalog', () => {
  test('quirky agents list --json resolves through the real CLI', async () => {
    const { h, client } = await start()
    const result = await runCli(['agents', 'list', '--json'], { home: h.home })
    expect(result.stderr).toBe('')
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(await client.callAny('quirky.agents/list', {}))
  })
})
