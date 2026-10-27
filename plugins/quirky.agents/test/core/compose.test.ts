import { describe, expect, test } from 'bun:test'
import { COMPOSE_RULES } from '../../src/core/compose'

const cursor = COMPOSE_RULES.cursor

describe('COMPOSE_RULES.cursor', () => {
  test('auto is never suffixed', () => {
    expect(cursor('auto', { effort: 'high', fastMode: true, thinking: true })).toBe('auto')
  })

  test('claude models add -thinking, then the effort', () => {
    expect(cursor('claude-opus-4-8', { thinking: true, effort: 'high' })).toBe('claude-opus-4-8-thinking-high')
    expect(cursor('claude-opus-4-8', { thinking: false, effort: 'low' })).toBe('claude-opus-4-8-low')
    expect(cursor('claude-opus-4-8', { thinking: true })).toBe('claude-opus-4-8-thinking')
  })

  test('claude models ignore fast mode', () => {
    expect(cursor('claude-opus-4-8', { fastMode: true, effort: 'medium' })).toBe('claude-opus-4-8-medium')
  })

  test('other models add the effort, then -fast', () => {
    expect(cursor('gpt-5.3-codex', { effort: 'high', fastMode: true })).toBe('gpt-5.3-codex-high-fast')
    expect(cursor('gpt-5.3-codex', { effort: 'low', fastMode: false })).toBe('gpt-5.3-codex-low')
    expect(cursor('gpt-5.3-codex', { fastMode: true })).toBe('gpt-5.3-codex-fast')
  })

  test('other models ignore thinking', () => {
    expect(cursor('gpt-5.3-codex', { thinking: true })).toBe('gpt-5.3-codex')
  })

  test('only a string effort and a true boolean count', () => {
    expect(cursor('gpt-5.3-codex', { effort: true, fastMode: 'yes' })).toBe('gpt-5.3-codex')
    expect(cursor('claude-sonnet-4', { thinking: 'yes' })).toBe('claude-sonnet-4')
  })
})
