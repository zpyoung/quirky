import { describe, expect, test } from 'bun:test'
import {
  BUILTIN_PLUGIN_PREFIX,
  formatContributionId,
  isContributionName,
  isKind,
  isPluginId,
  parseContributionId
} from '../src'
import type { LaunchHookInput, LaunchPatch, PluginLaunch, SessionLaunch } from '../src'

describe('isPluginId', () => {
  test('accepts lowercase dotted and dashed ids', () => {
    expect(isPluginId('quirky.scm')).toBe(true)
    expect(isPluginId('acme-tools.x')).toBe(true)
    expect(isPluginId('a')).toBe(true)
    expect(isPluginId('a1.b2-c3')).toBe(true)
  })

  test('rejects uppercase, doubled or edge separators, and over-long ids', () => {
    expect(isPluginId('Acme')).toBe(false)
    expect(isPluginId('a..b')).toBe(false)
    expect(isPluginId('-a')).toBe(false)
    expect(isPluginId('a-')).toBe(false)
    expect(isPluginId('')).toBe(false)
    expect(isPluginId('a_b')).toBe(false)
    expect(isPluginId('a/b')).toBe(false)
    expect(isPluginId('a:b')).toBe(false)
    expect(isPluginId('a'.repeat(64))).toBe(true)
    expect(isPluginId('a'.repeat(65))).toBe(false)
  })

  test('built-in prefix is quirky.', () => {
    expect(BUILTIN_PLUGIN_PREFIX).toBe('quirky.')
  })
})

describe('isKind and isContributionName', () => {
  test('kind is lowercase letters with single . or - separators, at most 64', () => {
    expect(isKind('command')).toBe(true)
    expect(isKind('ui.panel')).toBe(true)
    expect(isKind('a-b')).toBe(true)
    expect(isKind('a1')).toBe(false)
    expect(isKind('Panel')).toBe(false)
    expect(isKind('a_b')).toBe(false)
    expect(isKind('')).toBe(false)
    expect(isKind('a'.repeat(64))).toBe(true)
    expect(isKind('a'.repeat(65))).toBe(false)
  })

  test('name allows case, digits and single . _ - separators, at most 128', () => {
    expect(isContributionName('openFile')).toBe(true)
    expect(isContributionName('open_file.v2-x')).toBe(true)
    expect(isContributionName('a__b')).toBe(false)
    expect(isContributionName('_a')).toBe(false)
    expect(isContributionName('a/b')).toBe(false)
    expect(isContributionName('')).toBe(false)
    expect(isContributionName('a'.repeat(128))).toBe(true)
    expect(isContributionName('a'.repeat(129))).toBe(false)
  })
})

describe('parseContributionId', () => {
  test('splits a valid id into kind, namespace and name', () => {
    expect(parseContributionId('command:quirky.scm/openFile')).toEqual({
      kind: 'command',
      namespace: 'quirky.scm',
      name: 'openFile'
    })
    expect(parseContributionId('ui.panel:acme-tools.x/Side_bar.v2')).toEqual({
      kind: 'ui.panel',
      namespace: 'acme-tools.x',
      name: 'Side_bar.v2'
    })
  })

  test('returns null for anything not exactly kind:pluginId/name', () => {
    for (const bad of [
      '',
      'quirky.scm',
      'command:quirky.scm',
      'command:/name',
      ':quirky.scm/name',
      'command:quirky.scm/',
      'command:Quirky/name',
      'Command:quirky.scm/name',
      'command:quirky.scm/a/b',
      'command:quirky.scm/a b',
      'command:a..b/name',
      'command:quirky.scm/name\n',
      ' command:quirky.scm/name',
      'a:b:c/d'
    ]) {
      expect(parseContributionId(bad)).toBeNull()
    }
  })

  test('enforces length limits on each part', () => {
    const ok = (kind: string, ns: string, name: string) => parseContributionId(`${kind}:${ns}/${name}`)
    expect(ok('k'.repeat(64), 'p', 'n')).not.toBeNull()
    expect(ok('k'.repeat(65), 'p', 'n')).toBeNull()
    expect(ok('k', 'p'.repeat(64), 'n')).not.toBeNull()
    expect(ok('k', 'p'.repeat(65), 'n')).toBeNull()
    expect(ok('k', 'p', 'n'.repeat(128))).not.toBeNull()
    expect(ok('k', 'p', 'n'.repeat(129))).toBeNull()
  })
})

describe('formatContributionId', () => {
  test('joins the parts and round-trips through parseContributionId', () => {
    expect(formatContributionId('command', 'quirky.scm', 'openFile')).toBe('command:quirky.scm/openFile')
    expect(parseContributionId(formatContributionId('ui.panel', 'acme-tools.x', 'a_b.C'))).toEqual({
      kind: 'ui.panel',
      namespace: 'acme-tools.x',
      name: 'a_b.C'
    })
  })

  test('throws an error naming the bad part', () => {
    expect(() => formatContributionId('Bad', 'p', 'n')).toThrow('kind')
    expect(() => formatContributionId('k', 'Bad', 'n')).toThrow('plugin ID')
    expect(() => formatContributionId('k', 'p', 'bad name')).toThrow('name')
    expect(() => formatContributionId('k', 'p'.repeat(65), 'n')).toThrow('plugin ID')
    expect(() => formatContributionId('k', 'p', 'n'.repeat(129))).toThrow('name')
  })
})
describe('launch hook JSON arguments', () => {
  test('exposes readonly JSON accumulation and create or replay context while preserving additions shape', async () => {
    const record: SessionLaunch = { command: 'claude', args: '--settings user.json', env: {} }
    const patch: LaunchPatch = { jsonArgs: { '--settings': { hooks: { Stop: [] } } } }
    const input: Parameters<PluginLaunch['hooks']>[0] = {
      sessionId: 's1',
      worktreeId: 'w1',
      repoId: 'r1',
      cwd: '/work',
      agent: 'claude',
      record,
      model: 'opus',
      options: { effort: 'high' },
      extraArgs: '--add-dir docs'
    }
    let seen!: LaunchHookInput
    const launch: PluginLaunch = {
      shell: '/bin/sh',
      binDir: '/bin',
      env: () => ({}),
      shellArgv: () => ['/bin/sh'],
      shellReady: () => false,
      commandArgv: () => [],
      openStructuredLease: () => {
        throw new Error('structured leases are unsupported by this launch fixture')
      },
      sessionIdentity: () => null,
      hooks: async (received) => {
        seen = { ...received, env: {}, args: [], jsonArgs: patch.jsonArgs! }
        return { env: {}, args: [] }
      }
    }

    const additions = await launch.hooks(input)

    expect(seen).toMatchObject({ record, model: 'opus', options: { effort: 'high' }, extraArgs: '--add-dir docs', jsonArgs: patch.jsonArgs })
    expect(additions).toEqual({ env: {}, args: [] })
  })
})
