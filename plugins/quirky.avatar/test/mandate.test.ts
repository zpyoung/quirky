import { describe, expect, test } from 'bun:test'
import type { AvatarSettings } from '../src/contracts'
import { applyMandatePatch, inferDoneWhenKind, normalizeHandoffInput } from '../src/mandate'
import { sampleMandate } from './support'

const settings: AvatarSettings = {
  defaultLevel: 'own-branch',
  switches: { messaging: true, historyRewrite: false, deploys: false },
  houseRules: [],
  allowCommands: [],
  denyCommands: [],
  deployCommands: [],
  brainAgent: 'claude',
  brainModel: null,
  judgmentTimeoutSeconds: 55
}

const raw = { worktreeId: 'wt-1', goal: 'Fix the build', doneWhen: 'bun test passes' }

function value(input: unknown) {
  const result = normalizeHandoffInput(input, settings)
  if (!result.ok) throw new Error(result.error)
  return result.value
}

describe('normalizeHandoffInput', () => {
  test('fills level and switches from settings and trims guidelines', () => {
    const normalized = value({ ...raw, guidelines: ['  keep commits small ', '', '   '] })
    expect(normalized).toMatchObject({
      worktreeId: 'wt-1',
      goal: 'Fix the build',
      level: 'own-branch',
      switches: { messaging: true, historyRewrite: false, deploys: false },
      guidelines: ['keep commits small'],
      agent: null,
      notes: '',
      allowSplit: false
    })
    expect(normalized.sharedGoal).toBeUndefined()
  })

  test('explicit level and switches override the settings per field', () => {
    const normalized = value({ ...raw, level: 'shadow', switches: { messaging: false, deploys: true } })
    expect(normalized.level).toBe('shadow')
    expect(normalized.switches).toEqual({ messaging: false, historyRewrite: false, deploys: true })
  })

  test('trims goal and doneWhen and rejects blank ones', () => {
    expect(value({ ...raw, goal: '  Fix it  ', doneWhen: '  done  ' })).toMatchObject({ goal: 'Fix it', doneWhen: 'done' })
    for (const [field, bad] of [['goal', '  '], ['doneWhen', ''], ['goal', 3], ['worktreeId', undefined], ['level', 'wild'], ['guidelines', 'x'], ['switches', { messaging: 'yes' }], ['switches', { teleport: true }]] as const) {
      expect(normalizeHandoffInput({ ...raw, [field]: bad }, settings)).toEqual({ ok: false, error: `invalid: ${field}` })
    }
    expect(normalizeHandoffInput('nope', settings)).toEqual({ ok: false, error: 'invalid: item' })
  })

  test('keeps a shared goal and an agent, and drops blanks', () => {
    expect(value({ ...raw, agent: ' codex ', sharedGoal: { goal: ' ship it ', id: 'sg-1' } })).toMatchObject({ agent: 'codex', sharedGoal: { id: 'sg-1', goal: 'ship it' } })
    expect(value({ ...raw, agent: '   ' }).agent).toBeNull()
    expect(normalizeHandoffInput({ ...raw, sharedGoal: { goal: '' } }, settings)).toEqual({ ok: false, error: 'invalid: sharedGoal' })
  })

  test('an explicit doneWhenKind wins over the inferred one', () => {
    expect(value({ ...raw, doneWhen: 'bun test', doneWhenKind: 'prose' }).doneWhenKind).toBe('prose')
    expect(value({ ...raw, doneWhenKind: 'command' }).doneWhenKind).toBe('command')
  })
})

describe('inferDoneWhenKind', () => {
  // rule: one line whose first word (after VAR=value prefixes) is a known tool or a path, and whose second word is not an English filler word
  test.each(['bun test', 'bunx tsc --noEmit -p tsconfig.json', 'pnpm run lint && pnpm test', 'CI=1 npm test', './scripts/check.sh', 'pytest -q tests/', 'gh pr checks --watch', 'make build', 'cargo test'])(
    'command: %s',
    (text) => expect(inferDoneWhenKind(text)).toBe('command')
  )

  test.each(['PR checks green', 'make sure the tests pass', 'the login page works', 'test the login flow by hand.', 'go to the settings page and see it', 'bun\ntest', '', 'git is clean and the PR is merged'])(
    'prose: %j',
    (text) => expect(inferDoneWhenKind(text)).toBe('prose')
  )
})

describe('applyMandatePatch', () => {
  test('applies only goal, doneWhen, guidelines and notes, and refreshes doneWhenKind and updatedAt', () => {
    const before = sampleMandate({ level: 'shadow', doneWhen: 'all good', doneWhenKind: 'prose' })
    const result = applyMandatePatch(before, { goal: ' New goal ', doneWhen: 'bun test', guidelines: [' a ', ''], notes: 'n', level: 'full', switches: { messaging: true } } as never, 9_000)
    expect(result).toEqual({
      ok: true,
      value: { ...before, goal: 'New goal', doneWhen: 'bun test', doneWhenKind: 'command', guidelines: ['a'], notes: 'n', updatedAt: 9_000 }
    })
  })

  test('rejects an empty goal or a non-list guidelines value', () => {
    expect(applyMandatePatch(sampleMandate(), { goal: ' ' }, 1)).toEqual({ ok: false, error: 'invalid: goal' })
    expect(applyMandatePatch(sampleMandate(), { guidelines: 'x' } as never, 1)).toEqual({ ok: false, error: 'invalid: guidelines' })
    expect(applyMandatePatch(sampleMandate(), {}, 1)).toEqual({ ok: false, error: 'invalid: patch' })
  })
})
