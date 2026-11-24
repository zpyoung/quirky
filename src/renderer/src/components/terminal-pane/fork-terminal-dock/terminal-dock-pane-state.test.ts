// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_GUTTER_ROWS,
  MAX_GUTTER_ROWS,
  MAX_STORED_PANE_ENTRIES,
  MIN_GUTTER_ROWS,
  readTerminalDockPaneAgent,
  readTerminalDockPaneState,
  readTerminalDockPaneUserUndocked,
  rekeyTerminalDockPaneKeys,
  removeTerminalDockPaneKeys,
  writeTerminalDockPaneAgent,
  writeTerminalDockPaneState,
  writeTerminalDockPaneUserUndocked
} from './terminal-dock-pane-state'

const STORAGE_KEY = 'quirky.terminalDock.paneState.v1'

function hasStoredPaneEntry(paneKey: string): boolean {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  return raw !== null && Object.hasOwn(JSON.parse(raw) as Record<string, unknown>, paneKey)
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe('readTerminalDockPaneState', () => {
  it('defaults to not docked with the default gutter height when absent', () => {
    expect(readTerminalDockPaneState('pane-1')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
  })

  it('round-trips a written value through localStorage', () => {
    writeTerminalDockPaneState('pane-1', { docked: true, gutterRows: 8 })
    expect(readTerminalDockPaneState('pane-1')).toEqual({ docked: true, gutterRows: 8 })
    const raw = window.localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toEqual({ 'pane-1': { docked: true, gutterRows: 8 } })
  })

  it.each([
    ['above the max', 999, MAX_GUTTER_ROWS],
    ['below the min', -5, MIN_GUTTER_ROWS]
  ])('clamps gutterRows %s on write', (_, gutterRows, expected) => {
    writeTerminalDockPaneState('pane-1', { docked: true, gutterRows })
    expect(readTerminalDockPaneState('pane-1').gutterRows).toBe(expected)
  })

  it('clamps an out-of-range gutterRows found directly in storage on read', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'pane-1': { docked: true, gutterRows: 42 } })
    )
    expect(readTerminalDockPaneState('pane-1')).toEqual({
      docked: true,
      gutterRows: MAX_GUTTER_ROWS
    })
  })

  it('drops a malformed entry rather than throwing', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'pane-1': { docked: 'yes', gutterRows: 5 },
        'pane-2': { docked: true },
        'pane-3': 'not-an-object',
        'pane-4': { docked: true, gutterRows: 6 }
      })
    )
    expect(readTerminalDockPaneState('pane-1')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
    expect(readTerminalDockPaneState('pane-2')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
    expect(readTerminalDockPaneState('pane-3')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
    expect(readTerminalDockPaneState('pane-4')).toEqual({ docked: true, gutterRows: 6 })
  })

  it('survives corrupt JSON without throwing', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json')
    expect(readTerminalDockPaneState('pane-1')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
  })

  it('rejects unsafe keys read from storage', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        __proto__: { docked: true, gutterRows: 9 },
        constructor: { docked: true, gutterRows: 9 },
        prototype: { docked: true, gutterRows: 9 }
      })
    )
    expect(readTerminalDockPaneState('__proto__')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
    expect(readTerminalDockPaneState('constructor')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('terminal dock user-undock decision', () => {
  it('defaults to false when absent or written only by the agent latch', () => {
    expect(readTerminalDockPaneUserUndocked('pane-1')).toBe(false)
    writeTerminalDockPaneAgent('pane-1', 'claude')
    expect(readTerminalDockPaneUserUndocked('pane-1')).toBe(false)
  })

  it('survives a later agent write', () => {
    writeTerminalDockPaneUserUndocked('pane-1', true)
    writeTerminalDockPaneAgent('pane-1', 'claude')
    expect(readTerminalDockPaneUserUndocked('pane-1')).toBe(true)
  })

  it('preserves the agent when the user decision is written', () => {
    writeTerminalDockPaneAgent('pane-1', 'claude')
    writeTerminalDockPaneUserUndocked('pane-1', true)
    expect(readTerminalDockPaneAgent('pane-1')).toBe('claude')
  })

  it('survives a later dock-state write', () => {
    writeTerminalDockPaneUserUndocked('pane-1', true)
    writeTerminalDockPaneState('pane-1', { docked: false, gutterRows: 8 })
    expect(readTerminalDockPaneUserUndocked('pane-1')).toBe(true)
  })

  it('preserves dock state when the user decision is written', () => {
    writeTerminalDockPaneState('pane-1', { docked: true, gutterRows: 8 })
    writeTerminalDockPaneUserUndocked('pane-1', true)
    expect(readTerminalDockPaneState('pane-1')).toEqual({
      docked: true,
      gutterRows: 8,
      userUndocked: true
    })
  })
})

describe('terminal dock pane agent latch', () => {
  it('returns null when nothing has been recorded for the pane', () => {
    expect(readTerminalDockPaneAgent('pane-1')).toBeNull()
  })

  it('round-trips a recognized TUI agent through localStorage', () => {
    writeTerminalDockPaneAgent('pane-1', 'claude')
    expect(readTerminalDockPaneAgent('pane-1')).toBe('claude')
  })

  it('ignores a persisted value outside the known TUI-agent set', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'pane-1': { docked: true, gutterRows: 5, lastAgent: 'not-a-real-agent' } })
    )
    expect(readTerminalDockPaneAgent('pane-1')).toBeNull()
  })

  it('rejects unsafe keys', () => {
    writeTerminalDockPaneAgent('__proto__', 'claude')
    expect(readTerminalDockPaneAgent('__proto__')).toBeNull()
  })

  it('does not appear in the docked/gutterRows read, even once recorded', () => {
    writeTerminalDockPaneAgent('pane-1', 'claude')
    expect(readTerminalDockPaneState('pane-1')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
  })

  it('survives a later docked/gutterRows write for the same pane', () => {
    writeTerminalDockPaneAgent('pane-1', 'claude')
    writeTerminalDockPaneState('pane-1', { docked: true, gutterRows: 8 })
    expect(readTerminalDockPaneAgent('pane-1')).toBe('claude')
    expect(readTerminalDockPaneState('pane-1')).toEqual({ docked: true, gutterRows: 8 })
  })

  it('is cleared when the pane entry is pruned on retirement', () => {
    writeTerminalDockPaneAgent('pane-1', 'claude')
    removeTerminalDockPaneKeys(new Set(['pane-1']))
    expect(readTerminalDockPaneAgent('pane-1')).toBeNull()
  })
})

describe('removeTerminalDockPaneKeys', () => {
  it('prunes entries for panes that no longer exist', () => {
    writeTerminalDockPaneState('pane-1', { docked: true, gutterRows: 6 })
    writeTerminalDockPaneState('pane-2', { docked: true, gutterRows: 7 })
    writeTerminalDockPaneState('pane-3', { docked: true, gutterRows: 8 })

    removeTerminalDockPaneKeys(new Set(['pane-1', 'pane-3']))

    expect(readTerminalDockPaneState('pane-1')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
    expect(readTerminalDockPaneState('pane-2')).toEqual({ docked: true, gutterRows: 7 })
    expect(readTerminalDockPaneState('pane-3')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
  })

  it('is a no-op for keys that are not present', () => {
    writeTerminalDockPaneState('pane-1', { docked: true, gutterRows: 6 })
    removeTerminalDockPaneKeys(new Set(['pane-does-not-exist']))
    expect(readTerminalDockPaneState('pane-1')).toEqual({ docked: true, gutterRows: 6 })
  })
})

describe('rekeyTerminalDockPaneKeys', () => {
  it('moves entries under the old tab id to the new tab id, preserving leaf ids and values', () => {
    writeTerminalDockPaneState('provisional-1:leaf-a', { docked: true, gutterRows: 6 })
    writeTerminalDockPaneState('provisional-1:leaf-b', { docked: false, gutterRows: 8 })
    writeTerminalDockPaneState('other-tab:leaf-c', { docked: true, gutterRows: 4 })

    rekeyTerminalDockPaneKeys('provisional-1', 'web-terminal-host-1')

    expect(hasStoredPaneEntry('provisional-1:leaf-a')).toBe(false)
    expect(hasStoredPaneEntry('provisional-1:leaf-b')).toBe(false)
    expect(readTerminalDockPaneState('web-terminal-host-1:leaf-a')).toEqual({
      docked: true,
      gutterRows: 6
    })
    expect(readTerminalDockPaneState('web-terminal-host-1:leaf-b')).toEqual({
      docked: false,
      gutterRows: 8
    })
    expect(readTerminalDockPaneState('other-tab:leaf-c')).toEqual({ docked: true, gutterRows: 4 })
  })

  it('keeps the pre-existing target entry on collision and drops the source (target wins)', () => {
    writeTerminalDockPaneState('provisional-1:leaf-a', { docked: true, gutterRows: 6 })
    writeTerminalDockPaneState('web-terminal-host-1:leaf-a', { docked: false, gutterRows: 9 })

    rekeyTerminalDockPaneKeys('provisional-1', 'web-terminal-host-1')

    expect(hasStoredPaneEntry('provisional-1:leaf-a')).toBe(false)
    expect(readTerminalDockPaneState('web-terminal-host-1:leaf-a')).toEqual({
      docked: false,
      gutterRows: 9
    })
  })

  it('is a no-op when there is nothing under the old tab id', () => {
    writeTerminalDockPaneState('other-tab:leaf-c', { docked: true, gutterRows: 4 })
    rekeyTerminalDockPaneKeys('provisional-1', 'web-terminal-host-1')
    expect(readTerminalDockPaneState('other-tab:leaf-c')).toEqual({ docked: true, gutterRows: 4 })
    expect(hasStoredPaneEntry('web-terminal-host-1:leaf-c')).toBe(false)
  })

  it('rejects unsafe tab ids', () => {
    writeTerminalDockPaneState('__proto__:leaf-a', { docked: true, gutterRows: 6 })
    rekeyTerminalDockPaneKeys('__proto__', 'web-terminal-host-1')
    rekeyTerminalDockPaneKeys('provisional-1', '__proto__')
    expect(hasStoredPaneEntry('web-terminal-host-1:leaf-a')).toBe(false)
  })
})

describe('writeTerminalDockPaneState bound', () => {
  it.each([
    ['evicts the oldest entry once the cap is exceeded', false, 'pane-0', 'pane-1'],
    ['keeps a rewritten live pane and evicts the oldest untouched key', true, 'pane-1', 'pane-0']
  ])('%s', (_, refreshOldest, evictedKey, retainedKey) => {
    for (let i = 0; i < MAX_STORED_PANE_ENTRIES; i++) {
      writeTerminalDockPaneState(`pane-${i}`, { docked: true, gutterRows: 5 })
    }
    if (refreshOldest) {
      writeTerminalDockPaneState('pane-0', { docked: false, gutterRows: 6 })
    }
    writeTerminalDockPaneState('pane-overflow', { docked: true, gutterRows: 5 })

    expect(hasStoredPaneEntry(evictedKey)).toBe(false)
    expect(hasStoredPaneEntry(retainedKey)).toBe(true)
    expect(hasStoredPaneEntry('pane-overflow')).toBe(true)
    const raw = window.localStorage.getItem(STORAGE_KEY)
    expect(Object.keys(JSON.parse(raw as string))).toHaveLength(MAX_STORED_PANE_ENTRIES)
  })

  it('moves a rewritten key to the newest position instead of leaving it at its original spot', () => {
    writeTerminalDockPaneState('pane-a', { docked: true, gutterRows: 5 })
    writeTerminalDockPaneState('pane-b', { docked: true, gutterRows: 5 })
    writeTerminalDockPaneState('pane-a', { docked: false, gutterRows: 6 })

    const raw = window.localStorage.getItem(STORAGE_KEY)
    expect(Object.keys(JSON.parse(raw as string))).toEqual(['pane-b', 'pane-a'])
  })
})
