import { act, createElement } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { cleanup, command, loadQuickCommands, qc, qcFake, quickCommandsChanged, render, unloadQuickCommands } from './qc-support'
import type { QuickCommand } from '../../src/layout/types'

beforeAll(loadQuickCommands)
afterAll(unloadQuickCommands)
afterEach(cleanup)

type Pending = { workspace: string | undefined; resolve(commands: QuickCommand[]): void }

async function mountProbe(workspace: string) {
  const { fake } = qcFake()
  const pending: Pending[] = []
  fake.context.call = (async (_method: string, params: { workspace?: string }) =>
    await new Promise((resolve) => pending.push({ workspace: params.workspace, resolve: (commands) => resolve({ commands }) }))) as typeof fake.context.call
  const Probe = ({ workspace }: { workspace: string }) => {
    const state = qc().shared.useQuickCommands(fake.context, workspace)
    return createElement('span', { id: 'ids' }, state.commands.map((entry) => entry.id).join(','))
  }
  const view = await render(createElement(Probe, { workspace }))
  return { fake, pending, view, Probe, ids: () => document.getElementById('ids')!.textContent }
}

describe('useQuickCommands', () => {
  test('an older response that arrives after a newer one is discarded', async () => {
    const { fake, pending, ids } = await mountProbe('wt')
    await act(async () => fake.emit(quickCommandsChanged))
    expect(pending).toHaveLength(2)
    await act(async () => pending[1]!.resolve([command({ id: 'new' })]))
    expect(ids()).toBe('new')
    await act(async () => pending[0]!.resolve([command({ id: 'old' })]))
    expect(ids()).toBe('new')
  })

  test('a response for the previous workspace is discarded after the workspace changes', async () => {
    const { pending, view, Probe, ids } = await mountProbe('wt_a')
    await view.rerender(createElement(Probe, { workspace: 'wt_b' }))
    expect(pending.map((entry) => entry.workspace)).toEqual(['wt_a', 'wt_b'])
    await act(async () => pending[1]!.resolve([command({ id: 'b' })]))
    await act(async () => pending[0]!.resolve([command({ id: 'a' })]))
    expect(ids()).toBe('b')
  })
})
