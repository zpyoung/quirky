import { afterEach, expect, test } from 'bun:test'
import type { UiModel } from '@quirky/protocol'
import {
  FEATURE_MS,
  focusedSession,
  splitPane,
  startFeatures,
  stopAll,
  termOf,
  until,
  viewReport,
  waitFor,
  type Features
} from './features-support'

afterEach(stopAll)

/** The Terminal settings of D27 and the default each has, which are Orca's. */
const D27_DEFAULTS: Record<string, boolean | number | string> = {
  'font-family': 'SF Mono',
  'font-size': 14,
  'font-weight': 500,
  'font-weight-bold': 700,
  'line-height': 1,
  'cursor-style': 'block',
  'cursor-blink': true,
  scrollback: 2000,
  'word-separators': " ()[]{}',\"`",
  'option-as-alt': 'auto',
  'jis-yen-backslash': false,
  'copy-on-select': false,
  'trim-gutter-on-copy': true,
  'allow-osc52': true,
  'right-click-paste': false,
  'focus-follows-mouse': false,
  'scroll-sensitivity': 1.15,
  'fast-scroll-sensitivity': 5,
  'gpu-acceleration': 'auto',
  'minimum-contrast': 1,
  'inactive-pane-opacity': 0.9,
  'divider-thickness': 3,
  'padding-x': 4,
  'padding-y': 4,
  'background-opacity': 1,
  'link-click': 'actions',
  'link-middle-click': 'open',
  'confirm-close-running': true,
  'confirm-close-pinned': true,
  'ctrl-tab-order': 'mru',
  'shortcut-policy': 'app-first',
  'floating-enabled': true,
  'floating-cwd': '~'
}

const setSetting = (f: Features, name: string, value: string) => f.h.cli(['setting', 'set', `setting:quirky.terminal/${name}`, value])

/** A label's own text, without the text of the select options inside it. */
const ownText = (label: Element) =>
  [...label.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent)
    .join('')

test(
  'SC-64: every terminal setting appears in the Settings dialog with its default',
  async () => {
    const f = await startFeatures()
    const model = JSON.parse(await f.h.ok(['ui', 'contributions', '--json'])) as UiModel
    const mine = model.settings.filter((setting) => setting.plugin === 'quirky.terminal')
    expect(mine.map((setting) => setting.id.replace('setting:quirky.terminal/', '')).sort()).toEqual(Object.keys(D27_DEFAULTS).sort())
    for (const setting of mine) expect(setting.default, setting.id).toEqual(D27_DEFAULTS[setting.id.replace('setting:quirky.terminal/', '')])

    document.querySelector<HTMLElement>('button.gear')!.click()
    const group = await until(f, () => [...document.querySelectorAll('[role="dialog"] fieldset.settings-group')].find((fieldset) => fieldset.querySelector('legend')?.textContent === 'quirky.terminal'))
    const labels = [...group.querySelectorAll('label')]
    for (const setting of mine) {
      const name = setting.id.replace('setting:quirky.terminal/', '')
      const label = labels.find((candidate) => ownText(candidate).trim() === setting.title)
      expect(label, `${name} (${setting.title}) in the dialog`).toBeDefined()
      const input = label!.querySelector('input, select') as HTMLInputElement | HTMLSelectElement
      const shown = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input instanceof HTMLInputElement && input.type === 'number' ? Number(input.value) : input.value
      // the harness runs without a GPU, so its GPU setting is off
      expect(shown, name).toEqual(name === 'gpu-acceleration' ? 'off' : D27_DEFAULTS[name])
    }
  },
  FEATURE_MS
)

test(
  'SC-64: terminal settings apply live',
  async () => {
    const f = await startFeatures()
    const first = focusedSession((await viewReport(f, 'a mounted pane')))
    const pane = (await viewReport(f, 'a mounted pane')).focusedPane!
    const second = await splitPane(f.h, pane, 'right')
    const report = await viewReport(f, 'two mounted panes', (candidate) => candidate.panes.length === 2)
    const sessions = report.panes.map((entry) => entry.session)
    expect(sessions).toContain(first)
    const opened = f.terminals.length

    for (const [name, value] of [
      ['font-size', '16'],
      ['cursor-style', 'bar'],
      ['line-height', '1.2'],
      ['inactive-pane-opacity', '0.5'],
      ['divider-thickness', '6'],
      ['scrollback', '3000']
    ] as const) {
      const done = await setSetting(f, name, value)
      expect(done.code, `${name}: ${done.stderr}`).toBe(0)
    }

    await viewReport(f, 'font size 16 in both panes', (candidate) => candidate.panes.length === 2 && candidate.panes.every((entry) => entry.fontSize === 16))
    await waitFor('both terminals to follow the settings', () =>
      sessions.every((session) => {
        const term = termOf(f, session)
        return term.options.fontSize === 16 && term.options.cursorStyle === 'bar' && term.options.lineHeight === 1.2 && term.options.scrollback === 3000
      })
        ? true
        : undefined
    )
    // the focused pane keeps full opacity and the other takes the setting
    await waitFor('the inactive opacity', () => {
      const opacities = sessions.map((session) => Number(termOf(f, session).element!.closest<HTMLElement>('[data-terminal-pane]')!.style.opacity))
      return opacities.filter((opacity) => opacity === 0.5).length === 1 && opacities.filter((opacity) => opacity === 1).length === 1 ? true : undefined
    })
    await waitFor('the thicker divider', () => (document.querySelector<HTMLElement>('[data-divider]')?.style.width === '6px' ? true : undefined))
    expect(f.terminals.length).toBe(opened)
    expect(second.pane.session).toBeTruthy()

    // values outside a setting's range are refused and nothing changes
    for (const [name, value] of [
      ['font-size', '9'],
      ['font-size', '25'],
      ['line-height', '0.5'],
      ['scrollback', '100'],
      ['divider-thickness', '40'],
      ['inactive-pane-opacity', '2'],
      ['cursor-style', 'wide']
    ] as const) {
      const refused = await setSetting(f, name, value)
      expect(refused.code, `${name} ${value}`).not.toBe(0)
    }
    expect(termOf(f, sessions[0]!).options.fontSize).toBe(16)
    expect((await viewReport(f, 'the unchanged font size')).panes.map((entry) => entry.fontSize)).toEqual([16, 16])
  },
  FEATURE_MS
)
