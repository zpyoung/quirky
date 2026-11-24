import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  formatAskValidationErrors,
  getOptionalPositiveSafeIntegerFlag,
  readAskSpecInput,
  resolveAskOriginParams
} from './ask-cli-flags'

describe('getOptionalPositiveSafeIntegerFlag', () => {
  it('returns undefined when the flag is absent', () => {
    expect(getOptionalPositiveSafeIntegerFlag(new Map(), 'chunk-ms')).toBeUndefined()
  })

  it('parses a valid positive integer', () => {
    expect(getOptionalPositiveSafeIntegerFlag(new Map([['chunk-ms', '5000']]), 'chunk-ms')).toBe(
      5000
    )
  })

  it.each([
    ['valueless (boolean true)', true],
    ['empty string', ''],
    ['non-numeric', 'soon'],
    ['zero', '0'],
    ['negative', '-1'],
    ['inexact fraction', '1.5']
  ])('rejects %s', (_label, value: string | boolean) => {
    expect(() =>
      getOptionalPositiveSafeIntegerFlag(new Map([['chunk-ms', value]]), 'chunk-ms')
    ).toThrow(/--chunk-ms/)
  })
})

describe('readAskSpecInput', () => {
  it('rejects a missing --spec', () => {
    expect(() => readAskSpecInput(new Map(), '/tmp')).toThrow(/--spec/)
  })

  it('parses inline JSON', () => {
    const flags = new Map([['spec', '{"questions":[]}']])
    expect(readAskSpecInput(flags, '/tmp')).toEqual({ questions: [] })
  })

  it('rejects malformed inline JSON, naming --spec', () => {
    const flags = new Map([['spec', '{not json']])
    expect(() => readAskSpecInput(flags, '/tmp')).toThrow(/--spec/)
  })

  describe('@file', () => {
    let dir: string

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'ask-cli-flags-'))
    })

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true })
    })

    it('reads a relative @file path against cwd', () => {
      writeFileSync(join(dir, 'question.json'), '{"questions":[]}', 'utf8')
      const flags = new Map([['spec', '@question.json']])
      expect(readAskSpecInput(flags, dir)).toEqual({ questions: [] })
    })

    it('reads an absolute @file path', () => {
      const absolutePath = join(dir, 'question.json')
      writeFileSync(absolutePath, '{"questions":[]}', 'utf8')
      const flags = new Map([['spec', `@${absolutePath}`]])
      expect(readAskSpecInput(flags, '/somewhere/else')).toEqual({ questions: [] })
    })

    it('names the resolved path when the file is missing', () => {
      const flags = new Map([['spec', '@missing.json']])
      expect(() => readAskSpecInput(flags, dir)).toThrow(new RegExp(join(dir, 'missing.json')))
    })
  })
})

describe('formatAskValidationErrors', () => {
  it('joins path-qualified errors', () => {
    expect(
      formatAskValidationErrors([
        { path: 'questions[0].id', message: 'must be unique' },
        { path: 'questions[1].type', message: 'unsupported' }
      ])
    ).toBe('questions[0].id: must be unique; questions[1].type: unsupported')
  })

  it('drops the path prefix for a top-level error', () => {
    expect(formatAskValidationErrors([{ path: '', message: 'ask spec must be an object' }])).toBe(
      'ask spec must be an object'
    )
  })
})

describe('resolveAskOriginParams', () => {
  const envKeys = [
    'QUIRKY_PANE_KEY',
    'QUIRKY_TERMINAL_HANDLE',
    'QUIRKY_WORKTREE_ID',
    'QUIRKY_WORKSPACE_ID'
  ] as const

  afterEach(() => {
    for (const key of envKeys) {
      delete process.env[key]
    }
  })

  it('carries only cwd when no ask env vars are set', () => {
    for (const key of envKeys) {
      delete process.env[key]
    }
    expect(resolveAskOriginParams('/repo')).toEqual({ cwd: '/repo' })
  })

  it('forwards every set env var verbatim', () => {
    process.env.QUIRKY_PANE_KEY = 'pane_1'
    process.env.QUIRKY_TERMINAL_HANDLE = 'term_1'
    process.env.QUIRKY_WORKTREE_ID = 'wt_1'
    process.env.QUIRKY_WORKSPACE_ID = 'ws_1'
    expect(resolveAskOriginParams('/repo')).toEqual({
      cwd: '/repo',
      paneKey: 'pane_1',
      terminalHandle: 'term_1',
      worktreeId: 'wt_1',
      workspaceId: 'ws_1'
    })
  })
})
