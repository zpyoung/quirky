import { describe, expect, test } from 'bun:test'
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

})
