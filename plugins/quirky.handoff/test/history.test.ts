import { describe, expect, test } from 'bun:test'
import { PathHistory } from '../src/daemon/history'

describe('PathHistory', () => {
  test('returns nothing for an unknown session', () => {
    expect(new PathHistory().get('s_none')).toEqual([])
  })

  test('lists a session paths newest first', () => {
    const history = new PathHistory()
    history.record('s_1', '/a.jsonl')
    history.record('s_1', '/b.jsonl')
    expect(history.get('s_1')).toEqual(['/b.jsonl', '/a.jsonl'])
  })

  test('keeps a repeated path once, moved to the front', () => {
    const history = new PathHistory()
    history.record('s_1', '/a.jsonl')
    history.record('s_1', '/b.jsonl')
    history.record('s_1', '/a.jsonl')
    expect(history.get('s_1')).toEqual(['/a.jsonl', '/b.jsonl'])
  })

  test('keeps at most 5 distinct paths per session, dropping the oldest', () => {
    const history = new PathHistory()
    for (let i = 1; i <= 7; i++) history.record('s_1', `/${i}.jsonl`)
    expect(history.get('s_1')).toEqual(['/7.jsonl', '/6.jsonl', '/5.jsonl', '/4.jsonl', '/3.jsonl'])
  })

  test('ignores an empty path', () => {
    const history = new PathHistory()
    history.record('s_1', '')
    expect(history.get('s_1')).toEqual([])
  })

  test('keeps sessions apart', () => {
    const history = new PathHistory()
    history.record('s_1', '/a.jsonl')
    history.record('s_2', '/b.jsonl')
    expect(history.get('s_1')).toEqual(['/a.jsonl'])
    expect(history.get('s_2')).toEqual(['/b.jsonl'])
  })

  test('evicts the least recently updated session beyond 256', () => {
    const history = new PathHistory()
    for (let i = 0; i < 256; i++) history.record(`s_${i}`, `/${i}.jsonl`)
    history.record('s_0', '/0b.jsonl')
    history.record('s_new', '/new.jsonl')
    expect(history.get('s_1')).toEqual([])
    expect(history.get('s_0')).toEqual(['/0b.jsonl', '/0.jsonl'])
    expect(history.get('s_2')).toEqual(['/2.jsonl'])
    expect(history.get('s_new')).toEqual(['/new.jsonl'])
  })

  test('reading a session does not refresh it', () => {
    const history = new PathHistory()
    for (let i = 0; i < 256; i++) history.record(`s_${i}`, `/${i}.jsonl`)
    history.get('s_0')
    history.record('s_new', '/new.jsonl')
    expect(history.get('s_0')).toEqual([])
  })

  test('returns a copy the caller can change', () => {
    const history = new PathHistory()
    history.record('s_1', '/a.jsonl')
    history.get('s_1').push('/x.jsonl')
    expect(history.get('s_1')).toEqual(['/a.jsonl'])
  })
})
