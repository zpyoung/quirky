import { expect, test } from 'bun:test'
import manifest from '../../quirky-plugin.json'
import { validateEntry } from '../../src/core/entry'
import { parseExtraArgs } from '../../src/core/extras'
import { resolveLaunch } from '../../src/core/resolve'
import { validateSelection } from '../../src/core/selection'

function agent(id: string) {
  const declaration = manifest.contributes.agent.find((entry) => entry.id === id)
  if (!declaration) throw new Error(`missing built-in agent ${id}`)
  const { id: _id, ...data } = declaration
  const result = validateEntry('quirky.agents', id, data)
  if (!result.ok) throw new Error(result.error)
  return result.entry
}

test('option-only terminal picks preserve the native model and explicit effort provenance', () => {
  const entry = agent('claude')
  const selection = validateSelection(entry, { options: { effort: 'high' } })
  const resolved = resolveLaunch({ entry, selection, extras: null, configuredArgs: ['--model', 'sonnet', '--effort', 'low'], commandTokens: [], structured: false })
  expect(resolved.args).toEqual(['--model', 'sonnet', '--effort', 'high'])
  expect(resolved.added).toEqual(['--effort', 'high'])
  expect(resolved.launchSettings?.options.effort).toEqual({ value: 'high', source: 'explicit' })
  expect(resolved.launchSettings?.options).not.toHaveProperty('model')
  expect(resolved.structured).toEqual({ effort: 'high' })
})

test('option-only structured picks never invent a model', () => {
  const entry = agent('claude')
  const selection = validateSelection(entry, { options: { effort: 'high' } })
  const resolved = resolveLaunch({ entry, selection, extras: null, configuredArgs: [], commandTokens: [], structured: true })
  expect(resolved.structured).toEqual({ effort: 'high' })
  expect(resolved.launchSettings?.options.effort).toEqual({ value: 'high', source: 'explicit' })
  expect(resolved.launchSettings?.options).not.toHaveProperty('model')
})

test('raw model does not erase a generic option-only pick, while raw effort supersedes it once', () => {
  const entry = agent('claude')
  const selection = validateSelection(entry, { options: { effort: 'high' } })
  const resolve = (extraArgs: string) => resolveLaunch({ entry, selection, extras: parseExtraArgs(entry, extraArgs), configuredArgs: [], commandTokens: [], structured: false })
  const modelOverride = resolve('--model opus')
  expect(modelOverride.args).toEqual(['--model', 'opus', '--effort', 'high'])
  expect(modelOverride.launchSettings?.options.effort).toEqual({ value: 'high', source: 'explicit' })
  const effortOverride = resolve('--effort low')
  expect(effortOverride.args).toEqual(['--effort', 'low'])
  expect(effortOverride.launchSettings?.options.effort).toEqual({ source: 'extra-args' })
})

test('option-only picks still reject unsupported, composed-only, or malformed choices', () => {
  expect(() => validateSelection(agent('cursor'), { options: { thinking: true } })).toThrow()
  expect(() => validateSelection(agent('claude'), { options: { effort: 'invented' } })).toThrow()
  expect(() => validateSelection(agent('aider'), { options: { effort: 'high' } })).toThrow()
})
