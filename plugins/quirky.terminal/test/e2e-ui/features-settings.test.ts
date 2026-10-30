import { afterEach, expect, test } from 'bun:test'
import type { SettingInfo } from '@quirky/protocol'
import { flushSync } from 'react-dom'
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

async function openSettings(f: Features): Promise<void> {
  document.querySelector<HTMLButtonElement>('button[aria-label="More"]')!.click()
  const row = await until(f, () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === 'Settings'))
  row.click()
}


const setSetting = (f: Features, name: string, value: string) => f.h.cli(['setting', 'set', `setting:quirky.terminal/${name}`, value])

test(
  'SC-64: canonical terminal URL click settings remain editable in Browser settings',
  async () => {
    const f = await startFeatures()
    await openSettings(f)
    const select = await until(f, () => {
      const label = [...document.querySelectorAll<HTMLLabelElement>('[role="dialog"] label')]
        .find((candidate) => candidate.textContent?.trim() === 'Terminal URL clicks')
      const control = label?.control
      return control instanceof HTMLSelectElement ? control : undefined
    })
    flushSync(() => {
      select.value = 'terminal'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await f.win.click('[role="dialog"] button[type="submit"]')
    const persisted = await waitFor('the canonical URL click setting to persist', async () => {
      const setting = await f.h.call<SettingInfo>('setting.get', { id: 'setting:quirky.terminal/link-click' })
      return setting.value === 'terminal' ? setting : undefined
    })
    expect(persisted.value).toBe('terminal')
    expect(persisted.source).toBe('user')
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
