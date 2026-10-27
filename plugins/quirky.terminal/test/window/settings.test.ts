import { describe, expect, test } from 'bun:test'
import manifest from '../../quirky-plugin.json'
import { TERMINAL_SETTING_DEFAULTS } from '../ui-fake'
import { DEFAULT_PANE_SETTINGS, fontStack, readPaneSettings, zoomed } from '../../src/window/pane/settings'

describe('pane settings', () => {
  test('a setting the daemon lacks keeps its default and the others are read', () => {
    const settings = readPaneSettings({
      getSetting(name) {
        if (name === 'font-size') return 16
        throw new Error(`no setting ${name}`)
      }
    })
    expect(settings['font-size']).toBe(16)
    expect(settings.scrollback).toBe(DEFAULT_PANE_SETTINGS.scrollback)
  })

  test('the font stack quotes a spaced family and appends the fallbacks', () => {
    expect(fontStack('SF Mono')).toBe('"SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace')
    expect(fontStack('Menlo')).toBe('Menlo, ui-monospace, SFMono-Regular, Menlo, monospace')
    expect(fontStack('"Fira Code", monospace')).toBe('"Fira Code", monospace, ui-monospace, SFMono-Regular, Menlo, monospace')
    expect(fontStack('  ')).toBe('ui-monospace, SFMono-Regular, Menlo, monospace')
  })

  test('SC-35: zoom steps by one pixel inside 8 to 32', () => {
    expect(zoomed(14, 1)).toBe(15)
    expect(zoomed(32, 1)).toBe(32)
    expect(zoomed(8, -1)).toBe(8)
  })

  test('the defaults match the fake context and every manifest setting the pane reads', () => {
    for (const [id, value] of Object.entries(DEFAULT_PANE_SETTINGS)) expect(TERMINAL_SETTING_DEFAULTS[id]).toEqual(value)
    for (const setting of manifest.contributes.setting) {
      if (setting.id in DEFAULT_PANE_SETTINGS) expect(setting.default as unknown).toEqual(DEFAULT_PANE_SETTINGS[setting.id as keyof typeof DEFAULT_PANE_SETTINGS])
    }
  })
})
