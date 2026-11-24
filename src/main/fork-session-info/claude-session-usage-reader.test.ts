import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readClaudeSessionUsage } from './claude-session-usage-reader'

function turn(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'session-1',
    timestamp: '2026-08-28T10:00:00.000Z',
    cwd: '/repo',
    gitBranch: 'feature',
    message: {
      id: crypto.randomUUID(),
      model: 'claude-opus',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5
      }
    },
    ...overrides
  })
}

describe('readClaudeSessionUsage', () => {
  it('scans only the authoritative transcript session and keeps sidechains inclusive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quirky-session-info-'))
    const transcriptPath = join(directory, 'session.jsonl')
    try {
      await writeFile(
        transcriptPath,
        [
          turn(),
          turn({ isSidechain: true }),
          turn({ sessionId: 'another-session' }),
          JSON.stringify({ type: 'user', sessionId: 'session-1' })
        ].join('\n')
      )

      await expect(readClaudeSessionUsage(transcriptPath, 'session-1', 123)).resolves.toEqual({
        inputTokens: 200,
        outputTokens: 40,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        totalTokens: 270,
        turnCount: 2,
        model: 'claude-opus',
        cwd: '/repo',
        branch: 'feature',
        contextFallback: {
          usedPercentage: 0.0675,
          remainingPercentage: 99.9325,
          windowSize: 200_000,
          updatedAt: 123
        },
        freshness: 'ready',
        updatedAt: 123
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
