import { PLUGIN_API_VERSION } from '@quirky/protocol'
import { describe, expect, test } from 'bun:test'
import { checkKindEntry } from '../../src/plugins/kinds'
import { parseManifest } from '../../src/plugins/manifest'

const base = { id: 'acme', name: 'Acme', version: '1.0.0', apiVersion: PLUGIN_API_VERSION }

function result(manifest: Record<string, unknown>) {
  return parseManifest(JSON.stringify({ ...base, ...manifest }), {
    dirName: 'acme',
    dir: '/plugins/acme',
    source: 'installed',
  })
}

function errorsOf(manifest: Record<string, unknown>): string[] {
  const parsed = result(manifest)
  if (parsed.ok) throw new Error('expected the manifest to be rejected')
  return parsed.errors
}

const contributes = (kind: string, entry: Record<string, unknown>) => ({ contributes: { [kind]: [entry] } })

describe('job entries', () => {
  test('accepts a full entry, with initialDelay 0s', () => {
    expect(
      result(contributes('job', { id: 'tick', description: 'd', interval: '30s', initialDelay: '0s', timeout: '5m' })).ok,
    ).toBe(true)
  })

  test('requires an interval', () => {
    expect(errorsOf(contributes('job', { id: 'tick' }))).toEqual(['job tick: interval is required'])
  })

  test('rejects a duration that is not a string or does not parse', () => {
    expect(errorsOf(contributes('job', { id: 'tick', interval: 30 }))).toEqual([
      'job tick: interval must be a duration such as 30s, 5m or 2h',
    ])
    expect(errorsOf(contributes('job', { id: 'tick', interval: 'soon' }))).toEqual([
      'job tick: interval must be a duration such as 30s, 5m or 2h',
    ])
    expect(errorsOf(contributes('job', { id: 'tick', interval: '1m', initialDelay: 'later' }))).toEqual([
      'job tick: initialDelay must be a duration such as 30s, 5m or 2h',
    ])
    expect(errorsOf(contributes('job', { id: 'tick', interval: '1m', timeout: {} }))).toEqual([
      'job tick: timeout must be a duration such as 30s, 5m or 2h',
    ])
  })

  test('rejects an interval outside 1s to 24h', () => {
    const message = ['job tick: interval must be between 1s and 24h']
    expect(errorsOf(contributes('job', { id: 'tick', interval: '500ms' }))).toEqual(message)
    expect(errorsOf(contributes('job', { id: 'tick', interval: '2d' }))).toEqual(message)
    expect(result(contributes('job', { id: 'tick', interval: '1s' })).ok).toBe(true)
    expect(result(contributes('job', { id: 'tick', interval: '24h' })).ok).toBe(true)
  })

  test('rejects an initialDelay above 24h', () => {
    expect(errorsOf(contributes('job', { id: 'tick', interval: '1m', initialDelay: '2d' }))).toEqual([
      'job tick: initialDelay must be between 0s and 24h',
    ])
  })

  test('rejects a timeout outside 1s to 24h', () => {
    const message = ['job tick: timeout must be between 1s and 24h']
    expect(errorsOf(contributes('job', { id: 'tick', interval: '1m', timeout: '500ms' }))).toEqual(message)
    expect(errorsOf(contributes('job', { id: 'tick', interval: '1m', timeout: '2d' }))).toEqual(message)
  })

  test('rejects unknown fields and a non-string description', () => {
    expect(errorsOf(contributes('job', { id: 'tick', interval: '1m', every: '1m', description: 3 }))).toEqual([
      'job tick: unknown field `every`',
      'job tick: description must be a string',
    ])
  })
})

describe('launch-hook entries', () => {
  test('accepts a list of agent names', () => {
    expect(result(contributes('launch-hook', { id: 'env', agents: ['claude', 'codex'] })).ok).toBe(true)
    expect(result(contributes('launch-hook', { id: 'env' })).ok).toBe(true)
  })

  test.each([['claude'], [[]], [['']], [[1]]])('rejects agents %p', (agents) => {
    expect(errorsOf(contributes('launch-hook', { id: 'env', agents }))).toEqual([
      'launch-hook env: agents must be a list of agent names',
    ])
  })
})

describe('method and event entries', () => {
  test('rejects a field other than description', () => {
    expect(errorsOf(contributes('method', { id: 'go', handler: 'x' }))).toEqual(['method go: unknown field `handler`'])
    expect(errorsOf(contributes('event', { id: 'changed', handler: 'x' }))).toEqual([
      'event changed: unknown field `handler`',
    ])
  })

  test('rejects a non-string description', () => {
    expect(errorsOf(contributes('event', { id: 'changed', description: 1 }))).toEqual([
      'event changed: description must be a string',
    ])
    expect(result(contributes('method', { id: 'go', description: 'd' })).ok).toBe(true)
  })
})

describe('overrides and other kinds', () => {
  test('checks an override against its parsed kind, labelled with the full id', () => {
    expect(errorsOf({ overrides: [{ id: 'job:acme.poll/tick', interval: '2d' }] })).toEqual([
      'override job:acme.poll/tick: interval must be between 1s and 24h',
    ])
  })

  test('accepts a valid job override', () => {
    expect(result({ overrides: [{ id: 'job:acme.poll/tick', interval: '5m' }] }).ok).toBe(true)
  })

  test('checks a command entry against the UI rules, rejecting arbitrary fields', () => {
    expect(errorsOf(contributes('command', { id: 'hello', title: 'Hello', anything: [1, 2], interval: 'soon' }))).toEqual([
      'command hello: unknown field `anything`',
      'command hello: unknown field `interval`',
    ])
  })

  test('leaves an entry of a kind with no checker alone', () => {
    expect(result(contributes('widget', { id: 'hello', title: 1, anything: [1, 2], interval: 'soon' })).ok).toBe(true)
  })
})

describe('kinds the daemon does not own', () => {
  const inherited = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']

  test.each(inherited)('checkKindEntry leaves %s untouched', (kind) => {
    const errors: string[] = []
    expect(() => checkKindEntry(kind, `${kind} go`, { id: 'go', description: 1, anything: true }, errors)).not.toThrow()
    expect(errors).toEqual([])
  })

  test('a constructor contribution parses with extra fields', () => {
    expect(result(contributes('constructor', { id: 'go', description: 'x', anything: 1 })).ok).toBe(true)
  })
})
