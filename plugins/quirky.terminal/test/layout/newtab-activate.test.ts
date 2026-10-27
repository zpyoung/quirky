import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { QuirkyClient } from '@quirky/protocol'
import type { Harness } from '../../../../packages/daemon/test/helpers'
import { groupsInOrder, paneLeaves } from '../../src/layout/tree'
import type { Tab, Workspace } from '../../src/layout/types'
import { sessionCreates } from '../fakes/quirky.session/main'
import { call, startPluginHarness, TERMINAL_PLUGINS } from '../support'

const WT = 'wt_main'

let h: Harness
let client: QuirkyClient

beforeEach(async () => {
  sessionCreates().length = 0
  h = await startPluginHarness(TERMINAL_PLUGINS)
  client = await h.connect('cli')
})
afterEach(async () => {
  await h.cleanup()
})

type NewTabResult = { workspace: Workspace; session: string; tab: string; pane: string }

const api = (method: string, params: Record<string, unknown> = {}) => call<any>(client, `quirky.terminal/${method}`, params)
const newTab = (params: Record<string, unknown> = {}) => api('newTab', { workspace: WT, ...params }) as Promise<NewTabResult>
const tabsOf = (ws: Workspace): Tab[] => groupsInOrder(ws.root).flatMap((group) => group.tabs)

describe('newTab result', () => {
  test('names the new session, tab and pane', async () => {
    const result = await newTab()
    const tab = tabsOf(result.workspace).find((entry) => entry.id === result.tab)!
    const [leaf] = paneLeaves(tab.root)
    expect(leaf!.id).toBe(result.pane)
    expect(leaf!.session).toBe(result.session)
    expect(tab.activePane).toBe(result.pane)
  })

  test('names the new ids when the tab is not activated', async () => {
    const result = await newTab({ activate: false })
    const tab = tabsOf(result.workspace).find((entry) => entry.id === result.tab)!
    expect(paneLeaves(tab.root)[0]!.session).toBe(result.session)
    expect(paneLeaves(tab.root)[0]!.id).toBe(result.pane)
  })
})

describe('newTab activate', () => {
  test('defaults to taking focus', async () => {
    const first = await newTab()
    const second = await newTab()
    const group = groupsInOrder(second.workspace.root)[0]!
    expect(group.activeTab).toBe(second.tab)
    expect(group.recent[0]).toBe(second.tab)
    expect(group.recent).toContain(first.tab)
    expect(second.workspace.activeGroup).toBe(group.id)
  })

  test('true takes focus like the default', async () => {
    await newTab()
    const second = await newTab({ activate: true })
    expect(groupsInOrder(second.workspace.root)[0]!.activeTab).toBe(second.tab)
  })

  test('false appends the tab and leaves the active tab, recent list and active group alone', async () => {
    const first = await newTab()
    const before = groupsInOrder(first.workspace.root)[0]!
    const second = await newTab({ activate: false })
    const after = groupsInOrder(second.workspace.root)[0]!
    expect(after.tabs.map((tab) => tab.id)).toEqual([first.tab, second.tab])
    expect(after.activeTab).toBe(before.activeTab)
    expect(after.activeTab).toBe(first.tab)
    expect(after.recent).toEqual(before.recent)
    expect(second.workspace.activeGroup).toBe(first.workspace.activeGroup)
  })

  test('false in a group other than the active one leaves the active group and that group\'s active tab', async () => {
    await newTab()
    const second = await newTab()
    const moved = (await api('moveTab', { tab: second.tab, split: 'right' })).workspace as Workspace
    const [left, right] = groupsInOrder(moved.root)
    const other = moved.activeGroup === left!.id ? right! : left!
    const result = await newTab({ group: other.id, activate: false })
    const target = groupsInOrder(result.workspace.root).find((group) => group.id === other.id)!
    expect(target.tabs.map((tab) => tab.id)).toContain(result.tab)
    expect(target.activeTab).toBe(other.activeTab)
    expect(result.workspace.activeGroup).toBe(moved.activeGroup)
  })

  test('false into an empty group appends the tab, which normalisation makes its only active tab', async () => {
    const result = await newTab({ activate: false })
    const group = groupsInOrder(result.workspace.root)[0]!
    expect(group.tabs.map((tab) => tab.id)).toEqual([result.tab])
    expect(group.activeTab).toBe(result.tab)
  })
})
