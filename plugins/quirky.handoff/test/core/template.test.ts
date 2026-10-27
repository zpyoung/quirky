import { describe, expect, test } from 'bun:test'
import { applyTemplate, BUILTIN_TEMPLATES, normalizeTemplates } from '../../src/core/template'

describe('applyTemplate', () => {
  test('fills the variables and their SCREAMING_CASE aliases (SC-19)', () => {
    const body = 'a {{gitStatus}} b {{GIT_STATUS}} c {{changedPaths}} d {{CHANGED_PATHS}} e {{openEditorTabs}} f {{OPEN_EDITOR_TABS}}'
    expect(applyTemplate(body, { gitStatus: 'S', changedPaths: 'P', openEditorTabs: 'T' })).toBe('a S b S c P d P e T f T')
  })

  test('reads missing data as a sentence saying so (SC-19)', () => {
    expect(applyTemplate('Status: {{gitStatus}} / {{CHANGED_PATHS}} / {{openEditorTabs}}', {})).toBe(
      'Status: No git status was included. / No changed paths were included. / No open editor tabs were included.'
    )
    expect(applyTemplate('{{gitStatus}}', { gitStatus: null })).toBe('No git status was included.')
    expect(applyTemplate('{{gitStatus}}', { gitStatus: '' })).toBe('No git status was included.')
  })

  test('inserts values literally and does not expand variables inside them', () => {
    expect(applyTemplate('{{gitStatus}}|{{changedPaths}}', { gitStatus: "$& $1 {{changedPaths}}", changedPaths: 'P' })).toBe(
      '$& $1 {{changedPaths}}|P'
    )
  })

  test('leaves unknown variables alone', () => {
    expect(applyTemplate('{{other}}', {})).toBe('{{other}}')
  })
})

describe('BUILTIN_TEMPLATES', () => {
  test('are the three built-ins (SC-22)', () => {
    expect(BUILTIN_TEMPLATES).toEqual([
      {
        id: 'continue-implementation',
        name: 'Continue implementation',
        body: 'Continue the implementation from where the prior session stopped. Check the current state first:\n{{gitStatus}}\nFinish the remaining work, run the relevant tests, and report what changed.'
      },
      {
        id: 'review-completed-work',
        name: 'Review what was done',
        body: 'Review the work the prior session did. Changed paths:\n{{changedPaths}}\nLook for bugs, missing tests and unfinished pieces. Report findings before changing anything.'
      },
      {
        id: 'debug-failure',
        name: 'Debug the failure',
        body: 'The prior session hit a failure. Reproduce it first, find the root cause, then fix it with a test that fails without the fix. Current state:\n{{gitStatus}}'
      }
    ])
  })

  test('survive normalization unchanged', () => {
    expect(normalizeTemplates(BUILTIN_TEMPLATES)).toEqual(BUILTIN_TEMPLATES)
  })
})

describe('normalizeTemplates', () => {
  test('cuts names to 80 and bodies to 8,000, drops empty bodies and caps at 24 (SC-23)', () => {
    const list = [
      { name: 'n'.repeat(100), body: 'b' },
      { name: 'long body', body: 'x'.repeat(9_000) },
      { name: 'empty', body: '' },
      ...Array.from({ length: 24 }, (_, i) => ({ name: `t${i}`, body: 'b' }))
    ]
    const result = normalizeTemplates(list)
    expect(result).toHaveLength(24)
    expect(result[0]!.name).toBe('n'.repeat(80))
    expect(result[1]!.body).toBe('x'.repeat(8_000))
    expect(result.some((template) => template.name === 'empty')).toBe(false)
    expect(result.at(-1)!.name).toBe('t21')
  })

  test('drops entries without a name or with a blank body', () => {
    expect(normalizeTemplates([{ name: '  ', body: 'b' }, { name: 'a', body: '   ' }, { name: 'ok', body: 'b' }]).map((t) => t.name)).toEqual(['ok'])
  })

  test('drops duplicate ids and numbers missing ones', () => {
    const result = normalizeTemplates([
      { id: 'a', name: 'First', body: '1' },
      { id: 'a', name: 'Second', body: '2' },
      { name: 'Third', body: '3' },
      { id: 'template-2', name: 'Fourth', body: '4' },
      { name: 'Fifth', body: '5' }
    ])
    expect(result).toEqual([
      { id: 'a', name: 'First', body: '1' },
      { id: 'template-1', name: 'Third', body: '3' },
      { id: 'template-2', name: 'Fourth', body: '4' },
      { id: 'template-3', name: 'Fifth', body: '5' }
    ])
  })

  test('keeps templates with the same name', () => {
    expect(normalizeTemplates([{ name: 'Same', body: '1' }, { name: 'Same', body: '2' }])).toHaveLength(2)
  })

  test('an empty list stays empty', () => {
    expect(normalizeTemplates([])).toEqual([])
  })

  test('ignores values that are not templates', () => {
    expect(normalizeTemplates([null, 'x', 4, { name: 3, body: 'b' }])).toEqual([])
  })
})
