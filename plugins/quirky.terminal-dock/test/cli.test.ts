import { afterEach, expect, test } from 'bun:test'
import type { DockState } from '../src/types'
import { enableDock, launchFakeClaude, paneOf, startDockE2E, type DockHarness } from './support'

let harness: DockHarness | undefined
afterEach(async () => {
  await harness?.cleanup()
  harness = undefined
})

test(
  'SC-23: generated dock CLI reads, revision-edits, toggles and lists the canonical daemon state',
  async () => {
    harness = await startDockE2E()
    const session = await launchFakeClaude(harness)
    await enableDock(harness)
    const pane = await paneOf(harness, session.id)

    const initial = await harness.json<DockState>(['dock', 'get', '--pane', pane])
    expect(initial.docked).toBe(true)
    const edited = await harness.json<DockState>([
      'dock',
      'set',
      '--pane', pane,
      '--revision',
      String(initial.revision),
      '--draft',
      'set through CLI'
    ])
    expect(edited.draft).toBe('set through CLI')
    const resized = await harness.json<DockState>(['dock', 'set', '--pane', pane, '--gutter-rows', '7'])
    expect(resized.gutterRows).toBe(7)

    const toggled = await harness.json<DockState>(['dock', 'toggle', '--pane', pane])
    expect(toggled.docked).toBe(false)
    expect(toggled.userUndocked).toBe(true)
    const listed = await harness.json<{ panes: DockState[] }>(['dock', 'list'])
    expect(listed.panes.find((state) => state.pane === pane)?.draft).toBe('set through CLI')
  },
  90_000
)
