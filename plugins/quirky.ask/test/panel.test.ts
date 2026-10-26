import { afterEach, describe, expect, test } from 'bun:test'
import type { QuirkyEvent, UiState } from '@quirky/protocol'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import { askOnlyPluginsDir, cleanupAll, openWindow, PANEL, spec, startAsk } from './support'

afterEach(cleanupAll)

const OTHER_PANEL = 'panel:quirky.fake/other'

async function startWithOtherPanel() {
  const builtin = askOnlyPluginsDir()
  writePlugin(builtin, {
    id: 'quirky.fake',
    name: 'Fake',
    version: '1.0.0',
    contributes: { panel: [{ id: 'other', title: 'Other' }] }
  })
  return startAsk(undefined, builtin)
}

const layoutOf = async (client: { call: (method: 'ui.state', params: {}) => Promise<UiState> }) => (await client.call('ui.state', {})).layout

describe('the Questions panel', () => {
  test('SC-31: with a window connected and no panel open, a new ask opens the panel and notifies', async () => {
    const h = await startAsk()
    const window = await openWindow(h)
    const agent = await h.connect('cli')
    expect((await layoutOf(agent)).panel).toBeNull()

    const { askId } = (await agent.callAny('quirky.ask/create', { spec })) as { askId: string }

    expect((await layoutOf(agent)).panel).toBe(PANEL)
    const notify = await waitFor(() => window.events.find((event): event is Extract<QuirkyEvent, { type: 'notify' }> => event.type === 'notify'))
    expect(notify).toMatchObject({ title: 'Deploy?', body: 'Which environment?' })
    expect(notify.open).toBeUndefined()
    expect((await agent.callAny('quirky.ask/list', { pendingOnly: true })) as unknown[]).toHaveLength(1)
    expect(askId).toMatch(/^ask_/)
  })

  test('SC-31: another open panel stays as it is', async () => {
    const h = await startWithOtherPanel()
    await openWindow(h)
    const agent = await h.connect('cli')
    await agent.call('ui.panel.open', { id: OTHER_PANEL })

    await agent.callAny('quirky.ask/create', { spec })

    expect((await layoutOf(agent)).panel).toBe(OTHER_PANEL)
  })

  test('SC-31: an already open Questions panel is left alone for a second ask', async () => {
    const h = await startAsk()
    const window = await openWindow(h)
    const agent = await h.connect('cli')
    await agent.callAny('quirky.ask/create', { spec })
    await agent.call('ui.sidebar.set', { visible: false })
    const changes = () => window.events.filter((event) => event.type === 'ui.state.changed').length
    const before = changes()

    await agent.callAny('quirky.ask/create', { spec })

    expect((await layoutOf(agent)).panel).toBe(PANEL)
    expect(changes()).toBe(before)
  })

  test('with no window connected nothing is opened, and the ask is still created', async () => {
    const h = await startAsk()
    const agent = await h.connect('cli')
    await h.connect('cli')

    await agent.callAny('quirky.ask/create', { spec })

    expect((await layoutOf(agent)).panel).toBeNull()
    expect(h.notifications).toEqual([{ title: 'Deploy?', body: 'Which environment?' }])
  })
})
