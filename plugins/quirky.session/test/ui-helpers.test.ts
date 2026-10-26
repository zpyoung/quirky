import { expect, test } from 'bun:test'
import type { StructuredMessage } from '@quirky/protocol'
import { pickActive } from '../src/window/model'
import { sessionForDigit } from '../src/window/shortcuts'
import { displayStatus } from '../src/window/status'
import { terminalColors } from '../src/window/terminalTheme'
import { mergeMessages } from '../src/window/transcript'
import { session } from './ui-fake'

test('terminalColors reads the three tokens and falls back per color', () => {
  expect(terminalColors({})).toEqual({ background: '#16181d', foreground: '#d7dae0', cursor: '#d7dae0' })
  expect(terminalColors({ '--terminal-background': '#fff', '--terminal-cursor': '#000' })).toEqual({
    background: '#fff',
    foreground: '#d7dae0',
    cursor: '#000'
  })
})

test('a blank custom property counts as unset', () => {
  expect(terminalColors({ '--terminal-background': '  ' }).background).toBe('#16181d')
  expect(terminalColors({ '--terminal-foreground': ' #abc ' }).foreground).toBe('#abc')
})

test('Cmd+digit picks the session at that position and nothing else', () => {
  const sessions = ['a', 'b', 'c']
  expect(sessionForDigit(sessions, '1')).toBe('a')
  expect(sessionForDigit(sessions, '3')).toBe('c')
  expect(sessionForDigit(sessions, '4')).toBeUndefined()
  expect(sessionForDigit(sessions, '0')).toBeUndefined()
  expect(sessionForDigit(sessions, 'a')).toBeUndefined()
})

test('a starting session displays as running', () => {
  expect(displayStatus('starting')).toBe('running')
  expect(displayStatus('waiting')).toBe('waiting')
})

test('the active tab is the requested session, else the remembered one, else the first', () => {
  const sessions = [session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' })]
  expect(pickActive(sessions, 'c', 'b')?.id).toBe('c')
  expect(pickActive(sessions, undefined, 'b')?.id).toBe('b')
  expect(pickActive(sessions, 'gone', 'also-gone')?.id).toBe('a')
  expect(pickActive([], 'a', 'b')).toBeNull()
})

const message = (seq: number, text: string): StructuredMessage => ({ sessionId: 's', seq, role: 'assistant', text, at: 0 })

test('merging messages keeps one per seq, the incoming one, in order', () => {
  const merged = mergeMessages([message(1, 'a'), message(3, 'c')], [message(2, 'b'), message(3, 'c2')])
  expect(merged.map((m) => [m.seq, m.text])).toEqual([
    [1, 'a'],
    [2, 'b'],
    [3, 'c2']
  ])
})
