import { describe, expect, it } from 'vitest'
import { buildRpcList } from './rpc-command'

describe('buildRpcList', () => {
  const entries = buildRpcList()
  const byMethod = new Map(entries.map((entry) => [entry.method, entry]))

  it('names concrete methods and never a namespace wildcard', () => {
    expect(entries.filter((entry) => entry.method.includes('*'))).toEqual([])
    expect(byMethod.get('browser.snapshot')).toMatchObject({ class: 'legacy-cli' })
  })

  it('lists each method once with its tier and stability', () => {
    expect(new Set(entries.map((entry) => entry.method)).size).toBe(entries.length)
    expect(byMethod.get('ui.state')).toEqual({
      method: 'ui.state',
      class: 'public',
      stability: 'stable'
    })
    expect(byMethod.get('ui.get')).toMatchObject({ class: 'internal', stability: null })
    expect(byMethod.get('plugins.list')).toMatchObject({ class: 'unstable', stability: 'unstable' })
  })

  it('includes layout apply regardless of the build', () => {
    expect(byMethod.get('layout.apply')).toMatchObject({ class: 'public', stability: 'unstable' })
  })

  it('is sorted by method name', () => {
    const names = entries.map((entry) => entry.method)
    expect(names).toEqual(names.toSorted((a, b) => a.localeCompare(b)))
  })
})
