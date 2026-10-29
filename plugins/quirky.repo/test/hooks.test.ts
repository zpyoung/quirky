import { describe, expect, test } from 'bun:test'
import type { ProjectSettings } from '@quirky/protocol'
import { effectiveHooks, hashScript, type HooksFile } from '../src/hooks'
import { DEFAULT_SETTINGS } from '../src/store'

const settings = (patch: Partial<ProjectSettings> = {}): ProjectSettings => ({ ...DEFAULT_SETTINGS, ...patch })
const quirky = (text: string): HooksFile => ({ name: 'quirky.yaml', text })
const orca = (text: string): HooksFile => ({ name: 'orca.yaml', text })
const setupYaml = (script: string) => quirky(`scripts:\n  setup: ${JSON.stringify(script)}\n`)

describe('hashScript', () => {
  test('is the sha256 hex of the trimmed text', () => {
    expect(hashScript('  make deps\n')).toBe(new Bun.CryptoHasher('sha256').update('make deps').digest('hex'))
    expect(hashScript('a')).toBe(hashScript('\na\n\n'))
  })
})

describe('effectiveHooks: reading the shared file', () => {
  test('reads setup and archive scripts, the startup policy and shared directories', () => {
    const hooks = effectiveHooks(
      quirky('scripts:\n  setup: pnpm i\n  archive: |\n    echo done\nsetupAgentStartupPolicy: wait-for-setup\nworktree:\n  sharedDirectories: [node_modules, .venv]\n'),
      settings(),
      {}
    )
    expect(hooks.file).toBe('quirky.yaml')
    expect(hooks.setup?.text).toBe('pnpm i')
    expect(hooks.archive?.text).toBe('echo done')
    expect(hooks.agentStartup).toBe('wait-for-setup')
    expect(hooks.sharedDirectories).toEqual(['node_modules', '.venv'])
    expect(hooks.warnings).toEqual([])
  })
  test('reads the top-level issue command without an unsupported-key warning', () => {
    const hooks = effectiveHooks(orca('issueCommand: gh issue list\n'), settings(), {})
    expect(hooks.issueCommand).toMatchObject({
      text: 'gh issue list',
      source: 'shared',
      badge: 'orca.yaml',
      shared: { text: 'gh issue list', hash: hashScript('gh issue list'), trusted: false, changed: false }
    })
    expect(hooks.warnings).toEqual([])
  })

  test('the project setting beats the file for the agent startup policy', () => {
    const file = quirky('setupAgentStartupPolicy: wait-for-setup\n')
    expect(effectiveHooks(file, settings({ agentStartup: 'start-immediately' }), {}).agentStartup).toBe('start-immediately')
    expect(effectiveHooks(file, settings(), {}).agentStartup).toBe('wait-for-setup')
  })

  test('parses safe default terminal tabs and environment recipe metadata without unsupported warnings', () => {
    const hooks = effectiveHooks(orca([
      'scripts:',
      '  setup: ls',
      'issueCommand: gh issue',
      'defaultTabs:',
      '  - title: API',
      '    color: "#aabbcc"',
      '    command: pnpm dev',
      'environmentRecipes:',
      '  - id: devbox',
      '    name: Devbox',
      '    create: vm create',
      '    checkoutMode: provisioned-root',
      '    destroy: none',
      'colour: red'
    ].join('\n')), settings(), {})
    expect(hooks.file).toBe('orca.yaml')
    expect(hooks.setup?.text).toBe('ls')
    expect(hooks.issueCommand?.text).toBe('gh issue')
    expect(hooks.defaultTabs).toEqual([{ title: 'API', color: '#aabbcc', command: 'pnpm dev' }])
    expect(hooks.environmentRecipes).toEqual([{
      id: 'devbox',
      name: 'Devbox',
      create: 'vm create',
      checkoutMode: 'provisioned-root',
      destroyDisabled: true
    }])
    expect(hooks.environmentRecipeDiagnostics).toEqual([])
    expect(hooks.warnings).toEqual(['unrecognised key colour'])
  })

  test('trusts shared default-tab commands with the same setup approval hash', () => {
    const file = orca([
      'scripts:',
      '  setup: pnpm install',
      'defaultTabs:',
      '  - title: Dev',
      '    command: pnpm dev'
    ].join('\n'))
    const trustText = 'pnpm install\n\n# defaultTabs[1] Dev\npnpm dev'
    const hooks = effectiveHooks(file, settings(), { setup: hashScript(trustText) })
    expect(hooks.setup?.shared).toMatchObject({ trusted: true, hash: hashScript(trustText), text: trustText })
    expect(hooks.defaultTabsTrust).toMatchObject({ trusted: true, hash: hashScript(trustText), text: trustText })
  })

  test('a file that fails to parse warns and yields no shared hooks', () => {
    const hooks = effectiveHooks(quirky('scripts: [unclosed\n  : :'), settings({ setupScript: 'local' }), {})
    expect(hooks.warnings).toHaveLength(1)
    expect(hooks.warnings[0]).toMatch(/^quirky\.yaml could not be parsed: /)
    expect(hooks.setup).toMatchObject({ text: 'local', source: 'local', shared: null })
  })

  test('a document that is not a mapping warns', () => {
    expect(effectiveHooks(quirky('- a\n- b\n'), settings(), {}).warnings).toEqual(['quirky.yaml must be a mapping at the top level'])
  })

  test('an empty file is not a warning', () => {
    expect(effectiveHooks(quirky(''), settings(), {})).toMatchObject({ file: 'quirky.yaml', setup: null, warnings: [] })
  })

  test('values of the wrong type are ignored with a warning', () => {
    const hooks = effectiveHooks(
      quirky('scripts:\n  setup: [a]\n  archive: 4\nsetupAgentStartupPolicy: later\nissueCommand: [bad]\nworktree:\n  sharedDirectories: nope\n'),
      settings(),
      {}
    )
    expect(hooks.setup).toBeNull()
    expect(hooks.archive).toBeNull()
    expect(hooks.issueCommand).toBeNull()
    expect(hooks.agentStartup).toBe('start-immediately')
    expect(hooks.sharedDirectories).toEqual([])
    expect(hooks.warnings).toEqual([
      'scripts.setup must be a string',
      'scripts.archive must be a string',
      'issueCommand must be a string',
      'setupAgentStartupPolicy must be start-immediately or wait-for-setup',
      'worktree.sharedDirectories must be a list of strings'
    ])
  })

  test('a blank script is no script', () => {
    expect(effectiveHooks(setupYaml('  \n'), settings(), {}).setup).toBeNull()
  })
})

describe('effectiveHooks: command-source policy (SC-35)', () => {
  const shared = setupYaml('echo shared >> order.txt')
  const local = settings({ setupScript: 'echo local >> order.txt' })

  test('unset with a local script means local-only', () => {
    const hooks = effectiveHooks(shared, local, {})
    expect(hooks.setup).toEqual({ text: 'echo local >> order.txt', source: 'local', badge: 'local settings', shared: null })
  })

  test('unset with no local script means shared-only', () => {
    expect(effectiveHooks(shared, settings(), {}).setup).toMatchObject({ text: 'echo shared >> order.txt', source: 'shared', badge: 'quirky.yaml' })
  })

  test('shared-only ignores the local script, and is empty when there is no shared one', () => {
    expect(effectiveHooks(shared, { ...local, commandSource: 'shared-only' }, {}).setup?.text).toBe('echo shared >> order.txt')
    expect(effectiveHooks(null, { ...local, commandSource: 'shared-only' }, {}).setup).toBeNull()
  })

  test('local-only ignores the shared script, and is empty when there is no local one', () => {
    expect(effectiveHooks(shared, { ...settings(), commandSource: 'local-only' }, {}).setup).toBeNull()
  })

  test('run-both joins shared then local with a newline', () => {
    const hooks = effectiveHooks(shared, { ...local, commandSource: 'run-both' }, {})
    expect(hooks.setup).toMatchObject({
      text: 'echo shared >> order.txt\necho local >> order.txt',
      source: 'both',
      badge: 'quirky.yaml + local settings'
    })
    expect(hooks.setup?.shared?.text).toBe('echo shared >> order.txt')
  })

  test('run-both with only one side present is that side', () => {
    expect(effectiveHooks(null, { ...local, commandSource: 'run-both' }, {}).setup).toMatchObject({ source: 'local', text: 'echo local >> order.txt' })
    expect(effectiveHooks(shared, { ...settings(), commandSource: 'run-both' }, {}).setup).toMatchObject({ source: 'shared' })
  })

  test('the archive script follows the same policy independently', () => {
    const file = quirky('scripts:\n  archive: echo shared-archive\n')
    expect(effectiveHooks(file, settings({ archiveScript: 'echo local-archive' }), {}).archive?.text).toBe('echo local-archive')
    expect(effectiveHooks(file, settings(), {}).archive?.text).toBe('echo shared-archive')
  })
  test('issueCommand follows the command-source policy', () => {
    const file = quirky('issueCommand: gh issue list\n')
    const local = settings({ issueCommand: 'gh issue create' })
    expect(effectiveHooks(file, local, {}).issueCommand).toMatchObject({ text: 'gh issue create', source: 'local' })
    expect(effectiveHooks(file, { ...local, commandSource: 'shared-only' }, {}).issueCommand).toMatchObject({
      text: 'gh issue list',
      source: 'shared',
      badge: 'quirky.yaml'
    })
    expect(effectiveHooks(file, { ...local, commandSource: 'local-only' }, {}).issueCommand).toMatchObject({
      text: 'gh issue create',
      source: 'local'
    })
    expect(effectiveHooks(file, { ...local, commandSource: 'run-both' }, {}).issueCommand).toMatchObject({
      text: 'gh issue list\ngh issue create',
      source: 'both',
      badge: 'quirky.yaml + local settings'
    })
  })
})

describe('effectiveHooks: trust (SC-32)', () => {
  const file = setupYaml('touch ran.txt')

  test('a shared script with no stored hash is untrusted and not changed', () => {
    expect(effectiveHooks(file, settings(), {}).setup?.shared).toEqual({
      text: 'touch ran.txt',
      hash: hashScript('touch ran.txt'),
      trusted: false,
      changed: false
    })
  })

  test('a matching stored hash is trusted', () => {
    expect(effectiveHooks(file, settings(), { setup: hashScript('touch ran.txt') }).setup?.shared).toMatchObject({ trusted: true, changed: false })
  })

  test('a stored hash that differs is untrusted and changed', () => {
    expect(effectiveHooks(file, settings(), { setup: hashScript('touch old.txt') }).setup?.shared).toMatchObject({ trusted: false, changed: true })
  })

  test('trust is per kind', () => {
    const both = quirky('scripts:\n  setup: a\n  archive: b\n')
    const hooks = effectiveHooks(both, settings(), { setup: hashScript('a') })
    expect(hooks.setup?.shared?.trusted).toBe(true)
    expect(hooks.archive?.shared?.trusted).toBe(false)
  })
  test('issue trust is independent from setup and archive', () => {
    const file = quirky('scripts:\n  setup: setup\n  archive: archive\nissueCommand: gh issue list\n')
    const setupAndArchiveTrusted = effectiveHooks(file, settings(), {
      setup: hashScript('setup'),
      archive: hashScript('archive')
    })
    expect(setupAndArchiveTrusted.setup?.shared?.trusted).toBe(true)
    expect(setupAndArchiveTrusted.archive?.shared?.trusted).toBe(true)
    expect(setupAndArchiveTrusted.issueCommand?.shared).toMatchObject({
      hash: hashScript('gh issue list'),
      trusted: false,
      changed: false
    })
    expect(effectiveHooks(file, settings(), { issue: hashScript('gh issue list') }).issueCommand?.shared).toMatchObject({
      trusted: true,
      changed: false
    })
  })

  test('whitespace around a script does not change its hash', () => {
    expect(effectiveHooks(quirky('scripts:\n  setup: |\n    touch ran.txt\n'), settings(), { setup: hashScript('touch ran.txt') }).setup?.shared?.trusted).toBe(true)
  })

  test('local scripts carry no shared trust record', () => {
    expect(effectiveHooks(null, settings({ setupScript: 'make' }), {}).setup?.shared).toBeNull()
  })
})
