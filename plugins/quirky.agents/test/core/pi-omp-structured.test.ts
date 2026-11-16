import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateEntry } from '../../src/core/entry'
import { resolveLaunch } from '../../src/core/resolve'
import type { AgentEntry, ValidSelection } from '../../src/core/types'

const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../../quirky-plugin.json'), 'utf8')) as {
  contributes: { agent: ({ id: string } & Record<string, unknown>)[] }
}

function entryFor(id: string): AgentEntry {
  const data = manifest.contributes.agent.find((agent) => agent.id === id)
  if (!data) throw new Error(`no ${id} agent in the manifest`)
  const { id: _id, ...rest } = data
  const result = validateEntry('quirky.agents', id, rest)
  if (!result.ok) throw new Error(result.error)
  return result.entry
}

const pick = (model: string, values: Record<string, string | boolean> = {}): ValidSelection => ({
  model,
  values: Object.assign(Object.create(null), values),
  listed: false
})

const structured = (entry: AgentEntry, selection: ValidSelection) =>
  resolveLaunch({ entry, commandTokens: [], configuredArgs: [], selection, extras: null, structured: true }).structured

describe('pi and omp structured launches', () => {
  test('pi takes a model and a thinking level as structured options', () => {
    expect(structured(entryFor('pi'), pick('anthropic/sonnet', { effort: 'high' }))).toEqual({ model: 'anthropic/sonnet', effort: 'high' })
  })

  test('omp takes a model as a structured option', () => {
    expect(structured(entryFor('omp'), pick('anthropic/sonnet'))).toEqual({ model: 'anthropic/sonnet' })
  })
})
