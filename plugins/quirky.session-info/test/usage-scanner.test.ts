import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanClaudeUsage } from '../src/usage-scanner'

let tempDirectory: string

beforeEach(async () => {
  tempDirectory = await mkdtemp(join(tmpdir(), 'quirky-session-info-usage-'))
})

afterEach(async () => {
  await rm(tempDirectory, { recursive: true, force: true })
})

const record = (fields: Record<string, unknown>) => JSON.stringify(fields)

async function transcript(contents: string): Promise<string> {
  const path = join(tempDirectory, 'session.jsonl')
  await writeFile(path, contents)
  return path
}

describe('scanClaudeUsage', () => {
  test('SC-13: includes only matching lead assistant messages and keeps the latest update per message ID', async () => {
    const path = await transcript([
      record({
        type: 'assistant', sessionId: 'provider-1', isSidechain: false, cwd: '/work/older', gitBranch: 'older',
        message: { id: 'msg-old', role: 'assistant', model: 'claude-sonnet', usage: { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } }
      }),
      record({
        type: 'assistant', sessionId: 'provider-1', isSidechain: false, cwd: '/work/current', gitBranch: 'feature/current',
        message: { id: 'msg-current', role: 'assistant', model: 'claude-opus', usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } }
      }),
      record({
        type: 'assistant', sessionId: 'provider-1', isSidechain: false,
        message: { id: 'msg-current', role: 'assistant', usage: { input_tokens: 7, output_tokens: 4, cache_creation_input_tokens: 6, cache_read_input_tokens: 8 } }
      }),
      record({
        type: 'assistant', sessionId: 'provider-other', isSidechain: false,
        message: { id: 'msg-other-session', role: 'assistant', model: 'ignored', usage: { input_tokens: 100, output_tokens: 100, cache_creation_input_tokens: 100, cache_read_input_tokens: 100 } }
      }),
      record({
        type: 'assistant', sessionId: 'provider-1', isSidechain: true,
        message: { id: 'msg-sidechain', role: 'assistant', model: 'ignored', usage: { input_tokens: 200, output_tokens: 200, cache_creation_input_tokens: 200, cache_read_input_tokens: 200 } }
      }),
      record({
        type: 'user', sessionId: 'provider-1', isSidechain: false,
        message: { id: 'msg-user', role: 'user' }
      })
    ].join('\n') + '\n')

    const result = await scanClaudeUsage(path, 'provider-1')

    expect(result).toMatchObject({
      input: 17,
      output: 6,
      cacheWrite: 9,
      cacheRead: 12,
      total: 44,
      turnCount: 2,
      model: 'claude-opus',
      cwd: '/work/current',
      gitBranch: 'feature/current',
      context: { used: 25, remaining: 199975, window: 200000, estimated: true }
    })
  })

  test('SC-13: falls back to the latest known assistant context and metadata within a partial update', async () => {
    const path = await transcript([
      record({
        type: 'assistant', sessionId: 'provider-1', isSidechain: false, cwd: '/work/previous', gitBranch: 'previous',
        message: { id: 'msg-previous', role: 'assistant', model: 'claude-haiku', usage: { input_tokens: 50, output_tokens: 10 } }
      }),
      record({
        type: 'assistant', sessionId: 'provider-1', isSidechain: false, cwd: '/work/latest', gitBranch: 'latest',
        message: { id: 'msg-latest', role: 'assistant', model: 'claude-sonnet', usage: { input_tokens: 80, output_tokens: 20 } }
      }),
      record({
        type: 'assistant', sessionId: 'provider-1', isSidechain: false,
        message: { id: 'msg-latest', role: 'assistant', usage: { input_tokens: 90, output_tokens: 30 } }
      })
    ].join('\n'))

    const result = await scanClaudeUsage(path, 'provider-1')

    expect(result).toMatchObject({
      input: 140,
      output: 40,
      total: 180,
      turnCount: 2,
      model: 'claude-sonnet',
      cwd: '/work/latest',
      gitBranch: 'latest',
      context: { used: 120, remaining: 199880, window: 200000, estimated: true }
    })
  })

  test('SC-20: omits invalid fields while retaining valid usage siblings', async () => {
    const path = await transcript(record({
      type: 'assistant', sessionId: 'provider-1', isSidechain: false, cwd: '/work/\u0000invalid', gitBranch: '\u0000invalid',
      message: {
        id: 'msg-invalid-fields', role: 'assistant', model: 'claude-\u0000invalid',
        usage: { input_tokens: -1, output_tokens: null, cache_creation_input_tokens: 2, cache_read_input_tokens: '3' }
      }
    }))

    const result = await scanClaudeUsage(path, 'provider-1')

    expect(result).toMatchObject({ cacheWrite: 2, total: 2, turnCount: 1, context: { used: 2, estimated: true } })
    expect(result).not.toHaveProperty('input')
    expect(result).not.toHaveProperty('output')
    expect(result).not.toHaveProperty('cacheRead')
    expect(result).not.toHaveProperty('model')
    expect(result).not.toHaveProperty('cwd')
    expect(result).not.toHaveProperty('gitBranch')
  })

  test('rejects a malformed JSONL line with a bounded line-numbered error', async () => {
    const path = await transcript([
      record({ type: 'assistant', sessionId: 'provider-1', message: { id: 'msg-1', role: 'assistant', usage: { input_tokens: 1 } } }),
      '{not-json}'
    ].join('\n'))

    const failure = await scanClaudeUsage(path, 'provider-1').then(
      () => null,
      (error: unknown) => error
    )
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('Expected the malformed transcript scan to fail')
    expect(failure.message).toMatch(/malformed transcript line 2/i)
    expect(failure.message.length).toBeLessThanOrEqual(500)
  })

  test('SC-14: rejects transcripts exceeding maxBytes and lines exceeding the per-line bound', async () => {
    const smallPath = await transcript(`${record({ type: 'assistant', sessionId: 'provider-1', message: { id: 'msg-1', role: 'assistant' } })}\n`)
    await expect(scanClaudeUsage(smallPath, 'provider-1', { maxBytes: 16 })).rejects.toThrow(/transcript.*(?:size|bytes|maximum)/i)

    const longLinePath = join(tempDirectory, 'long-line.jsonl')
    await writeFile(longLinePath, ' '.repeat(1_048_577))
    await expect(scanClaudeUsage(longLinePath, 'provider-1')).rejects.toThrow(/line exceeds maximum size/i)
  })

  test('SC-14/20: reports missing, overlong, and invalid provider paths before returning usage', async () => {
    const missingPath = join(tempDirectory, 'missing.jsonl')

    await expect(scanClaudeUsage(missingPath, 'provider-1')).rejects.toThrow(/transcript/i)
    await expect(scanClaudeUsage('x'.repeat(32_769), 'provider-1')).rejects.toThrow(/path.*(?:length|long|32768)/i)
    await expect(scanClaudeUsage(missingPath, 'x'.repeat(513))).rejects.toThrow(/provider session ID/i)
  })
})
