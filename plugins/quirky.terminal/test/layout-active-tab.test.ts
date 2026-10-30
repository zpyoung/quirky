import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { QuirkyClient } from '@quirky/protocol'
import { call, startPluginHarness, TERMINAL_PLUGINS } from './support'

const VIEW = 'view:quirky.terminal/emulator'
const selector = 'main'

let harness: Awaited<ReturnType<typeof startPluginHarness>> | undefined
let client: QuirkyClient

beforeEach(async () => {
  harness = await startPluginHarness(TERMINAL_PLUGINS)
  client = await harness.connect('cli')
})

afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

const terminal = <T = any>(method: string, params: Record<string, unknown> = {}) => call<T>(client, `quirky.terminal/${method}`, params)
const activeIcon = () => terminal<{ icon: unknown }>('activeTabIcon', { workspace: selector }).then((result) => result.icon)
const openView = (key: string, extra: Record<string, unknown> = {}) =>
  terminal('openViewTab', { workspace: selector, viewId: VIEW, key, title: key, ...extra })
const errorOf = async (promise: Promise<unknown>) => (await promise.then(() => null, (error: unknown) => error)) as (Error & { code?: number }) | null

describe('the active tab icon', () => {
  test('returns the icon the active view tab was opened with', async () => {
    const icon = { kind: 'file', path: '/work/repo/src/App.tsx' }
    await openView('first', { icon })
    expect(await activeIcon()).toEqual(icon)

    const tool = { kind: 'tool', name: 'git-branch', hue: 'blue' }
    await openView('second', { icon: tool })
    expect(await activeIcon()).toEqual(tool)

    const control = { kind: 'control', name: 'plus' }
    await openView('third', { icon: control })
    expect(await activeIcon()).toEqual(control)
  })

  test('is null for a view tab opened without an icon and for a terminal tab', async () => {
    await openView('plain')
    expect(await activeIcon()).toBeNull()

    await terminal('newTab', { workspace: selector })
    expect(await activeIcon()).toBeNull()
  })

  test('follows the active tab and updates when a reused tab is given a new icon', async () => {
    await openView('one', { icon: { kind: 'file', path: '/work/one.ts' } })
    await openView('two', { icon: { kind: 'file', path: '/work/two.ts' } })
    expect(await activeIcon()).toEqual({ kind: 'file', path: '/work/two.ts' })

    await openView('one', { icon: { kind: 'file', path: '/work/renamed.ts' } })
    expect(await activeIcon()).toEqual({ kind: 'file', path: '/work/renamed.ts' })
  })

  test('is null for a workspace with no tabs', async () => {
    expect(await activeIcon()).toBeNull()
  })
})

describe('openViewTab icon validation', () => {
  test.each([
    ['a string', 'file'],
    ['an unknown kind', { kind: 'emoji', name: 'x' }],
    ['a file without a path', { kind: 'file' }],
    ['a file with an empty path', { kind: 'file', path: '' }],
    ['a tool with an unknown hue', { kind: 'tool', name: 'git-branch', hue: 'chartreuse' }],
    ['a tool without a name', { kind: 'tool', hue: 'blue' }],
    ['a control without a name', { kind: 'control' }],
    ['a control with a non-string name', { kind: 'control', name: 3 }]
  ])('rejects %s', async (_label, icon) => {
    const error = await errorOf(openView('bad', { icon }))
    expect(error).not.toBeNull()
    expect(error!.message).toContain('icon')
    expect(await activeIcon()).toBeNull()
  })
})
