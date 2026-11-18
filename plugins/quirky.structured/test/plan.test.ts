import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AskEnvelope } from '@quirky/protocol'
import { planDecision, planSpec, planText } from '../plan'

let root: string
let plans: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-text-')))
  plans = join(root, 'plans')
  mkdirSync(plans)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('planText', () => {
  test('reads the plan file inside the plans directory and reports its checked path', () => {
    const file = join(plans, 'a.md')
    writeFileSync(file, '# Plan\n- step')
    expect(planText({ planFilePath: file, plan: 'older text' }, null, plans)).toEqual({ text: '# Plan\n- step', filePath: file, empty: false })
  })

  test('falls back to the input plan when there is no usable file', () => {
    expect(planText({ plan: 'from input' }, null, plans)).toEqual({ text: 'from input', empty: false })
    expect(planText({ planFilePath: join(plans, 'missing.md'), plan: 'from input' }, null, plans)).toEqual({ text: 'from input', empty: false })
    expect(planText({ planFilePath: 42, plan: 'from input' }, null, plans)).toEqual({ text: 'from input', empty: false })
  })

  test('a file equal to the previous plan yields to a different input plan', () => {
    const file = join(plans, 'a.md')
    writeFileSync(file, 'old plan')
    expect(planText({ planFilePath: file, plan: 'new plan' }, 'old plan', plans)).toEqual({ text: 'new plan', filePath: file, empty: false })
  })

  test('a file equal to the previous plan stays when the input plan is empty or the same', () => {
    const file = join(plans, 'a.md')
    writeFileSync(file, 'old plan')
    for (const plan of [undefined, '', '  ', 'old plan', 7]) {
      expect(planText({ planFilePath: file, plan }, 'old plan', plans)).toEqual({ text: 'old plan', filePath: file, empty: false })
    }
  })

  test('empty file and empty input plan is an empty plan', () => {
    const file = join(plans, 'a.md')
    writeFileSync(file, '  \n')
    expect(planText({ planFilePath: file, plan: '' }, null, plans)).toEqual({ text: '', filePath: file, empty: true })
    expect(planText({}, null, plans)).toEqual({ text: '', empty: true })
    expect(planText(undefined, null, plans)).toEqual({ text: '', empty: true })
  })

  test('a path outside the plans directory is ignored and sets no filePath', () => {
    const outside = join(root, 'secret.md')
    writeFileSync(outside, 'secret')
    expect(planText({ planFilePath: outside, plan: 'safe' }, null, plans)).toEqual({ text: 'safe', empty: false })
  })

  test('a sibling directory that only shares the name prefix is outside', () => {
    const sibling = join(root, 'plans-extra')
    mkdirSync(sibling)
    writeFileSync(join(sibling, 'a.md'), 'sibling')
    expect(planText({ planFilePath: join(sibling, 'a.md'), plan: 'safe' }, null, plans)).toEqual({ text: 'safe', empty: false })
  })

  test('a symlink that escapes the plans directory is ignored', () => {
    const outside = join(root, 'secret.md')
    writeFileSync(outside, 'secret')
    const link = join(plans, 'link.md')
    symlinkSync(outside, link)
    expect(planText({ planFilePath: link, plan: 'safe' }, null, plans)).toEqual({ text: 'safe', empty: false })
  })

  test('a directory and a file over 1 MiB are ignored', () => {
    mkdirSync(join(plans, 'dir'))
    expect(planText({ planFilePath: join(plans, 'dir'), plan: 'safe' }, null, plans)).toEqual({ text: 'safe', empty: false })
    const big = join(plans, 'big.md')
    writeFileSync(big, 'x'.repeat(1024 * 1024 + 1))
    expect(planText({ planFilePath: big, plan: 'safe' }, null, plans)).toEqual({ text: 'safe', empty: false })
  })

  test('with no plans directory the file is never read', () => {
    const file = join(plans, 'a.md')
    writeFileSync(file, 'file text')
    expect(planText({ planFilePath: file, plan: 'input' }, null, null)).toEqual({ text: 'input', empty: false })
  })
})

describe('planSpec', () => {
  test('offers the three exits and an optional reason', () => {
    const [decision, reason] = planSpec().questions as any[]
    expect(decision).toMatchObject({ id: 'decision', type: 'select', required: true })
    expect(decision.options.map((option: any) => [option.value, option.label])).toEqual([
      ['approve-auto', 'Approve, auto mode'],
      ['approve-review', 'Approve, review edits'],
      ['keep', 'Keep planning']
    ])
    expect(reason).toMatchObject({ id: 'reason', type: 'text', required: false })
  })
})

describe('planDecision', () => {
  const answered = (status: 'answered' | 'partial', decision?: unknown, reason?: string): AskEnvelope => ({
    status,
    askId: 'a_1',
    answers: {
      ...(decision === undefined ? {} : { decision: { value: decision as string, source: 'option' as const } }),
      ...(reason === undefined ? {} : { reason: { value: reason, source: 'input' as const } })
    },
    skipped: [],
    summary: ''
  })

  test('the two approve exits map to their targets', () => {
    expect(planDecision(answered('answered', 'approve-auto'))).toEqual({ decision: 'approve-auto' })
    expect(planDecision(answered('answered', 'approve-review'))).toEqual({ decision: 'approve-review' })
    expect(planDecision(answered('partial', 'approve-auto'))).toEqual({ decision: 'approve-auto' })
  })

  test('keep carries the trimmed reason, empty when none', () => {
    expect(planDecision(answered('answered', 'keep', '  Split step 2 '))).toEqual({ decision: 'keep', message: 'Split step 2' })
    expect(planDecision(answered('answered', 'keep'))).toEqual({ decision: 'keep', message: '' })
  })

  test('anything else fails closed as stopped', () => {
    expect(planDecision(null)).toEqual({ decision: 'stopped' })
    expect(planDecision(answered('answered'))).toEqual({ decision: 'stopped' })
    expect(planDecision(answered('partial'))).toEqual({ decision: 'stopped' })
    expect(planDecision(answered('answered', 'allow'))).toEqual({ decision: 'stopped' })
    expect(planDecision(answered('answered', 7))).toEqual({ decision: 'stopped' })
    for (const status of ['declined', 'timed_out', 'cancelled', 'pending'] as const) {
      expect(planDecision({ ...answered('answered', 'approve-auto'), status } as unknown as AskEnvelope)).toEqual({ decision: 'stopped' })
    }
    expect(planDecision({ status: 'unavailable', reason: 'no ui' } as unknown as AskEnvelope)).toEqual({ decision: 'stopped' })
  })
})
