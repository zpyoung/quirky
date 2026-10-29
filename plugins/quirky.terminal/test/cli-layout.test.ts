import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { CliContext, QuirkyClient } from '@quirky/protocol'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { commands } from '../cli'
import { renderWorkspace } from '../src/cli/text'
import { groupsInOrder, paneLeaves } from '../src/layout/tree'
import { isTerminalTab } from '../src/layout/types'
import type { Group, PaneLeaf, TerminalTab, Workspace } from '../src/layout/types'
import { startPluginHarness, TERMINAL_PLUGINS, testCliContext } from './support'

const pane = (id: string, session: string, extra: Partial<PaneLeaf> = {}): PaneLeaf => ({ kind: 'pane', id, session, title: null, exit: null, ...extra })

const tab = (id: string, title: string, root: TerminalTab['root'], extra: Partial<TerminalTab> = {}): TerminalTab => ({
  id,
  defaultTitle: title,
  customTitle: null,
  liveTitle: null,
  color: 'none',
  pinned: false,
  root,
  activePane: paneLeaves(root)[0]!.id,
  expandedPane: null,
  createdAt: '2026-10-26T00:00:00.000Z',
  ...extra
})

const group = (id: string, tabs: TerminalTab[], activeTab: string | null): Group => ({ kind: 'group', id, tabs, activeTab, recent: [], lastQuickCommand: null })

/** The workspace drawn in the conceptual model of the logic spec, with a pane in each of the tabs the drawing leaves bare. */
function conceptualWorkspace(): Workspace {
  const build = tab(
    'tab-2',
    'Build',
    {
      kind: 'split',
      id: 'split-2',
      direction: 'right',
      ratio: 0.5,
      first: pane('pane-2', 's-2'),
      second: { kind: 'split', id: 'split-3', direction: 'down', ratio: 0.5, first: pane('pane-3', 's-3'), second: pane('pane-4', 's-4') }
    },
    { activePane: 'pane-3' }
  )
  return {
    id: 'main',
    revision: 7,
    activeGroup: 'grp-1',
    closed: [],
    root: {
      kind: 'split',
      id: 'split-1',
      direction: 'right',
      ratio: 0.5,
      first: group('grp-1', [tab('tab-1', 'Terminal 1', pane('pane-1', 's-1'), { color: 'blue' }), build], 'tab-2'),
      second: group('grp-2', [tab('tab-3', 'Hello', pane('pane-5', 's-5'))], 'tab-3')
    }
  }
}

describe('the layout tree printer', () => {
  test('SC-2: prints one line per split, group, tab and pane, two spaces per depth', () => {
    expect(renderWorkspace(conceptualWorkspace()).split('\n')).toEqual([
      'split right 0.5',
      '  group grp-1 (active)',
      '    tab tab-1 "Terminal 1" blue',
      '      pane pane-1 s-1',
      '    tab tab-2 "Build" (active)',
      '      split right 0.5',
      '        pane pane-2 s-2',
      '        split down 0.5',
      '          pane pane-3 s-3 (active)',
      '          pane pane-4 s-4',
      '  group grp-2',
      '    tab tab-3 "Hello"',
      '      pane pane-5 s-5'
    ])
  })

  test('shows the title a tab displays, the colour with the active mark, and an ended pane\'s exit', () => {
    const ws = conceptualWorkspace()
    const [first, build] = (ws.root as { first: Group }).first.tabs.filter(isTerminalTab)
    ;(ws.root as { first: Group }).first.tabs = [
      { ...first!, liveTitle: 'deploy "now"' },
      { ...build!, customTitle: 'Mine', color: 'teal', root: pane('pane-2', 's-2', { exit: { code: 137, signal: null } }), activePane: 'pane-2' }
    ]
    const lines = renderWorkspace(ws).split('\n')
    expect(lines[2]).toBe('    tab tab-1 "deploy \\"now\\"" blue')
    expect(lines.slice(4, 6)).toEqual(['    tab tab-2 "Mine" teal (active)', '      pane pane-2 s-2 exit 137 (active)'])
  })

  test('an exit by signal names the signal, and an empty workspace is one group line', () => {
    const exited = tab('tab-1', 'T', pane('pane-1', 's-1', { exit: { code: null, signal: 'SIGKILL' } }))
    const ws: Workspace = { id: 'main', revision: 1, activeGroup: 'grp-1', closed: [], root: group('grp-1', [exited], 'tab-1') }
    expect(renderWorkspace(ws)).toBe('group grp-1 (active)\n  tab tab-1 "T" (active)\n    pane pane-1 s-1 exit SIGKILL (active)')
    expect(renderWorkspace({ ...ws, root: group('grp-1', [], null) })).toBe('group grp-1 (active)')
  })
})

const WORKSPACE = conceptualWorkspace()
const TREE = renderWorkspace(WORKSPACE)

type Call = { method: string; params: Record<string, unknown> }

/** A CLI context whose daemon calls are recorded and answered from `answers`; anything else answers with the sample workspace. */
function stubbed(options: { env?: Record<string, string>; json?: boolean; answers?: Record<string, unknown> } = {}) {
  const made = testCliContext({} as QuirkyClient, options)
  const calls: Call[] = []
  const ctx: CliContext = {
    ...made.ctx,
    call: async (method, params = {}) => {
      calls.push({ method: method.replace('quirky.terminal/', ''), params })
      const answer = options.answers?.[method.replace('quirky.terminal/', '')]
      return typeof answer === 'function' ? answer(params) : (answer ?? { workspace: WORKSPACE })
    }
  }
  return { ctx, calls, lines: made.lines }
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { kind?: string }
  }
  throw new Error('expected a failure')
}

const run = (name: string, positionals: string[], flags: Record<string, unknown> = {}, options: Parameters<typeof stubbed>[0] = {}) => {
  const made = stubbed(options)
  return commands[name]!({ positionals, flags }, made.ctx).then(() => made)
}

describe('parameter mapping', () => {
  const SESSION_ENV = { QUIRKY_SESSION_ID: 's-3' }
  const PANE_OF = { paneOf: { workspace: 'main', tab: 'tab-2', pane: 'pane-3' } }

  const cases: [string, string[], Record<string, unknown>, Call[], Parameters<typeof stubbed>[0]?][] = [
    ['layout', [], {}, [{ method: 'workspace', params: {} }]],
    ['layout', [], { worktree: 'api' }, [{ method: 'workspace', params: { workspace: 'api' } }]],
    ['tab-new', [], {}, [{ method: 'newTab', params: {} }]],
    [
      'tab-new',
      [],
      { worktree: 'api', agent: 'claude', cwd: '/tmp/x', title: 'Review' },
      [{ method: 'newTab', params: { workspace: 'api', agent: 'claude', cwd: '/tmp/x', title: 'Review' } }]
    ],
    ['tab-new', [], { workspace: 'floating' }, [{ method: 'newTab', params: { workspace: 'floating' } }]],
    ['tab-close', ['tab-2'], {}, [{ method: 'closeTab', params: { tab: 'tab-2' } }]],
    ['tab-close-others', ['tab-2'], {}, [{ method: 'closeTabs', params: { tab: 'tab-2', which: 'others' } }]],
    ['tab-close-right', ['tab-2'], {}, [{ method: 'closeTabs', params: { tab: 'tab-2', which: 'right' } }]],
    ['tab-close-left', ['tab-2'], {}, [{ method: 'closeTabs', params: { tab: 'tab-2', which: 'left' } }]],
    ['tab-rename', ['tab-2', 'Build'], {}, [{ method: 'renameTab', params: { tab: 'tab-2', title: 'Build' } }]],
    ['tab-rename', ['tab-2', ''], {}, [{ method: 'renameTab', params: { tab: 'tab-2', title: '' } }]],
    ['tab-color', ['tab-2', 'blue'], {}, [{ method: 'setTabColor', params: { tab: 'tab-2', color: 'blue' } }]],
    ['tab-pin', ['tab-2'], {}, [{ method: 'pinTab', params: { tab: 'tab-2', pinned: true } }]],
    ['tab-unpin', ['tab-2'], {}, [{ method: 'pinTab', params: { tab: 'tab-2', pinned: false } }]],
    ['tab-reopen', [], {}, [{ method: 'reopenTab', params: {} }]],
    ['tab-reopen', [], { worktree: 'api' }, [{ method: 'reopenTab', params: { workspace: 'api' } }]],
    ['tab-move', ['tab-2'], { group: 'grp-2', index: 0 }, [{ method: 'moveTab', params: { tab: 'tab-2', group: 'grp-2', index: 0 } }]],
    ['tab-move', ['tab-2'], { group: 'grp-2' }, [{ method: 'moveTab', params: { tab: 'tab-2', group: 'grp-2' } }]],
    ['tab-move', ['tab-2'], { split: 'down' }, [{ method: 'moveTab', params: { tab: 'tab-2', split: 'down' } }]],
    ['tab-move', ['tab-2'], { split: 'left', of: 'grp-2' }, [{ method: 'moveTab', params: { tab: 'tab-2', split: 'left', of: 'grp-2' } }]],
    ['tab-activate', ['tab-2'], {}, [{ method: 'activateTab', params: { tab: 'tab-2' } }]],
    ['tab-activate', [], { index: 3 }, [{ method: 'activateTab', params: { index: 3 } }]],
    ['tab-activate', [], { index: 3, group: 'grp-2' }, [{ method: 'activateTab', params: { index: 3, group: 'grp-2' } }]],
    ['tab-next', [], {}, [{ method: 'activateTab', params: { offset: 1 } }]],
    ['tab-previous', [], {}, [{ method: 'activateTab', params: { offset: -1 } }]],
    ['pane-split', ['pane-3'], { direction: 'down' }, [{ method: 'splitPane', params: { pane: 'pane-3', direction: 'down' } }]],
    ['pane-close', ['pane-3'], {}, [{ method: 'closePane', params: { pane: 'pane-3' } }]],
    ['pane-restart', ['pane-3'], {}, [{ method: 'restartPane', params: { pane: 'pane-3' } }]],
    ['pane-focus', ['pane-3'], {}, [{ method: 'focusPane', params: { pane: 'pane-3' } }]],
    ['pane-focus', [], { next: true }, [{ method: 'focusPane', params: { offset: 1 } }]],
    ['pane-focus', [], { previous: true }, [{ method: 'focusPane', params: { offset: -1 } }]],
    ['pane-title', ['pane-3', 'logs'], {}, [{ method: 'setPaneTitle', params: { pane: 'pane-3', title: 'logs' } }]],
    ['pane-expand', ['pane-3'], {}, [{ method: 'expandPane', params: { pane: 'pane-3', expanded: true } }]],
    ['pane-collapse', ['pane-3'], {}, [{ method: 'expandPane', params: { pane: 'pane-3', expanded: false } }]],
    ['pane-equalize', [], { tab: 'tab-2' }, [{ method: 'equalize', params: { tab: 'tab-2' } }]],
    ['pane-resize', ['pane-3'], { ratio: 0.3 }, [{ method: 'resizeSplit', params: { pane: 'pane-3', share: 0.3 } }]],
    ['pane-move', ['pane-3'], { 'to-pane': 'pane-2', edge: 'left' }, [{ method: 'movePane', params: { pane: 'pane-3', toPane: 'pane-2', edge: 'left' } }]],
    ['pane-move', ['pane-3'], { 'to-tab': 'tab-1' }, [{ method: 'movePane', params: { pane: 'pane-3', toTab: 'tab-1' } }]],
    ['pane-clear', ['pane-3'], {}, [{ method: 'clearPane', params: { pane: 'pane-3' } }], { answers: { clearPane: { ok: true } } }],
    ['pane-reset', ['pane-3'], {}, [{ method: 'resetPane', params: { pane: 'pane-3' } }], { answers: { resetPane: { ok: true } } }],
    ['group-close', ['grp-2'], {}, [{ method: 'closeGroup', params: { group: 'grp-2' } }]],
    ['group-resize', ['grp-1'], { ratio: 0.4 }, [{ method: 'resizeSplit', params: { group: 'grp-1', share: 0.4 } }]],
    ['group-resize', [], { split: 'split-1', ratio: 0.4 }, [{ method: 'resizeSplit', params: { split: 'split-1', ratio: 0.4 } }]],
    ['open-link', ['https://example.com'], {}, [{ method: 'openExternal', params: { target: 'https://example.com' } }], { answers: { openExternal: { ok: true } } }],
    ['open-link', ['/tmp/a.txt'], { reveal: true }, [{ method: 'openExternal', params: { target: '/tmp/a.txt', reveal: true } }], { answers: { openExternal: { ok: true } } }]
  ]

  for (const [name, positionals, flags, expected, options] of cases) {
    test(`${name} ${JSON.stringify(positionals)} ${JSON.stringify(flags)}`, async () => {
      const { calls } = await run(name, positionals, flags, options)
      expect(calls).toEqual(expected)
    })
  }

  test('a pane command with no pane acts on the pane showing $QUIRKY_SESSION_ID, looked up with paneOf', async () => {
    const cases: [string, string[], Record<string, unknown>, Call][] = [
      ['pane-split', [], { direction: 'right' }, { method: 'splitPane', params: { pane: 'pane-3', direction: 'right' } }],
      ['pane-close', [], {}, { method: 'closePane', params: { pane: 'pane-3' } }],
      ['pane-restart', [], {}, { method: 'restartPane', params: { pane: 'pane-3' } }],
      ['pane-title', ['logs'], {}, { method: 'setPaneTitle', params: { pane: 'pane-3', title: 'logs' } }],
      ['pane-expand', [], {}, { method: 'expandPane', params: { pane: 'pane-3', expanded: true } }],
      ['pane-collapse', [], {}, { method: 'expandPane', params: { pane: 'pane-3', expanded: false } }],
      ['pane-resize', [], { ratio: 0.6 }, { method: 'resizeSplit', params: { pane: 'pane-3', share: 0.6 } }],
      ['pane-clear', [], {}, { method: 'clearPane', params: { pane: 'pane-3' } }],
      ['pane-reset', [], {}, { method: 'resetPane', params: { pane: 'pane-3' } }]
    ]
    for (const [name, positionals, flags, expected] of cases) {
      const { calls } = await run(name, positionals, flags, { env: SESSION_ENV, answers: { ...PANE_OF, clearPane: { ok: true }, resetPane: { ok: true } } })
      expect(calls).toEqual([{ method: 'paneOf', params: { session: 's-3' } }, expected])
    }
  })

  test('pane equalize without --tab uses the tab of the pane showing $QUIRKY_SESSION_ID', async () => {
    const { calls } = await run('pane-equalize', [], {}, { env: SESSION_ENV, answers: PANE_OF })
    expect(calls).toEqual([
      { method: 'paneOf', params: { session: 's-3' } },
      { method: 'equalize', params: { tab: 'tab-2' } }
    ])
  })

  test('a bare session id is accepted wherever a pane is meant', async () => {
    const answers = { ...PANE_OF, clearPane: { ok: true } }
    expect((await run('pane-close', ['s-3'], {}, { answers })).calls).toEqual([
      { method: 'paneOf', params: { session: 's-3' } },
      { method: 'closePane', params: { pane: 'pane-3' } }
    ])
    expect((await run('pane-title', ['s-3', 'x'], {}, { answers })).calls.at(-1)).toEqual({ method: 'setPaneTitle', params: { pane: 'pane-3', title: 'x' } })
    expect((await run('pane-focus', ['s-3'], {}, { answers })).calls.at(-1)).toEqual({ method: 'focusPane', params: { pane: 'pane-3' } })
    expect((await run('pane-clear', ['s-3'], {}, { answers })).calls.at(-1)).toEqual({ method: 'clearPane', params: { pane: 'pane-3' } })
    const moved = await run('pane-move', ['s-3'], { 'to-pane': 's-3', edge: 'top' }, { answers })
    expect(moved.calls.at(-1)).toEqual({ method: 'movePane', params: { pane: 'pane-3', toPane: 'pane-3', edge: 'top' } })
  })

  test('a pane command with no pane and no session in the env is a usage error', async () => {
    expect(await failure(run('pane-close', [], {}))).toMatchObject({ kind: 'usage', message: 'no pane; pass <pane> or set QUIRKY_SESSION_ID' })
    expect(await failure(run('pane-equalize', [], {}))).toMatchObject({ kind: 'usage', message: 'no tab; pass --tab or set QUIRKY_SESSION_ID' })
  })
})

describe('human and JSON output', () => {
  test('layout prints the tree, and --json prints the workspace itself', async () => {
    expect((await run('layout', [])).lines).toEqual([TREE])
    expect(JSON.parse((await run('layout', [], {}, { json: true })).lines[0]!)).toEqual(WORKSPACE)
  })

  test('a mutation prints the new tree, and --json the raw result', async () => {
    expect((await run('tab-new', [])).lines).toEqual([TREE])
    expect((await run('pane-split', ['pane-3'], { direction: 'right' })).lines).toEqual([TREE])
    expect(JSON.parse((await run('tab-pin', ['tab-1'], {}, { json: true })).lines[0]!)).toEqual({ workspace: WORKSPACE })
  })

  test('pane clear and reset say what they did', async () => {
    const answers = { clearPane: { ok: true }, resetPane: { ok: true } }
    expect((await run('pane-clear', ['pane-3'], {}, { answers })).lines).toEqual(['cleared pane-3'])
    expect((await run('pane-reset', ['pane-3'], {}, { answers })).lines).toEqual(['reset pane-3'])
    expect(JSON.parse((await run('pane-clear', ['pane-3'], {}, { answers, json: true })).lines[0]!)).toEqual({ ok: true })
  })

  test('open-link says whether it opened or revealed', async () => {
    const answers = { openExternal: { ok: true } }
    expect((await run('open-link', ['https://example.com'], {}, { answers })).lines).toEqual(['opened https://example.com'])
    expect((await run('open-link', ['/tmp/a'], { reveal: true }, { answers })).lines).toEqual(['revealed /tmp/a'])
  })

  test('pane get prints the pane record and --json the located pane', async () => {
    const answers = { paneOf: { workspace: 'main', tab: 'tab-2', pane: 'pane-3' }, workspace: { workspace: WORKSPACE } }
    const text = (await run('pane-get', ['pane-3'], {}, { answers })).lines[0]!
    expect(text.split('\n')).toEqual([
      'pane: pane-3',
      'session: s-3',
      'tab: tab-2',
      'group: grp-1',
      'workspace: main',
      'title: -',
      'active: true',
      'exit: -'
    ])
    const json = JSON.parse((await run('pane-get', ['pane-4'], {}, { answers, json: true })).lines[0]!)
    expect(json).toMatchObject({ workspace: 'main', tab: 'tab-2', group: 'grp-1', active: false, pane: { id: 'pane-4', session: 's-4' } })
  })

  test('pane get on a pane ID asks paneOf which workspace holds it, even another worktree or the floating one', async () => {
    const floatingWs: Workspace = { ...WORKSPACE, id: 'floating' }
    const answers = {
      paneOf: { workspace: 'floating', tab: 'tab-2', pane: 'pane-3' },
      workspace: (params: Record<string, unknown>) => ({ workspace: params.workspace === 'floating' ? floatingWs : { ...WORKSPACE, root: group('grp-9', [], null) } })
    }
    const found = await run('pane-get', ['pane-3'], {}, { answers, json: true })
    expect(found.calls).toEqual([
      { method: 'paneOf', params: { pane: 'pane-3' } },
      { method: 'workspace', params: { workspace: 'floating' } }
    ])
    expect(JSON.parse(found.lines[0]!)).toMatchObject({ workspace: 'floating' })
  })

  test('pane get on an unknown pane fails with the daemon\'s not-found', async () => {
    const answers = {
      paneOf: () => {
        throw new Error('no pane pane-99')
      }
    }
    expect((await failure(run('pane-get', ['pane-99'], {}, { answers }))).message).toBe('no pane pane-99')
  })

  test('pane get --worktree finds nothing when that worktree lacks the pane', async () => {
    const answers = { workspace: { workspace: { ...WORKSPACE, root: group('grp-9', [], null) } } }
    expect(await failure(run('pane-get', ['pane-3'], { worktree: 'api' }, { answers }))).toMatchObject({ kind: 'fail', message: 'no pane pane-3' })
  })

  test('pane get on a session looks in the workspace paneOf names, even another worktree', async () => {
    const other: Workspace = { ...WORKSPACE, id: 'wt-other' }
    const answers = {
      paneOf: { workspace: 'wt-other', tab: 'tab-2', pane: 'pane-3' },
      workspace: (params: Record<string, unknown>) => ({ workspace: params.workspace === 'wt-other' ? other : { ...WORKSPACE, root: group('grp-9', [], null) } })
    }
    const found = await run('pane-get', ['s-other'], {}, { answers, json: true })
    expect(found.calls).toEqual([
      { method: 'paneOf', params: { session: 's-other' } },
      { method: 'workspace', params: { workspace: 'wt-other' } }
    ])
    expect(JSON.parse(found.lines[0]!)).toMatchObject({ workspace: 'wt-other', pane: { id: 'pane-3' } })
    const fromEnv = await run('pane-get', [], {}, { answers, json: true, env: { QUIRKY_SESSION_ID: 's-other' } })
    expect(JSON.parse(fromEnv.lines[0]!)).toMatchObject({ workspace: 'wt-other' })
  })

  test('pane get on a session with --worktree looks in the worktree named, not the one paneOf names', async () => {
    const answers = {
      paneOf: { workspace: 'wt-other', tab: 'tab-2', pane: 'pane-3' },
      workspace: { workspace: WORKSPACE }
    }
    const { calls } = await run('pane-get', ['s-other'], { worktree: 'api' }, { answers })
    expect(calls).toEqual([
      { method: 'paneOf', params: { session: 's-other' } },
      { method: 'workspace', params: { workspace: 'api' } }
    ])
  })

  test('pane get --worktree looks only in that worktree', async () => {
    const { calls } = await run('pane-get', ['pane-3'], { worktree: 'api' }, { answers: { workspace: { workspace: WORKSPACE } } })
    expect(calls).toEqual([{ method: 'workspace', params: { workspace: 'api' } }])
  })
})

describe('usage errors', () => {
  const usage = async (name: string, positionals: string[], flags: Record<string, unknown>, message: string) =>
    expect(await failure(run(name, positionals, flags))).toMatchObject({ kind: 'usage', message })

  test('missing and surplus arguments', async () => {
    await usage('tab-close', [], {}, 'missing <tab>')
    await usage('tab-close', ['tab-1', 'tab-2'], {}, 'unexpected argument "tab-2"')
    await usage('tab-rename', ['tab-1'], {}, 'missing <title>')
    await usage('tab-color', ['tab-1'], {}, 'missing <color>')
    await usage('layout', ['x'], {}, 'unexpected argument "x"')
    await usage('group-close', [], {}, 'missing <group>')
    await usage('pane-title', [], {}, 'missing <title>')
    await usage('pane-title', ['a', 'b', 'c'], {}, 'unexpected argument "c"')
    await usage('pane-move', [], { 'to-tab': 'tab-1' }, 'missing <pane>')
    await usage('open-link', [], {}, 'missing <url-or-path>')
  })

  test('bad flag combinations', async () => {
    await usage('tab-new', [], { worktree: 'a', workspace: 'floating' }, 'pass --worktree or --workspace, not both')
    await usage('tab-move', ['tab-1'], {}, 'pass --group (with --index) or --split')
    await usage('tab-move', ['tab-1'], { split: 'down', group: 'grp-1' }, 'pass --group and --index, or --split, not both')
    await usage('tab-move', ['tab-1'], { split: 'down', index: 1 }, 'pass --group and --index, or --split, not both')
    await usage('tab-move', ['tab-1'], { group: 'grp-1', of: 'grp-2' }, '--of needs --split')
    await usage('tab-activate', [], {}, 'pass <tab> or --index')
    await usage('tab-activate', ['tab-1'], { index: 1 }, 'pass <tab> or --index')
    await usage('tab-activate', ['tab-1'], { group: 'grp-1' }, '--group goes with --index')
    await usage('pane-split', ['pane-1'], {}, 'missing required flag --direction')
    await usage('pane-focus', [], {}, 'pass <pane>, --next or --previous')
    await usage('pane-focus', ['pane-1'], { next: true }, 'pass <pane>, --next or --previous')
    await usage('pane-focus', [], { next: true, previous: true }, 'pass <pane>, --next or --previous')
    await usage('pane-resize', ['pane-1'], {}, 'missing required flag --ratio')
    await usage('pane-move', ['pane-1'], {}, 'pass --to-pane (with --edge) or --to-tab')
    await usage('pane-move', ['pane-1'], { 'to-pane': 'pane-2', 'to-tab': 'tab-1' }, 'pass --to-pane (with --edge) or --to-tab')
    await usage('pane-move', ['pane-1'], { 'to-pane': 'pane-2' }, '--to-pane needs --edge')
    await usage('pane-move', ['pane-1'], { 'to-tab': 'tab-1', edge: 'left' }, '--edge goes with --to-pane')
    await usage('group-resize', [], { ratio: 0.5 }, 'pass <group> or --split')
    await usage('group-resize', ['grp-1'], { split: 'split-1', ratio: 0.5 }, 'pass <group> or --split')
    await usage('group-resize', ['grp-1'], {}, 'missing required flag --ratio')
  })
})

describe('quick commands and the floating workspace', () => {
  const QUICK = [
    { id: 'test', label: 'Test', kind: 'terminal', agent: null, command: 'bun test', appendEnter: true, scope: 'global', repo: null },
    { id: 'review', label: 'Review', kind: 'agent', agent: 'claude', command: 'review\nthe diff\n', appendEnter: false, scope: 'repo', repo: 'api' }
  ]
  const FLOATING = { enabled: true, open: true, maximized: false, bounds: { x: 10, y: 20, width: 900, height: 500 }, button: null }

  test('quick-command list prints a table, with --all passed through', async () => {
    const answers = { quickCommands: { commands: QUICK } }
    const listed = await run('quick-command-list', [], {}, { answers })
    expect(listed.calls).toEqual([{ method: 'quickCommands', params: {} }])
    const rows = listed.lines[0]!.split('\n').map((row) => row.split(/\s{2,}/))
    expect(rows).toEqual([
      ['ID', 'LABEL', 'KIND', 'SCOPE', 'COMMAND'],
      ['test', 'Test', 'terminal', 'global', 'bun test'],
      ['review', 'Review', 'agent', 'repo', 'review; the diff']
    ])
    expect((await run('quick-command-list', [], { all: true }, { answers })).calls).toEqual([{ method: 'quickCommands', params: { all: true } }])
    expect(JSON.parse((await run('quick-command-list', [], {}, { answers, json: true })).lines[0]!)).toEqual({ commands: QUICK })
  })

  test('quick-command list --worktree scopes the list to that workspace', async () => {
    const answers = { quickCommands: { commands: QUICK } }
    const scoped = await run('quick-command-list', [], { worktree: 'name:docs' }, { answers })
    expect(scoped.calls).toEqual([{ method: 'quickCommands', params: { workspace: 'name:docs' } }])
  })

  test('quick-command add maps its flags, with --no-enter as appendEnter false', async () => {
    const answers = { addQuickCommand: { commands: QUICK } }
    const added = await run('quick-command-add', [], { label: 'Test', command: 'bun test' }, { answers })
    expect(added.calls).toEqual([{ method: 'addQuickCommand', params: { label: 'Test', command: 'bun test' } }])
    expect(added.lines[0]).toContain('review; the diff')
    const full = await run(
      'quick-command-add',
      [],
      { label: 'R', command: 'review', kind: 'agent', agent: 'claude', scope: 'repo', repo: 'api', 'no-enter': true },
      { answers }
    )
    expect(full.calls[0]!.params).toEqual({ label: 'R', command: 'review', kind: 'agent', agent: 'claude', scope: 'repo', repo: 'api', appendEnter: false })
  })

  test('quick-command add needs a label and a command', async () => {
    expect(await failure(run('quick-command-add', [], { command: 'x' }))).toMatchObject({ kind: 'usage', message: 'missing required flag --label' })
    expect(await failure(run('quick-command-add', [], { label: 'x' }))).toMatchObject({ kind: 'usage', message: 'missing required flag --command' })
  })

  test('quick-command update sends only the given fields', async () => {
    const answers = { updateQuickCommand: { commands: QUICK } }
    const updated = await run('quick-command-update', ['test'], { command: 'bun test -w', enter: true }, { answers })
    expect(updated.calls).toEqual([{ method: 'updateQuickCommand', params: { id: 'test', command: 'bun test -w', appendEnter: true } }])
    expect((await run('quick-command-update', ['test'], { 'no-enter': true }, { answers })).calls[0]!.params).toEqual({ id: 'test', appendEnter: false })
    expect(await failure(run('quick-command-update', ['test'], {}))).toMatchObject({ kind: 'usage' })
    expect(await failure(run('quick-command-update', ['test'], { enter: true, 'no-enter': true }))).toMatchObject({ kind: 'usage', message: 'pass --enter or --no-enter, not both' })
    expect(await failure(run('quick-command-update', [], { label: 'x' }))).toMatchObject({ kind: 'usage', message: 'missing <id>' })
  })

  test('quick-command remove and run', async () => {
    expect((await run('quick-command-remove', ['test'], {}, { answers: { removeQuickCommand: { commands: [QUICK[1]] } } })).calls).toEqual([
      { method: 'removeQuickCommand', params: { id: 'test' } }
    ])
    const newTab = await run('quick-command-run', ['test'], {})
    expect(newTab.calls).toEqual([{ method: 'runQuickCommand', params: { id: 'test' } }])
    expect(newTab.lines).toEqual([TREE])
    const inPane = await run('quick-command-run', ['test'], { pane: 'pane-3' }, { answers: { runQuickCommand: { ok: true, session: 's-3' } } })
    expect(inPane.calls).toEqual([{ method: 'runQuickCommand', params: { id: 'test', pane: 'pane-3' } }])
    expect(inPane.lines).toEqual(['ran test in s-3'])
    const bySession = await run('quick-command-run', ['test'], { pane: 's-3' }, { answers: { ...{ paneOf: { workspace: 'main', tab: 'tab-2', pane: 'pane-3' } }, runQuickCommand: { ok: true, session: 's-3' } } })
    expect(bySession.calls.at(-1)).toEqual({ method: 'runQuickCommand', params: { id: 'test', pane: 'pane-3' } })
  })

  test('floating state prints a record, and --json the raw state', async () => {
    const answers = { floating: FLOATING }
    expect((await run('floating-state', [], {}, { answers })).lines[0]!.split('\n')).toEqual([
      'enabled: true',
      'open: true',
      'maximized: false',
      'bounds: 10,20 900x500',
      'button: default'
    ])
    expect(JSON.parse((await run('floating-state', [], {}, { answers, json: true })).lines[0]!)).toEqual(FLOATING)
  })

  test('show, hide, maximize, restore and bounds call setFloating', async () => {
    const answers = { setFloating: FLOATING }
    const changes: [string, Record<string, unknown>, Record<string, unknown>][] = [
      ['floating-show', {}, { open: true }],
      ['floating-hide', {}, { open: false }],
      ['floating-maximize', {}, { maximized: true }],
      ['floating-restore', {}, { maximized: false }],
      ['floating-bounds', { x: 1, y: 2, width: 800, height: 400 }, { bounds: { x: 1, y: 2, width: 800, height: 400 } }]
    ]
    for (const [name, flags, params] of changes) {
      const { calls, lines } = await run(name, [], flags, { answers })
      expect(calls).toEqual([{ method: 'setFloating', params }])
      expect(lines[0]).toContain('open: true')
    }
    expect(await failure(run('floating-bounds', [], { x: 1, y: 2, width: 800 }))).toMatchObject({ kind: 'usage', message: 'missing required flag --height' })
  })

  test('floating toggle reads the state and flips open', async () => {
    const closing = await run('floating-toggle', [], {}, { answers: { floating: FLOATING, setFloating: { ...FLOATING, open: false } } })
    expect(closing.calls).toEqual([
      { method: 'floating', params: {} },
      { method: 'setFloating', params: { open: false } }
    ])
    const opening = await run('floating-toggle', [], {}, { answers: { floating: { ...FLOATING, open: false }, setFloating: FLOATING } })
    expect(opening.calls.at(-1)).toEqual({ method: 'setFloating', params: { open: true } })
  })
})

describe('through the real CLI', () => {
  let h: Harness
  beforeEach(async () => {
    process.env.QUIRKY_TEST_ENTER_DELAY_MS = '20'
    h = await startPluginHarness(TERMINAL_PLUGINS)
  })
  afterEach(async () => {
    delete process.env.QUIRKY_TEST_ENTER_DELAY_MS
    await h.cleanup()
  })

  const cli = (args: string[], env: Record<string, string> = {}) => runCli(['terminal', ...args], { home: h.home, env: { QUIRKY_WORKTREE_ID: 'wt_main', ...env } })
  const layout = async (): Promise<Workspace> => JSON.parse((await cli(['layout', '--worktree', 'main', '--json'])).stdout)
  const tabs = (ws: Workspace) => groupsInOrder(ws.root).flatMap((g) => g.tabs.filter(isTerminalTab))

  test('quirky terminal --help lists the new words', async () => {
    const help = await runCli(['terminal', '--help'], { home: h.home })
    expect(help.code).toBe(0)
    const listed = help.stdout.split('\n').map((line) => line.trim().split(/\s{2,}/)[0]!.replace(/^terminal /, '').replace(/ [<\[(-].*$/, ''))
    for (const words of [
      'layout',
      'tab new',
      'tab close',
      'tab close-others',
      'tab close-right',
      'tab close-left',
      'tab rename',
      'tab color',
      'tab pin',
      'tab unpin',
      'tab reopen',
      'tab move',
      'tab activate',
      'tab next',
      'tab previous',
      'pane split',
      'pane close',
      'pane restart',
      'pane focus',
      'pane title',
      'pane expand',
      'pane collapse',
      'pane equalize',
      'pane resize',
      'pane move',
      'pane clear',
      'pane reset',
      'pane get',
      'group close',
      'group resize',
      'quick-command list',
      'quick-command add',
      'quick-command update',
      'quick-command remove',
      'quick-command run',
      'floating state',
      'floating show',
      'floating hide',
      'floating toggle',
      'floating maximize',
      'floating restore',
      'floating bounds',
      'open-link'
    ]) {
      expect(listed).toContain(words)
    }
    expect(help.stdout).toContain('read')
  })

  test('SC-2: layout prints the tree of the workspace and --json its workspace object', async () => {
    const first = await cli(['tab', 'new', '--worktree', 'main'])
    expect(first.code).toBe(0)
    const second = await cli(['tab', 'new', '--worktree', 'main', '--title', 'Build'])
    expect(second.code).toBe(0)
    const ws = await layout()
    const [one, two] = tabs(ws)
    const text = await cli(['layout', '--worktree', 'main'])
    expect(text.stdout).toBe(
      [
        `group ${ws.activeGroup} (active)`,
        `  tab ${one!.id} "Terminal 1"`,
        `    pane ${one!.activePane} ${(one!.root as PaneLeaf).session}`,
        `  tab ${two!.id} "Build" (active)`,
        `    pane ${two!.activePane} ${(two!.root as PaneLeaf).session} (active)`
      ].join('\n') + '\n'
    )
    expect(second.stdout).toBe(text.stdout)
    expect(ws.revision).toBeGreaterThan(0)
    expect(ws.id).toBe('wt_main')
  })

  test('tab rename, color, pin and close change the layout and print the new tree', async () => {
    await cli(['tab', 'new', '--worktree', 'main'])
    await cli(['tab', 'new', '--worktree', 'main'])
    const [a, b] = tabs(await layout())
    expect((await cli(['tab', 'rename', b!.id, 'Logs'])).stdout).toContain(`tab ${b!.id} "Logs"`)
    expect((await cli(['tab', 'color', b!.id, 'blue'])).stdout).toContain(`tab ${b!.id} "Logs" blue`)
    expect(tabs(await layout()).find((t) => t.id === b!.id)).toMatchObject({ customTitle: 'Logs', color: 'blue' })
    await cli(['tab', 'pin', b!.id])
    expect(tabs(await layout()).map((t) => t.id)).toEqual([b!.id, a!.id])
    const unpinned = await cli(['tab', 'unpin', b!.id, '--json'])
    expect(JSON.parse(unpinned.stdout).workspace.id).toBe('wt_main')
    expect((await cli(['tab', 'close', a!.id])).code).toBe(0)
    expect(tabs(await layout()).map((t) => t.id)).toEqual([b!.id])
    const bad = await cli(['tab', 'color', b!.id, 'mauve'])
    expect(bad.code).toBe(2)
  })

  test('pane commands default to the pane showing $QUIRKY_SESSION_ID', async () => {
    await cli(['tab', 'new', '--worktree', 'main'])
    const ws = await layout()
    const only = tabs(ws)[0]!.root as PaneLeaf
    const env = { QUIRKY_SESSION_ID: only.session }
    const split = await cli(['pane', 'split', '--direction', 'right'], env)
    expect(split.code).toBe(0)
    expect(split.stdout).toContain('split right 0.5')
    const after = tabs(await layout())[0]!
    expect(paneLeaves(after.root)).toHaveLength(2)
    expect((await cli(['pane', 'title', 'logs'], env)).stdout).toContain(`pane ${only.id} ${only.session}`)
    const got = await cli(['pane', 'get'], env)
    expect(got.stdout).toContain(`pane: ${only.id}\nsession: ${only.session}`)
    expect(got.stdout).toContain('title: logs')
    const bySession = await cli(['pane', 'get', only.session, '--json'])
    expect(JSON.parse(bySession.stdout)).toMatchObject({ pane: { id: only.id, title: 'logs' }, workspace: 'wt_main' })
    const equalized = await cli(['pane', 'equalize'], env)
    expect(equalized.code).toBe(0)
  })

  test('SC-7: bad targets exit non-zero with the daemon\'s message and change nothing', async () => {
    await cli(['tab', 'new', '--worktree', 'main'])
    await cli(['tab', 'new', '--worktree', 'main'])
    const [first, second] = tabs(await layout())
    await cli(['tab', 'move', second!.id, '--split', 'right'])
    const before = await layout()
    const [one, two] = tabs(before)
    const lone = one!.root as PaneLeaf
    expect(one!.id).toBe(first!.id)

    const missing = await cli(['pane', 'focus', 'pane-99'])
    expect(missing.code).not.toBe(0)
    expect(missing.stderr).toContain('no pane pane-99')

    const last = await cli(['pane', 'move', lone.id, '--to-tab', two!.id])
    expect(last.code).not.toBe(0)
    expect(last.stderr).toContain("the last pane of a tab can't be moved out")

    const ratio = await cli(['group', 'resize', before.activeGroup, '--ratio', '0.9'])
    expect(ratio.code).not.toBe(0)
    expect(ratio.stderr).toContain('a group divider stays between 0.15 and 0.85')

    expect(await layout()).toEqual(before)
  })

  test('SC-14: closing a running agent tab asks unless --yes is given', async () => {
    await cli(['tab', 'new', '--worktree', 'main', '--agent', 'claude'])
    const [agent] = tabs(await layout())
    const refused = await cli(['tab', 'close', agent!.id])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('pass --yes')
    expect(tabs(await layout())).toHaveLength(1)

    const closed = await cli(['tab', 'close', agent!.id, '--yes'])
    expect(closed.code).toBe(0)
    await waitForAsync(async () => tabs(await layout()).length === 0)

    await cli(['tab', 'new', '--worktree', 'main', '--agent', 'claude'])
    const [again] = tabs(await layout())
    const pane = (again!.root as PaneLeaf).id
    expect((await cli(['pane', 'close', pane])).stderr).toContain('pass --yes')
    expect((await cli(['pane', 'close', pane, '--yes'])).code).toBe(0)
  })

  test('tab move, activate and group close work on two groups', async () => {
    for (let i = 0; i < 3; i++) await cli(['tab', 'new', '--worktree', 'main'])
    const [a, b, c] = tabs(await layout())
    const moved = await cli(['tab', 'move', c!.id, '--split', 'right'])
    expect(moved.code).toBe(0)
    const ws = await layout()
    const groups = groupsInOrder(ws.root)
    expect(groups.map((g) => g.tabs.map((t) => t.id))).toEqual([[a!.id, b!.id], [c!.id]])
    expect((await cli(['tab', 'activate', a!.id])).code).toBe(0)
    expect((await cli(['tab', 'activate', '--index', '2', '--group', groups[0]!.id])).code).toBe(0)
    expect(groupsInOrder((await layout()).root)[0]!.activeTab).toBe(b!.id)
    expect((await cli(['tab', 'previous'])).code).toBe(0)
    expect(groupsInOrder((await layout()).root)[0]!.activeTab).toBe(a!.id)
    const closed = await cli(['group', 'close', groups[1]!.id])
    expect(closed.code).toBe(0)
    expect(groupsInOrder((await layout()).root)).toHaveLength(1)
  })

  test('quick commands and the floating workspace round-trip through the CLI', async () => {
    const empty = await cli(['quick-command', 'list', '--all'])
    expect(empty.code).toBe(0)
    const added = await cli(['quick-command', 'add', '--label', 'Greet', '--command', 'echo hi', '--no-enter', '--json'])
    expect(added.code).toBe(0)
    expect(JSON.parse(added.stdout).commands).toMatchObject([{ id: 'greet', label: 'Greet', appendEnter: false, scope: 'global' }])
    const table = await cli(['quick-command', 'list', '--all'])
    expect(table.stdout.split('\n')[0]!.split(/\s+/)).toEqual(['ID', 'LABEL', 'KIND', 'SCOPE', 'COMMAND'])
    expect(table.stdout).toContain('echo hi')

    await cli(['tab', 'new', '--worktree', 'main'])
    const only = tabs(await layout())[0]!
    const pane = (only.root as PaneLeaf).id
    const ran = await cli(['quick-command', 'run', 'greet', '--pane', pane])
    expect(ran.stdout).toBe(`ran greet in ${(only.root as PaneLeaf).session}\n`)
    expect((await cli(['quick-command', 'update', 'greet', '--command', 'echo bye', '--enter', '--json'])).stdout).toContain('echo bye')
    expect((await cli(['quick-command', 'remove', 'greet', '--yes'])).code).toBe(0)
    expect(JSON.parse((await cli(['quick-command', 'list', '--all', '--json'])).stdout).commands).toEqual([])

    expect((await cli(['floating', 'state'])).stdout).toContain('open: false')
    expect((await cli(['floating', 'toggle'])).stdout).toContain('open: true')
    expect((await cli(['floating', 'maximize', '--json'])).stdout).toContain('"maximized":true')
    expect((await cli(['floating', 'restore', '--json'])).stdout).toContain('"maximized":false')
    const placed = await cli(['floating', 'bounds', '--x', '5', '--y', '6', '--width', '800', '--height', '500', '--json'])
    expect(JSON.parse(placed.stdout).bounds).toEqual({ x: 5, y: 6, width: 800, height: 500 })
    const tooSmall = await cli(['floating', 'bounds', '--x', '5', '--y', '6', '--width', '100', '--height', '100'])
    expect(tooSmall.code).not.toBe(0)
    expect(tooSmall.stderr).toContain('bounds must be at least 420x280')
    expect((await cli(['floating', 'hide'])).stdout).toContain('open: false')
  })

  test('open-link passes the target to the daemon, which refuses a bad one', async () => {
    const bad = await cli(['open-link', 'javascript:alert(1)'])
    expect(bad.code).not.toBe(0)
    expect(bad.stderr.length).toBeGreaterThan(0)
  })
})
