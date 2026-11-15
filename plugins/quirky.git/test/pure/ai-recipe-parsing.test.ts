import { describe, expect, test } from 'bun:test'
import type { DaemonEnv } from '../../src/daemon/env'
import { parseLaunchOptions, setAiRecipe } from '../../src/daemon/ai-recipes'

function env(): DaemonEnv {
  const context = {
    error: (kind: string, message: string) => Object.assign(new Error(message), { kind })
  }
  const errors = {
    reasoned: (kind: string, reason: string, message: string) => Object.assign(new Error(message), { kind, data: { reason } })
  }
  return { context, errors, resolve: async () => ({ repoId: 'repo' }) } as unknown as DaemonEnv
}

async function expectInvalidOptions(value: unknown, message: string): Promise<void> {
  try {
    parseLaunchOptions(env(), value)
  } catch (error) {
    expect(error).toMatchObject({ message, data: { reason: 'invalid-launch-options' } })
    return
  }
  throw new Error('expected launch options to be invalid')
}

describe('parseLaunchOptions', () => {
  test('trims the model and preserves option order in a null-prototype object', () => {
    const parsed = parseLaunchOptions(env(), { model: ' opus ', optionValues: { effort: 'high', fast: true } })!
    expect(parsed).toEqual({ model: 'opus', optionValues: { effort: 'high', fast: true } })
    expect(Object.keys(parsed.optionValues!)).toEqual(['effort', 'fast'])
    expect(Object.getPrototypeOf(parsed.optionValues)).toBeNull()
  })

  test('accepts an empty optionValues object without storing it', () => {
    expect(parseLaunchOptions(env(), { optionValues: {} })).toEqual({})
  })

  test('rejects more than sixteen entries with the existing error', async () => {
    const optionValues = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`option${index}`, 'x']))
    await expectInvalidOptions(
      { optionValues },
      'launchOptions.optionValues accepts at most 16 entries.'
    )
  })

  test('rejects reserved and overlong option IDs with the existing error', async () => {
    for (const id of ['x'.repeat(65), 'model', '__proto__', 'constructor', 'prototype']) {
      await expectInvalidOptions(
        { optionValues: Object.fromEntries([[id, 'x']]) },
        `launchOptions.optionValues has an invalid option ID: ${id}.`
      )
    }
  })

  test('rejects non-string values at the first invalid entry in input order', async () => {
    await expectInvalidOptions(
      { optionValues: { first: 1, constructor: 'x' } },
      'launchOptions.optionValues.first must be a string or boolean.'
    )
    await expectInvalidOptions(
      { optionValues: { effort: 3 } },
      'launchOptions.optionValues.effort must be a string or boolean.'
    )
  })
})

describe('setAiRecipe text fields', () => {
  async function expectFieldError(fields: Record<string, unknown>, message: string): Promise<void> {
    const handler = setAiRecipe(env())
    await expect(handler({ action: 'commitMessage', scope: 'global', ...fields }, undefined as never)).rejects.toMatchObject({ message })
  }

  test('validates fields in agent, args, template order with unchanged errors', async () => {
    await expectFieldError(
      { agent: 1, args: 2, template: 3 },
      'agent must be a string or null.'
    )
    await expectFieldError(
      { args: 2, template: 3 },
      'args must be a string or null.'
    )
    await expectFieldError(
      { template: 3 },
      'template must be a string or null.'
    )
  })
})
