import { afterEach, expect, test } from 'bun:test'
import { QuirkyClient, RpcErrorCode } from '@quirky/protocol'
import { waitForAsync, type Harness } from '../../../../packages/daemon/test/helpers'
import { groupsInOrder, paneLeaves } from '../../src/layout/tree'
import type { Group, Workspace } from '../../src/layout/types'
import { call, createSession, startPluginHarness, TERMINAL_PLUGINS } from '../support'

let h: Harness
let client: QuirkyClient

afterEach(async () => {
  client.close()
  await h.cleanup()
})

const api = <T>(method: string, params: Record<string, unknown> = {}) => call<T>(client, `quirky.terminal/${method}`, params)
const groups = (workspace: Workspace): Group[] => groupsInOrder(workspace.root)
const allPanes = (workspace: Workspace) => groups(workspace).flatMap((group) => group.tabs.flatMap((tab) => paneLeaves(tab.root)))

async function start(): Promise<void> {
  h = await startPluginHarness(TERMINAL_PLUGINS)
  client = await h.connect('cli')
}

test('groupInfo reports the owner and adoptSession moves an auto-adopted tab exactly once', async () => {
  await start()
  let workspace = (await api<{ workspace: Workspace }>('workspace', { workspace: 'wt_main', ensure: true })).workspace
  workspace = (await api<{ workspace: Workspace }>('newTab', { workspace: 'wt_main', title: 'Second' })).workspace
  const firstGroup = groups(workspace)[0]!
  const secondTab = firstGroup.tabs[1]!
  workspace = (await api<{ workspace: Workspace }>('moveTab', { tab: secondTab.id, split: 'right', of: firstGroup.id })).workspace
  const [left, right] = groups(workspace)
  if (!left || !right) throw new Error('the fixture should contain two tab groups')
  expect(await api<{ workspace: string }>('groupInfo', { group: right.id })).toEqual({ workspace: 'wt_main' })

  const session = await createSession(client, { worktree: 'id:wt_main', agent: 'shell' })
  await waitForAsync(async () => {
    const current = (await api<{ workspace: Workspace }>('workspace', { workspace: 'wt_main' })).workspace
    return allPanes(current).some((pane) => pane.session === session.id) ? current : null
  })
  const before = (await api<{ workspace: Workspace }>('workspace', { workspace: 'wt_main' })).workspace
  expect(allPanes(before).filter((pane) => pane.session === session.id)).toHaveLength(1)

  await api<{ workspace: Workspace }>('adoptSession', { session: session.id, group: right.id })
  await api<{ workspace: Workspace }>('adoptSession', { session: session.id, group: right.id })
  const after = (await api<{ workspace: Workspace }>('workspace', { workspace: 'wt_main' })).workspace
  expect(allPanes(after).filter((pane) => pane.session === session.id)).toHaveLength(1)
  expect(groups(after).find((group) => group.id === right.id)?.tabs.some((tab) => paneLeaves(tab.root).some((pane) => pane.session === session.id))).toBe(true)
})

test('adoptSession rejects a group owned by another worktree before changing either layout', async () => {
  await start()
  const main = (await api<{ workspace: Workspace }>('workspace', { workspace: 'wt_main', ensure: true })).workspace
  const group = groups(main)[0]!
  const other = await createSession(client, { worktree: 'id:wt_other', agent: 'shell' })

  await expect(api<{ workspace: Workspace }>('adoptSession', { session: other.id, group: group.id })).rejects.toMatchObject({ code: RpcErrorCode.Conflict })
  const mainAfter = (await api<{ workspace: Workspace }>('workspace', { workspace: 'wt_main' })).workspace
  expect(allPanes(mainAfter).some((pane) => pane.session === other.id)).toBe(false)
})

test('groupInfo rejects an unknown group without guessing a workspace', async () => {
  await start()
  await expect(api<{ workspace: string }>('groupInfo', { group: 'grp-not-present' })).rejects.toMatchObject({ code: RpcErrorCode.NotFound })
})
