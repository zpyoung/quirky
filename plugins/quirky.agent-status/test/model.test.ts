import { describe, expect, test } from 'bun:test'
import {
  CAPS,
  LABELS,
  STALE_AFTER_MS,
  capLine,
  capRaw,
  capText,
  coarseStatus,
  displayOf,
  readableDetail,
  summaryOf,
  windowDisplay,
} from '../src/model'
import type { AgentDisplayState, AgentRow, AgentStatusSummary } from '../src/types'

const NOW = 10_000_000
const MIN = 60_000

function row(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    sessionId: 's1',
    agent: 'claude',
    state: 'working',
    prompt: '',
    detail: '',
    lead: { providerSession: null, agentPid: null, agentStart: null, ended: false, state: 'working', stateStartedAt: NOW },
    children: [],
    stateStartedAt: NOW,
    evidenceAt: NOW,
    turnStartedAt: null,
    lastHookAt: null,
    source: 'hook',
    ...overrides,
  }
}

describe('LABELS', () => {
  test('one label per display state', () => {
    expect(LABELS).toEqual({
      working: 'Working',
      monitoring: 'Monitoring background tasks',
      waiting: 'Waiting for input',
      permission: 'Needs attention',
      blocked: 'Blocked',
      failed: 'Failed',
      interrupted: 'Interrupted',
      done: 'Done',
      unverifiable: 'No recent update',
      idle: 'Idle',
      unconfirmed: "Couldn't confirm",
    })
  })
})

describe('displayOf', () => {
  const table: [string, Partial<AgentRow>, boolean, AgentDisplayState][] = [
    ['working', { state: 'working' }, true, 'working'],
    ['monitoring', { state: 'working', workingMode: 'monitoring' }, true, 'monitoring'],
    ['waiting from a hook', { state: 'waiting' }, true, 'waiting'],
    ['waiting from a title is permission', { state: 'waiting', source: 'title' }, true, 'permission'],
    ['waiting from OSC 7501 is waiting', { state: 'waiting', source: 'program-status', programStatus: { state: 'blocked', kind: 'permission' } }, true, 'waiting'],
    ['blocked', { state: 'blocked' }, true, 'blocked'],
    ['blocked from a title is blocked', { state: 'blocked', source: 'title' }, true, 'blocked'],
    ['done', { state: 'done', outcome: 'success' }, true, 'done'],
    ['done with no outcome', { state: 'done' }, true, 'done'],
    ['failed', { state: 'done', outcome: 'failure' }, true, 'failed'],
    ['interrupted flag', { state: 'done', interrupted: true, outcome: 'cancellation' }, true, 'interrupted'],
    ['cancellation outcome alone', { state: 'done', outcome: 'cancellation' }, true, 'interrupted'],
    ['interrupted flag alone', { state: 'done', interrupted: true }, true, 'interrupted'],
    ['unconfirmed', { state: 'working', restoredUnconfirmed: true }, true, 'unconfirmed'],
    ['unconfirmed waiting', { state: 'waiting', restoredUnconfirmed: true }, false, 'unconfirmed'],
    ['restored done row is just done', { state: 'done', restoredUnconfirmed: true }, true, 'done'],
    ['stale working, session running', { state: 'working', evidenceAt: NOW - 31 * MIN }, true, 'unverifiable'],
    ['stale working, session gone', { state: 'working', evidenceAt: NOW - 31 * MIN }, false, 'idle'],
    ['stale waiting decays too', { state: 'waiting', evidenceAt: NOW - 31 * MIN }, true, 'unverifiable'],
    ['stale title permission decays too', { state: 'waiting', source: 'title', evidenceAt: NOW - 31 * MIN }, true, 'unverifiable'],
    ['exactly 30 minutes is still fresh', { state: 'working', evidenceAt: NOW - STALE_AFTER_MS }, true, 'working'],
    ['a done row never decays', { state: 'done', outcome: 'success', evidenceAt: NOW - 8 * 24 * 60 * MIN }, false, 'done'],
    ['a failed row never decays', { state: 'done', outcome: 'failure', evidenceAt: NOW - 8 * 24 * 60 * MIN }, true, 'failed'],
  ]

  test.each(table)('%s', (_name, overrides, running, display) => {
    const shown = displayOf(row(overrides), NOW, running)
    expect(shown.display).toBe(display)
    expect(shown.label).toBe(LABELS[display])
  })

  test('SC-16: silence decays the display with the minutes in the detail, never the state', () => {
    const stale = row({ state: 'working', evidenceAt: NOW - 31 * MIN })
    expect(displayOf(stale, NOW, true)).toEqual({ display: 'unverifiable', label: 'No recent update', detail: 'No update in 31m' })
    expect(displayOf(stale, NOW, false).detail).toBe('No update in 31m')
    expect(stale.state).toBe('working')
  })

  test('unconfirmed keeps the row detail', () => {
    expect(displayOf(row({ restoredUnconfirmed: true, detail: 'Bash: ls' }), NOW, true).detail).toBe('Bash: ls')
  })

  test('the stored detail is shown when it is readable', () => {
    expect(displayOf(row({ detail: 'Bash: npm test', toolName: 'Edit' }), NOW, true).detail).toBe('Bash: npm test')
  })

  test('a stored detail that is a JSON object is replaced by a readable one', () => {
    const shown = displayOf(row({ state: 'waiting', detail: '{"approval":{"x":1}}', toolName: 'Bash', toolInput: '{"command":"npm test"}' }), NOW, true)
    expect(shown.detail).toBe('Bash: npm test')
  })
})

describe('windowDisplay', () => {
  const summary = (overrides: Partial<AgentStatusSummary> = {}): AgentStatusSummary => ({
    ...summaryOf(row({ state: 'working', detail: 'Bash: ls' }), NOW, true),
    ...overrides,
  })

  test('returns the summary display and label while fresh', () => {
    expect(windowDisplay(summary(), NOW + 29 * MIN, true)).toEqual({ display: 'working', label: 'Working', detail: 'Bash: ls' })
  })

  test('a live summary that went quiet decays by whether the session runs', () => {
    expect(windowDisplay(summary(), NOW + 31 * MIN, true)).toEqual({ display: 'unverifiable', label: 'No recent update', detail: 'No update in 31m' })
    expect(windowDisplay(summary(), NOW + 31 * MIN, false).display).toBe('idle')
  })

  test('a done summary never decays', () => {
    const done = summary({ state: 'done', display: 'done', label: 'Done' })
    expect(windowDisplay(done, NOW + 99 * MIN, false).display).toBe('done')
  })

  test('an unconfirmed summary stays unconfirmed', () => {
    const unconfirmed = summary({ display: 'unconfirmed', label: "Couldn't confirm", restoredUnconfirmed: true })
    expect(windowDisplay(unconfirmed, NOW + 99 * MIN, true).display).toBe('unconfirmed')
  })

  test('agrees with displayOf for the same row at the same time', () => {
    const r = row({ state: 'working', workingMode: 'monitoring', evidenceAt: NOW })
    for (const later of [0, 29 * MIN, 31 * MIN]) {
      expect(windowDisplay(summaryOf(r, NOW, true), NOW + later, true).display).toBe(displayOf(r, NOW + later, true).display)
    }
  })
})

describe('coarseStatus', () => {
  const table: [AgentDisplayState | null, 'running' | 'working' | 'waiting' | 'done'][] = [
    ['working', 'working'],
    ['monitoring', 'working'],
    ['waiting', 'waiting'],
    ['blocked', 'waiting'],
    ['permission', 'waiting'],
    ['done', 'done'],
    ['failed', 'done'],
    ['interrupted', 'done'],
    [null, 'running'],
  ]
  test.each(table)('%s -> %s', (display, expected) => {
    expect(coarseStatus(display)).toBe(expected)
  })

  test.each(['unverifiable', 'idle', 'unconfirmed'] as const)('%s keeps the underlying state', (display) => {
    expect(coarseStatus(display, 'working')).toBe('working')
    expect(coarseStatus(display, 'waiting')).toBe('waiting')
    expect(coarseStatus(display, 'blocked')).toBe('waiting')
    expect(coarseStatus(display, 'done')).toBe('done')
  })
})

describe('summaryOf', () => {
  test('carries the display, the progress and the times', () => {
    const r = row({ state: 'working', toolName: 'Bash', toolInput: 'npm test', stateStartedAt: 5, evidenceAt: NOW - MIN, programStatus: { state: 'working', progress: 40 } })
    expect(summaryOf(r, NOW, true)).toEqual({
      state: 'working',
      display: 'working',
      label: 'Working',
      detail: 'Bash: npm test',
      progress: 40,
      stateStartedAt: 5,
      evidenceAt: NOW - MIN,
      restoredUnconfirmed: false,
    })
  })

  test('progress is null without a program report; unconfirmed is carried', () => {
    const summary = summaryOf(row({ restoredUnconfirmed: true }), NOW, true)
    expect(summary.progress).toBeNull()
    expect(summary.restoredUnconfirmed).toBe(true)
    expect(summary.display).toBe('unconfirmed')
  })

  test('a stale row summarizes as unverifiable with its state intact', () => {
    const summary = summaryOf(row({ evidenceAt: NOW - 31 * MIN }), NOW, true)
    expect(summary).toMatchObject({ state: 'working', display: 'unverifiable', detail: 'No update in 31m' })
  })
})

describe('field caps', () => {
  test('capLine folds line breaks, trims and caps', () => {
    expect(capLine('  fix\nthe\r\ntests  ', 200)).toBe('fix the tests')
    expect(capLine('a\n\n\nb\u2028c', 200)).toBe('a b c')
    expect(capLine('x'.repeat(300), CAPS.prompt)).toBe('x'.repeat(200))
    expect(capLine(undefined, 10)).toBe('')
    expect(capLine(42, 10)).toBe('')
  })

  test('capLine never leaves half a surrogate pair', () => {
    const text = `${'a'.repeat(9)}😀tail`
    const capped = capLine(text, 10)
    expect(capped).toBe('a'.repeat(9))
    expect(capLine(`${'a'.repeat(8)}😀tail`, 10)).toBe(`${'a'.repeat(8)}😀`)
  })

  test('the caps are the documented ones', () => {
    expect(CAPS).toMatchObject({ prompt: 200, toolName: 60, toolInput: 160, lastAssistantMessage: 8000, question: 16000, model: 120 })
  })

  test('capText keeps paragraphs and caps blank runs', () => {
    expect(capText('a\r\nb\n\n\n\nc', 8000)).toBe('a\nb\n\nc')
    expect(capText('y'.repeat(9000), CAPS.lastAssistantMessage)).toHaveLength(8000)
  })

  test('capRaw only truncates', () => {
    const json = `  {"questions": [\n"a"]}  `
    expect(capRaw(json, CAPS.question)).toBe(json)
    expect(capRaw('z'.repeat(20000), CAPS.question)).toHaveLength(16000)
  })
})

describe('readableDetail', () => {
  const asked = JSON.stringify({ questions: [{ question: 'Which branch?', header: 'Branch', options: [{ label: 'main' }, { label: 'dev' }] }] })

  test.each([
    ['tool and a plain input', { toolName: 'Bash', toolInput: 'npm test' }, 'Bash: npm test'],
    ['SC-32: a JSON object tool input', { toolName: 'Bash', toolInput: `{"command":"printf 'x' >> README.md"}` }, `Bash: printf 'x' >> README.md`],
    ['a file path input', { toolName: 'Read', toolInput: '{"file_path":"/a/b.ts","limit":10}' }, 'Read: /a/b.ts'],
    ['an input with no readable field', { toolName: 'Task', toolInput: '{"n":1}' }, 'Task'],
    ['a truncated JSON input', { toolName: 'Bash', toolInput: '{"command":"npm te' }, 'Bash'],
    ['a tool without input', { toolName: 'Bash' }, 'Bash'],
    ['the question text while waiting', { state: 'waiting', question: asked, toolName: 'AskUserQuestion' }, 'Which branch?'],
    ['a plain-text question', { state: 'waiting', question: 'Proceed?' }, 'Proceed?'],
    ['a question outranks the tool when blocked', { state: 'blocked', question: asked, toolName: 'Bash' }, 'Which branch?'],
    ['an answered question is not shown while working', { state: 'working', question: asked, toolName: 'Bash', toolInput: 'ls' }, 'Bash: ls'],
    ['unreadable question falls back to the tool', { state: 'waiting', question: '{"questions":[{"opt', toolName: 'Bash', toolInput: 'ls' }, 'Bash: ls'],
    ['held permission supplies the tool', { state: 'waiting', heldPermission: { toolUseId: 't1', toolName: 'Bash', input: '{"command":"npm test"}', childId: null } }, 'Bash: npm test'],
    ['the prompt when nothing else', { prompt: 'fix the tests' }, 'fix the tests'],
    ['a multi-line prompt on one line', { prompt: 'fix\nthe tests' }, 'fix the tests'],
    ['done shows the last message', { state: 'done', lastAssistantMessage: 'All green\nbye', prompt: 'p' }, 'All green bye'],
    ['done without a message shows the prompt', { state: 'done', prompt: 'p' }, 'p'],
    ['program message', { state: 'working', programStatus: { state: 'working', msg: 'Indexing' }, prompt: 'p' }, 'Indexing'],
    ['nothing', {}, ''],
  ] as [string, Partial<AgentRow>, string][])('%s', (_name, overrides, expected) => {
    expect(readableDetail(row(overrides))).toBe(expected)
  })

  test('never yields JSON object text, whichever field carries it', () => {
    const rows = [
      row({ prompt: '{"a":1}' }),
      row({ state: 'waiting', question: '{"a":1}', prompt: '{"b":2}' }),
      row({ state: 'done', lastAssistantMessage: '{"a":1}' }),
      row({ toolName: 'Bash', toolInput: '{"a":{"b":1}}' }),
    ]
    for (const r of rows) {
      const detail = readableDetail(r)
      expect(detail.startsWith('{')).toBe(false)
    }
  })

  test('never yields JSON object text longer than the detail cap', () => {
    const long = JSON.stringify({ result: 'x'.repeat(CAPS.detail * 2) })
    const rows = [
      row({ state: 'done', prompt: 'human prompt', lastAssistantMessage: long }),
      row({ state: 'done', prompt: 'human prompt', programStatus: { state: 'done', msg: long } }),
      row({ state: 'working', prompt: 'human prompt', programStatus: { state: 'working', msg: long } }),
      row({ prompt: long }),
    ]
    expect(readableDetail(rows[0]!)).toBe('human prompt')
    expect(readableDetail(rows[1]!)).toBe('human prompt')
    expect(readableDetail(rows[2]!)).toBe('human prompt')
    expect(readableDetail(rows[3]!)).toBe('')
  })

  test('displayOf drops a stored detail that is capped JSON object text', () => {
    const long = JSON.stringify({ result: 'x'.repeat(CAPS.detail * 2) }).slice(0, CAPS.detail)
    const shown = displayOf(row({ state: 'working', detail: long, prompt: 'human prompt' }), 0, true)
    expect(shown.detail).toBe('human prompt')
  })

  test('is capped to a line', () => {
    expect(readableDetail(row({ prompt: 'p'.repeat(500) }))).toHaveLength(CAPS.detail)
  })
})
