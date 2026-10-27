import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode, type QuirkyClient, type Session } from '@quirky/protocol'
import type { Harness } from '../../../packages/daemon/test/helpers'
import type { Workspace } from '../src/layout/types'
import { groupsInOrder } from '../src/layout/tree'
import { sessionCreates } from './fakes/quirky.session/main'
import { call, startPluginHarness, TERMINAL_PLUGINS } from './support'

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

const newTab = (params: Record<string, unknown>) => call<{ workspace: Workspace }>(client, 'quirky.terminal/newTab', { workspace: WT, ...params })
const tabCount = async () => {
  const { workspace } = await call<{ workspace: Workspace }>(client, 'quirky.terminal/workspace', { workspace: WT })
  return groupsInOrder(workspace.root).flatMap((group) => group.tabs).length
}

describe('newTab extraArgs', () => {
  test('is forwarded to quirky.session/create when set', async () => {
    await newTab({ agent: 'claude', extraArgs: '--model opus' })
    expect(sessionCreates().at(-1)).toEqual({ worktree: 'id:wt_main', agent: 'claude', extraArgs: '--model opus' })
  })

  test('is omitted when blank or absent', async () => {
    await newTab({ agent: 'claude', extraArgs: '   ' })
    expect(sessionCreates().at(-1)).toEqual({ worktree: 'id:wt_main', agent: 'claude' })
    await newTab({ agent: 'claude', extraArgs: '' })
    expect(sessionCreates().at(-1)).toEqual({ worktree: 'id:wt_main', agent: 'claude' })
    await newTab({ agent: 'claude' })
    expect(sessionCreates().at(-1)).toEqual({ worktree: 'id:wt_main', agent: 'claude' })
  })

  test('a refusal from create propagates unchanged and adds no tab', async () => {
    const before = await tabCount()
    const failure = await newTab({ agent: 'claude', extraArgs: '--refused' }).then(() => null, (e: unknown) => e as Error & { code?: number })
    expect(failure?.code).toBe(RpcErrorCode.InvalidParams)
    expect(failure?.message).toContain('extraArgs')
    expect(await tabCount()).toBe(before)
    expect(await call<Session[]>(client, 'quirky.session/list', {})).toEqual([])
  })
})
