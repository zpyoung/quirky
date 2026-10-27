import { describe, expect, test } from 'bun:test'
import {
  agentBanner,
  agentLabelFallback,
  askBanner,
  bellBanner,
  cut,
  programBanner,
  statusWord,
  testBanner,
} from '../src/text'

const base = {
  repo: 'quirky' as string | null,
  worktree: 'fix-tests',
  agentLabel: 'Claude',
  state: 'done',
  outcome: null as string | null,
  interrupted: false,
  lastAssistantMessage: null as string | null,
  toolName: null as string | null,
  toolInput: null as string | null,
}

describe('cut', () => {
  test('collapses whitespace and trims', () => {
    expect(cut('  a \n\n b\t c  ', 50)).toBe('a b c')
  })

  test('leaves text at the limit alone', () => {
    expect(cut('abcde', 5)).toBe('abcde')
  })

  test('cuts with an ellipsis within the limit', () => {
    const out = cut('abcdefghij', 5)
    expect(out).toBe('abcd…')
    expect(out.length).toBe(5)
  })

  test('never ends on a lone high surrogate', () => {
    const text = `${'a'.repeat(179)}😀😀😀`
    const out = cut(text, 180)
    expect(out.length).toBeLessThanOrEqual(180)
    expect(out.endsWith('…')).toBe(true)
    const beforeEllipsis = out.charCodeAt(out.length - 2)
    expect(beforeEllipsis >= 0xd800 && beforeEllipsis <= 0xdbff).toBe(false)
  })
})

describe('statusWord', () => {
  test('waiting and blocked need input', () => {
    expect(statusWord({ state: 'waiting', outcome: null, interrupted: false })).toBe('needs input')
    expect(statusWord({ state: 'blocked', outcome: null, interrupted: false })).toBe('needs input')
  })

  test('done maps by outcome', () => {
    expect(statusWord({ state: 'done', outcome: 'failure', interrupted: false })).toBe('failed')
    expect(statusWord({ state: 'done', outcome: 'cancellation', interrupted: false })).toBe('stopped')
    expect(statusWord({ state: 'done', outcome: 'success', interrupted: false })).toBe('finished')
    expect(statusWord({ state: 'done', outcome: null, interrupted: false })).toBe('finished')
  })

  test('interrupted is stopped', () => {
    expect(statusWord({ state: 'done', outcome: 'success', interrupted: true })).toBe('stopped')
  })
})

describe('agentBanner', () => {
  test('SC-19 title and whitespace-collapsed body', () => {
    expect(agentBanner({ ...base, lastAssistantMessage: 'All green.\n\nRan 412 tests.' })).toEqual({
      title: 'quirky / fix-tests - Claude finished',
      body: 'All green. Ran 412 tests.',
    })
  })

  test('SC-20 tool fallbacks', () => {
    const waiting = {
      ...base,
      agentLabel: 'Codex',
      state: 'waiting',
      toolName: 'Bash',
      toolInput: 'npm test',
    }
    expect(agentBanner(waiting)).toEqual({
      title: 'quirky / fix-tests - Codex needs input',
      body: 'Using Bash: npm test',
    })
    expect(agentBanner({ ...waiting, toolInput: null }).body).toBe('Using Bash')
    expect(agentBanner({ ...waiting, toolName: null }).body).toBe('Tool input: npm test')
    expect(agentBanner(base).body).toBe('Claude finished.')
  })

  test('SC-21 long context and body are cut without splitting an emoji', () => {
    const out = agentBanner({
      ...base,
      repo: null,
      worktree: 'w'.repeat(100),
      lastAssistantMessage: `${'x'.repeat(179)}${'😀'.repeat(60)}`,
    })
    const context = out.title.split(' - ')[0]!
    expect(context.length).toBe(80)
    expect(context.endsWith('…')).toBe(true)
    expect(out.body.length).toBeLessThanOrEqual(180)
    expect(out.body.endsWith('…')).toBe(true)
    const prev = out.body.charCodeAt(out.body.length - 2)
    expect(prev >= 0xd800 && prev <= 0xdbff).toBe(false)
  })

  test('long labels are cut to 40', () => {
    const out = agentBanner({ ...base, agentLabel: 'L'.repeat(60) })
    expect(out.title).toBe(`quirky / fix-tests - ${cut('L'.repeat(60), 40)} finished`)
  })

  test('SC-24 folder workspace has no repo in the title', () => {
    expect(agentBanner({ ...base, repo: null, worktree: 'notes' }).title).toBe('notes - Claude finished')
  })

  test('SC-23 structured session', () => {
    expect(agentBanner({ ...base, agentLabel: 'Codex', lastAssistantMessage: 'Done.' })).toEqual({
      title: 'quirky / fix-tests - Codex finished',
      body: 'Done.',
    })
  })

  test('failed and stopped statuses reach the title and fallback body', () => {
    expect(agentBanner({ ...base, outcome: 'failure' })).toEqual({
      title: 'quirky / fix-tests - Claude failed',
      body: 'Claude failed.',
    })
    expect(agentBanner({ ...base, interrupted: true }).title).toEndWith('Claude stopped')
  })
})

describe('other banners', () => {
  test('SC-22 bell', () => {
    expect(bellBanner({ repo: 'quirky', worktree: 'fix-tests' })).toEqual({
      title: 'Bell in fix-tests',
      body: 'quirky · Attention requested',
    })
    expect(bellBanner({ repo: null, worktree: '' })).toEqual({
      title: 'Bell in workspace',
      body: 'Attention requested',
    })
  })

  test('program', () => {
    expect(programBanner({ worktree: 'fix-tests', title: 'Build', body: 'ok' })).toEqual({
      title: 'fix-tests: Build',
      body: 'ok',
    })
    expect(programBanner({ worktree: 'fix-tests', title: null, body: 'ok' }).title).toBe(
      'Notification in fix-tests',
    )
    expect(programBanner({ worktree: null, title: 'Build', body: 'ok' }).title).toBe('Quirky: Build')
    expect(programBanner({ worktree: null, title: null, body: 'ok' }).title).toBe('Notification')
  })

  test('test', () => {
    expect(testBanner()).toEqual({
      title: 'Quirky notifications are on',
      body: 'This is a test notification from Quirky.',
    })
  })

  test('SC-25 ask', () => {
    expect(askBanner({ title: 'Deploy?', firstQuestion: 'Ship to prod?' })).toEqual({
      title: 'Deploy?',
      body: 'Ship to prod?',
    })
    expect(askBanner({ title: null, firstQuestion: 'Q' }).title).toBe('Question')
  })

  test('agentLabelFallback capitalises', () => {
    expect(agentLabelFallback('claude')).toBe('Claude')
    expect(agentLabelFallback('')).toBe('')
  })
})
