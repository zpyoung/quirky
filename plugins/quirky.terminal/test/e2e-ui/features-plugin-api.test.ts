import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UiModel, UiState } from '@quirky/protocol'
import {
  FEATURE_MS,
  focusTerminal,
  focusedSession,
  openWorktreeView,
  press,
  slotOf,
  startFeatures,
  stopAll,
  uiState,
  until,
  viewReport,
  waitFor,
  type Features
} from './features-support'

const scratch: string[] = []
afterEach(async () => {
  await stopAll()
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Writes a plugin with a manifest and a plain-JavaScript window module, and returns its directory. */
function writePlugin(id: string, contributes: Record<string, unknown[]>, ui: string): string {
  const root = mkdtempSync('/tmp/qp-')
  scratch.push(root)
  const dir = join(root, id)
  mkdirSync(dir)
  writeFileSync(join(dir, 'quirky-plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', ui: 'ui.js', contributes }))
  writeFileSync(join(dir, 'ui.js'), ui)
  return dir
}

const install = (f: Features, dir: string) => f.h.cli(['plugin', 'install', dir, '--yes'])
const OVERLAY = 'overlay:test.overlay/badge'

const OVERLAY_UI = `
let report
export function activate(context) {
  context.provide('${OVERLAY}', (element, props) => {
    report = props.report
    const badge = document.createElement('div')
    badge.dataset.testBadge = ''
    badge.textContent = 'overlay-up'
    element.append(badge)
    report?.({ shown: true, text: 'overlay-up' })
    return () => {
      report = undefined
      badge.remove()
    }
  })
  context.provide('command:test.overlay/hide', () => {
    report?.({ shown: false, text: 'overlay-hidden' })
    return { hidden: true }
  })
  context.provide('command:test.overlay/show', () => {
    report?.({ shown: true, text: 'overlay-up' })
    return { shown: true }
  })
}
`

const badge = () => document.querySelector(`.overlay-layer [data-plugin-overlay="${OVERLAY}"] [data-test-badge]`)
const overlaySlot = (state: UiState) => slotOf(state, OVERLAY)

test(
  'SC-67: a plugin overlay slot',
  async () => {
    const f = await startFeatures({ window: false })
    const { h } = f
    const dir = writePlugin(
      'test.overlay',
      {
        overlay: [{ id: 'badge', title: 'Test badge' }],
        command: [
          { id: 'hide', title: 'Hide the badge' },
          { id: 'show', title: 'Show the badge' }
        ]
      },
      OVERLAY_UI
    )
    const installed = await install(f, dir)
    expect(installed.code, installed.stderr).toBe(0)

    // before any window starts the overlay is listed but not shown
    expect(overlaySlot(await uiState(f))).toMatchObject({ kind: 'overlay', plugin: 'test.overlay', title: 'Test badge', shown: false })

    await f.startWindow()
    await until(f, badge)
    expect(document.querySelector('.overlay-layer')?.contains(badge())).toBe(true)
    const mounted = await waitFor('the overlay report', async () => {
      const slot = overlaySlot(JSON.parse(await h.ok(['ui', 'state', '--json'])) as UiState)
      return slot?.report !== undefined ? slot : undefined
    })
    expect(mounted).toMatchObject({ id: OVERLAY, kind: 'overlay', plugin: 'test.overlay', shown: true, report: { shown: true, text: 'overlay-up' } })
    expect(((JSON.parse(await h.ok(['ui', 'contributions', '--json'])) as UiModel).overlays).map((overlay) => overlay.id)).toContain(OVERLAY)

    // shown follows the overlay's own report
    const hidden = await h.json<{ result: { hidden: boolean } }>(['ui', 'run', 'command:test.overlay/hide'])
    expect(hidden.result).toEqual({ hidden: true })
    await waitFor('the overlay to report hidden', async () => (overlaySlot(await uiState(f))?.shown === false ? true : undefined))
    expect(overlaySlot(await uiState(f))?.report).toEqual({ shown: false, text: 'overlay-hidden' })
    expect(badge()).not.toBeNull()
    await h.ok(['ui', 'run', 'command:test.overlay/show'])
    await waitFor('the overlay to report shown again', async () => (overlaySlot(await uiState(f))?.shown === true ? true : undefined))

    // with no window mounting it, it is not shown
    await f.stopWindow()
    await waitFor('no window', async () => ((await uiState(f)).windows.length === 0 ? true : undefined))
    expect(overlaySlot(await uiState(f))?.shown).toBe(false)
    await f.startWindow()
    await until(f, badge)
    await waitFor('the overlay shown by the new window', async () => (overlaySlot(await uiState(f))?.shown === true ? true : undefined))

    // disabling the plugin removes it
    const disabled = await h.cli(['plugin', 'disable', 'test.overlay'])
    expect(disabled.code, disabled.stderr).toBe(0)
    await waitFor('the overlay to leave the window', () => (badge() === null ? true : undefined))
    await waitFor('the slot to leave the state', async () => (overlaySlot(await uiState(f)) === undefined ? true : undefined))
    expect(((JSON.parse(await h.ok(['ui', 'contributions', '--json'])) as UiModel).overlays).map((overlay) => overlay.id)).not.toContain(OVERLAY)
  },
  FEATURE_MS
)

const KEYS_UI = `
globalThis.__sc68 = []
export function activate(context) {
  context.provide('command:test.keys/in-terminal', () => globalThis.__sc68.push('in-terminal'))
  context.provide('command:test.keys/elsewhere', () => globalThis.__sc68.push('elsewhere'))
}
`

test(
  'SC-68: keybinding when',
  async () => {
    const f = await startFeatures({ window: false })
    const { h } = f
    const dir = writePlugin(
      'test.keys',
      {
        command: [
          { id: 'in-terminal', title: 'Runs in a terminal' },
          { id: 'elsewhere', title: 'Runs elsewhere' }
        ],
        keybinding: [
          { id: 'in-terminal', key: 'mod+j', command: 'in-terminal', when: 'terminalFocus' },
          { id: 'elsewhere', key: 'mod+j', command: 'elsewhere', when: '!terminalFocus' }
        ]
      },
      KEYS_UI
    )
    const installed = await install(f, dir)
    expect(installed.code, installed.stderr).toBe(0)

    // both bindings are active with their conditions
    const model = JSON.parse(await h.ok(['ui', 'contributions', '--json'])) as UiModel
    const mine = model.keybindings.filter((binding) => binding.plugin === 'test.keys')
    expect(mine.map((binding) => [binding.key, binding.command, binding.when, binding.status])).toEqual([
      ['mod+j', 'command:test.keys/elsewhere', '!terminalFocus', 'active'],
      ['mod+j', 'command:test.keys/in-terminal', 'terminalFocus', 'active']
    ])

    await f.startWindow()
    const report = await openWorktreeView(f)
    await focusTerminal(f, focusedSession(report))
    await waitFor('terminal focus', () => ((f.win.host as unknown as { contextValues: Map<string, boolean> }).contextValues.get('terminalFocus') ? true : undefined))
    const calls = () => (globalThis as { __sc68?: string[] }).__sc68 ?? []

    const inTerminal = await press('mod+j')
    expect(inTerminal.defaultPrevented).toBe(true)
    await waitFor('the terminal binding to run', () => (calls().length === 1 ? true : undefined))
    expect(calls()).toEqual(['in-terminal'])

    const gear = document.querySelector<HTMLElement>('button.gear')!
    gear.focus()
    await waitFor('terminal focus to leave', () => (!(f.win.host as unknown as { contextValues: Map<string, boolean> }).contextValues.get('terminalFocus') ? true : undefined))
    await press('mod+j', gear)
    await waitFor('the other binding to run', () => (calls().length === 2 ? true : undefined))
    await Bun.sleep(150)
    expect(calls()).toEqual(['in-terminal', 'elsewhere'])
    expect((await viewReport(f, 'the workspace view')).panes).toHaveLength(1)

    // a when that does not parse makes the plugin invalid, and says why
    const broken = writePlugin('test.broken', { command: [{ id: 'go', title: 'Go' }], keybinding: [{ id: 'k', key: 'mod+j', command: 'go', when: 'terminalFocus &&' }] }, KEYS_UI)
    for (const verb of ['inspect', 'install']) {
      const refused = await h.cli(['plugin', verb, broken, '--yes'])
      expect(refused.code, verb).not.toBe(0)
      expect(refused.stderr, verb).toContain('keybinding k: when is invalid: expected a key at the end')
    }
  },
  FEATURE_MS
)
