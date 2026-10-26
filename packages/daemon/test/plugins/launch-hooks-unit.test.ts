import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { PluginHost } from '../../src/plugins/host'
import { runLaunchHooks } from '../../src/plugins/launch-hooks'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin } from './fixtures'

afterEach(removeTempDirs)

const INPUT: { sessionId: string; worktreeId: string; repoId: string; cwd: string; agent: string; prompt?: string } = {
  sessionId: 's1',
  worktreeId: 'w1',
  repoId: 'r1',
  cwd: '/work',
  agent: 'claude'
}

function setup() {
  const root = makeTempDir()
  const installedDir = join(root, 'installed')
  mkdirSync(installedDir)
  const marker = join(root, 'marker.log')
  const disabled = new Set<string>()
  const host = new PluginHost({
    builtinDir: null,
    installedDir,
    store: {
      listDisabledIds: () => [...disabled].sort(),
      setDisabledId: (id, isDisabled) => {
        if (isDisabled) disabled.add(id)
        else disabled.delete(id)
      }
    },
    emit: () => undefined,
    log: () => undefined
  })
  /** Installs plugin `pluginId` with one launch-hook `vars` whose implementation is `body`, a function expression. */
  const hook = (pluginId: string, body: string, data: Record<string, unknown> = {}) =>
    writeModulePlugin(
      installedDir,
      marker,
      { id: pluginId, contributes: { 'launch-hook': [{ id: 'vars', ...data }] } },
      { activate: `context.provide('launch-hook:${pluginId}/vars', ${body})` }
    )
  host.load()
  const reload = () => host.load()
  const warnings: Array<[string, string]> = []
  const run = (input: Partial<typeof INPUT> = {}, timeoutMs = 2000) =>
    runLaunchHooks({
      plugins: host,
      input: { ...INPUT, ...input },
      timeoutMs,
      warn: (pluginId, message) => warnings.push([pluginId, message])
    })
  return { host, hook, reload, run, warnings, marker, installedDir }
}

describe('runLaunchHooks', () => {
  test('applies env and args from one hook', async () => {
    const t = setup()
    t.hook('acme.x', `() => ({ env: { FOO: 'bar' }, args: ['--flag', 'v'] })`)
    t.reload()
    expect(await t.run()).toEqual({ env: { FOO: 'bar' }, args: ['--flag', 'v'] })
    expect(t.warnings).toEqual([])
  })

  test('returns nothing to apply when no hooks exist or a hook returns undefined', async () => {
    const t = setup()
    expect(await t.run()).toEqual({ env: {}, args: [] })
    t.hook('acme.x', `() => undefined`)
    t.reload()
    expect(await t.run()).toEqual({ env: {}, args: [] })
    expect(t.warnings).toEqual([])
  })

  test('a hook limited to other agents neither runs nor imports', async () => {
    const t = setup()
    t.hook('acme.x', `() => ({ env: { ONLY: 'claude' } })`, { agents: ['claude'] })
    t.hook('acme.y', `() => ({ env: { ANY: '1' } })`)
    t.reload()
    expect(await t.run({ agent: 'shell' })).toEqual({ env: { ANY: '1' }, args: [] })
    expect(readMarker(t.marker)).toEqual(['import acme.y', 'activate acme.y'])
    expect(await t.run({ agent: 'claude' })).toEqual({ env: { ONLY: 'claude', ANY: '1' }, args: [] })
  })

  test('runs hooks in ID order and shows each the env and args so far', async () => {
    const t = setup()
    t.hook('acme.b', `(launch) => ({ env: { STAGE: launch.env.STAGE + 'b' }, args: [String(launch.args.length)] })`)
    t.hook('acme.a', `() => ({ env: { STAGE: 'a' }, args: ['first'] })`)
    t.reload()
    expect(await t.run()).toEqual({ env: { STAGE: 'ab' }, args: ['first', '1'] })
  })

  test('hands hooks the launch input and frozen copies of env and args', async () => {
    const t = setup()
    t.hook('acme.a', `() => ({ env: { A: '1' }, args: ['x'] })`)
    t.hook(
      'acme.b',
      `(launch) => {
        const frozen = Object.isFrozen(launch.env) && Object.isFrozen(launch.args)
        return { env: { SEEN: JSON.stringify([launch.sessionId, launch.cwd, launch.agent, launch.prompt, launch.env, frozen]) } }
      }`
    )
    t.reload()
    const result = await t.run({ prompt: 'go' })
    expect(JSON.parse(result.env.SEEN!)).toEqual(['s1', '/work', 'claude', 'go', { A: '1' }, true])
  })

  test('drops reserved names with a warning and still applies the rest of the patch', async () => {
    const t = setup()
    t.hook('acme.x', `() => ({ env: { PATH: '/bin', ZDOTDIR: '/z', QUIRKY_SESSION_ID: 'x', OK: '1' } })`)
    t.reload()
    expect(await t.run()).toEqual({ env: { OK: '1' }, args: [] })
    expect(t.warnings).toEqual([
      ['acme.x', 'launch hook launch-hook:acme.x/vars tried to set reserved variable PATH'],
      ['acme.x', 'launch hook launch-hook:acme.x/vars tried to set reserved variable ZDOTDIR'],
      ['acme.x', 'launch hook launch-hook:acme.x/vars tried to set reserved variable QUIRKY_SESSION_ID']
    ])
  })

  test('drops an invalid name or a non-string, NUL-containing value', async () => {
    const t = setup()
    t.hook(
      'acme.x',
      `() => ({ env: { '1BAD': 'v', 'has-dash': 'v', NULVAL: 'a\\0b', NUM: 5, GOOD: 'g' } })`
    )
    t.reload()
    expect(await t.run()).toEqual({ env: { GOOD: 'g' }, args: [] })
    const id = 'launch-hook:acme.x/vars'
    expect(t.warnings).toEqual([
      ['acme.x', `launch hook ${id} set invalid variable 1BAD`],
      ['acme.x', `launch hook ${id} set invalid variable has-dash`],
      ['acme.x', `launch hook ${id} set invalid variable NULVAL`],
      ['acme.x', `launch hook ${id} set invalid variable NUM`]
    ])
  })

  test('drops all args when they are not an array of NUL-free strings', async () => {
    const t = setup()
    t.hook('acme.a', `() => ({ args: ['ok', 'bad\\0'] })`)
    t.hook('acme.b', `() => ({ args: 'not-an-array' })`)
    t.hook('acme.c', `() => ({ args: ['kept'] })`)
    t.reload()
    expect(await t.run()).toEqual({ env: {}, args: ['kept'] })
    expect(t.warnings).toEqual([
      ['acme.a', 'launch hook launch-hook:acme.a/vars returned invalid args'],
      ['acme.b', 'launch hook launch-hook:acme.b/vars returned invalid args']
    ])
  })

  test('drops args for a shell session but keeps its env', async () => {
    const t = setup()
    t.hook('acme.x', `() => ({ env: { OK: '1' }, args: ['--x'] })`)
    t.reload()
    expect(await t.run({ agent: 'shell' })).toEqual({ env: { OK: '1' }, args: [] })
    expect(t.warnings).toEqual([
      ['acme.x', 'launch hook launch-hook:acme.x/vars returned args for a shell session, which take none']
    ])
  })

  test('a throw, a rejection and an activation failure warn and later hooks still run', async () => {
    const t = setup()
    t.hook('acme.a', `() => { throw new Error('boom') }`)
    t.hook('acme.b', `async () => { throw new Error('rejected') }`)
    writeModulePlugin(
      t.installedDir,
      t.marker,
      { id: 'acme.c', contributes: { 'launch-hook': [{ id: 'vars' }] } },
      { activate: `throw new Error('no start')` }
    )
    t.hook('acme.d', `() => ({ env: { LAST: 'yes' } })`)
    t.reload()
    expect(await t.run()).toEqual({ env: { LAST: 'yes' }, args: [] })
    expect(t.warnings).toEqual([
      ['acme.a', 'launch hook launch-hook:acme.a/vars failed: boom'],
      ['acme.b', 'launch hook launch-hook:acme.b/vars failed: rejected'],
      ['acme.c', 'launch hook launch-hook:acme.c/vars failed: acme.c failed to activate: no start']
    ])
  })

  test('discards the changes of a hook that throws after building a patch', async () => {
    const t = setup()
    t.hook('acme.x', `() => { throw new Error('late') }`)
    t.reload()
    expect(await t.run()).toEqual({ env: {}, args: [] })
  })

  test('a hook that never resolves times out and later hooks still run', async () => {
    const t = setup()
    t.hook('acme.a', `() => new Promise(() => undefined)`)
    t.hook('acme.b', `() => ({ env: { AFTER: '1' } })`)
    t.reload()
    expect(await t.run({}, 100)).toEqual({ env: { AFTER: '1' }, args: [] })
    expect(t.warnings).toEqual([['acme.a', 'launch hook launch-hook:acme.a/vars timed out after 100 ms']])
  })

  test('returns a null deletion and later hooks no longer see the name', async () => {
    const t = setup()
    t.hook('acme.a', `() => ({ env: { GONE: 'x', KEEP: 'k' } })`)
    t.hook('acme.b', `() => ({ env: { GONE: null } })`)
    t.hook('acme.c', `(launch) => ({ env: { SAW_GONE: String('GONE' in launch.env), REMOVED_ELSEWHERE: null } })`)
    t.reload()
    expect(await t.run()).toEqual({ env: { GONE: null, KEEP: 'k', SAW_GONE: 'false', REMOVED_ELSEWHERE: null }, args: [] })
  })

  test('a disabled hook is not applied', async () => {
    const t = setup()
    t.hook('acme.x', `() => ({ env: { FOO: 'bar' } })`)
    t.reload()
    await t.host.setEnabled('launch-hook:acme.x/vars', false)
    expect(await t.run()).toEqual({ env: {}, args: [] })
    expect(readMarker(t.marker)).toEqual([])
  })

  test('reports the effective owner of an overridden hook', async () => {
    const t = setup()
    t.hook('acme.x', `() => ({ env: { WHO: 'x' } })`)
    writeModulePlugin(
      t.installedDir,
      t.marker,
      { id: 'acme.y', overrides: [{ id: 'launch-hook:acme.x/vars' }] },
      { activate: `context.provide('launch-hook:acme.x/vars', () => ({ env: { WHO: 'y', PATH: '/p' } }))` }
    )
    t.reload()
    expect(await t.run()).toEqual({ env: { WHO: 'y' }, args: [] })
    expect(t.warnings).toEqual([['acme.y', 'launch hook launch-hook:acme.x/vars tried to set reserved variable PATH']])
  })
})
