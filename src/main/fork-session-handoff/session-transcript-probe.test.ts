import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForkHandoffTranscriptProbeRequest } from '../../shared/fork-session-handoff/session-transcript-probe-types'
import { encodeClaudeProjectPath } from '../ai-vault/claude-project-dir-encoding'
import { resolveHandoffTranscript } from './session-transcript-probe'

let root: string
let claudeProjectsDir: string
let projectsDir: string
let transcriptPath: string
const resolveSessionFile = vi.fn()

// The bucket name Claude derives from a cwd, so the directory scan has a real
// workspace to encode rather than a hand-written slug that could drift from it.
const workspacePath = '/workspace/repo'

function request(
  overrides: Partial<ForkHandoffTranscriptProbeRequest> = {}
): ForkHandoffTranscriptProbeRequest {
  return {
    agent: 'claude',
    sessionId: 'session-1',
    transcriptPath,
    paneKey: null,
    workspacePath: null,
    connectionId: null,
    ...overrides
  }
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    wslHomeDirs: async () => [],
    rootOptions: { claudeProjectsDir },
    resolveSessionFile,
    paneTranscriptPaths: () => [],
    isSessionClaimedByOtherPane: () => false,
    ...overrides
  } as Parameters<typeof resolveHandoffTranscript>[1]
}

beforeEach(() => {
  vi.clearAllMocks()
  root = mkdtempSync(join(tmpdir(), 'handoff-transcript-'))
  claudeProjectsDir = join(root, '.claude', 'projects')
  projectsDir = join(claudeProjectsDir, 'repo-slug')
  mkdirSync(projectsDir, { recursive: true })
  transcriptPath = join(projectsDir, 'session-1.jsonl')
  writeFileSync(transcriptPath, '{}\n')
  resolveSessionFile.mockResolvedValue(null)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolveHandoffTranscript', () => {
  // The regression: a transcript is legitimately outside every repo, so the
  // workspace allow-list this probe used to sit behind denied all of them.
  it('finds a transcript that lives outside every workspace root', async () => {
    await expect(resolveHandoffTranscript(request(), deps())).resolves.toEqual({
      outcome: 'found',
      transcriptPath,
      provenance: 'reported'
    })
  })

  it('recovers a session whose reported path has gone stale', async () => {
    resolveSessionFile.mockResolvedValue(transcriptPath)
    await expect(
      resolveHandoffTranscript(
        request({ transcriptPath: join(projectsDir, 'renamed-away.jsonl') }),
        deps()
      )
    ).resolves.toEqual({ outcome: 'found', transcriptPath, provenance: 'session-id' })
  })

  it('reports an absent transcript as missing, not unverifiable', async () => {
    await expect(
      resolveHandoffTranscript(request({ transcriptPath: join(projectsDir, 'gone.jsonl') }), deps())
    ).resolves.toEqual({ outcome: 'missing' })
  })

  it('refuses a path outside the agent session roots', async () => {
    const outside = join(root, 'elsewhere.jsonl')
    writeFileSync(outside, '{}\n')
    await expect(
      resolveHandoffTranscript(request({ transcriptPath: outside }), deps())
    ).resolves.toEqual({ outcome: 'unverifiable', reason: 'path-outside-known-roots' })
  })

  it('refuses traversal out of a session root', async () => {
    const secret = join(root, 'secret.jsonl')
    writeFileSync(secret, '{}\n')
    await expect(
      resolveHandoffTranscript(
        request({ transcriptPath: join(projectsDir, '..', '..', '..', 'secret.jsonl') }),
        deps()
      )
    ).resolves.toEqual({ outcome: 'unverifiable', reason: 'path-outside-known-roots' })
  })

  it('refuses a path the session scanner would never surface', async () => {
    const subagentsDir = join(projectsDir, 'subagents')
    mkdirSync(subagentsDir, { recursive: true })
    const subagentTranscript = join(subagentsDir, 'session-1.jsonl')
    writeFileSync(subagentTranscript, '{}\n')
    await expect(
      resolveHandoffTranscript(request({ transcriptPath: subagentTranscript }), deps())
    ).resolves.toEqual({ outcome: 'unverifiable', reason: 'undiscoverable-path' })
  })

  it('reports an agent with no known session root as unverifiable', async () => {
    await expect(resolveHandoffTranscript(request({ agent: 'opencode' }), deps())).resolves.toEqual(
      { outcome: 'unverifiable', reason: 'unsupported-agent' }
    )
  })

  it('reports a refused host lookup as unverifiable, never as missing', async () => {
    resolveSessionFile.mockRejectedValue(new Error('wsl distro stalled'))
    await expect(resolveHandoffTranscript(request(), deps())).resolves.toEqual({
      outcome: 'unverifiable',
      reason: 'resolve-failed'
    })
  })

  it('probes an agent the transcript reader cannot parse by its reported path', async () => {
    const piSessions = join(root, '.pi', 'agent', 'sessions')
    mkdirSync(piSessions, { recursive: true })
    const piTranscript = join(piSessions, 'session-1.jsonl')
    writeFileSync(piTranscript, '{}\n')
    await expect(
      resolveHandoffTranscript(
        request({ agent: 'pi', transcriptPath: piTranscript }),
        deps({ rootOptions: { piSessionsDir: piSessions } })
      )
    ).resolves.toEqual({ outcome: 'found', transcriptPath: piTranscript, provenance: 'reported' })
    expect(resolveSessionFile).not.toHaveBeenCalled()
  })

  // The live failure: Claude Code reports a freshly minted session id, and a
  // path derived from it, before writing any file for it. Both the reported path
  // and `<id>.jsonl` miss while the conversation sits under the previous id.
  it('falls back to a path the pane reported before its session id rotated', async () => {
    await expect(
      resolveHandoffTranscript(
        request({ sessionId: 'rotated-id', transcriptPath: join(projectsDir, 'rotated-id.jsonl') }),
        deps({ paneTranscriptPaths: () => [transcriptPath] })
      )
    ).resolves.toEqual({ outcome: 'found', transcriptPath, provenance: 'pane-history' })
  })

  it('skips a pane-history path that is also gone', async () => {
    await expect(
      resolveHandoffTranscript(
        request({ sessionId: 'rotated-id', transcriptPath: join(projectsDir, 'rotated-id.jsonl') }),
        deps({ paneTranscriptPaths: () => [join(projectsDir, 'also-gone.jsonl'), transcriptPath] })
      )
    ).resolves.toEqual({ outcome: 'found', transcriptPath, provenance: 'pane-history' })
  })

  it('scans the project bucket as a last resort and takes the newest transcript', async () => {
    const bucket = join(claudeProjectsDir, encodeClaudeProjectPath(workspacePath))
    mkdirSync(bucket, { recursive: true })
    const older = join(bucket, 'older.jsonl')
    const newer = join(bucket, 'newer.jsonl')
    writeFileSync(older, '{}\n')
    writeFileSync(newer, '{}\n')
    // Hours apart: only a recent runner-up makes the scan ambiguous.
    utimesSync(older, new Date(Date.now() - 6 * 3600_000), new Date(Date.now() - 6 * 3600_000))
    utimesSync(newer, new Date(), new Date())
    await expect(
      resolveHandoffTranscript(
        request({
          sessionId: 'rotated-id',
          transcriptPath: join(projectsDir, 'rotated-id.jsonl'),
          workspacePath
        }),
        deps()
      )
    ).resolves.toEqual({ outcome: 'found', transcriptPath: newer, provenance: 'project-scan' })
  })

  it('leaves another pane its own session rather than handing it over', async () => {
    const bucket = join(claudeProjectsDir, encodeClaudeProjectPath(workspacePath))
    mkdirSync(bucket, { recursive: true })
    writeFileSync(join(bucket, 'other-pane.jsonl'), '{}\n')
    await expect(
      resolveHandoffTranscript(
        request({
          sessionId: 'rotated-id',
          transcriptPath: join(projectsDir, 'rotated-id.jsonl'),
          workspacePath
        }),
        deps({
          isSessionClaimedByOtherPane: (_paneKey: string | null, id: string) => id === 'other-pane'
        })
      )
    ).resolves.toEqual({ outcome: 'missing' })
  })

  it('does not scan a project bucket for an agent that is not Claude', async () => {
    const scanProjectTranscript = vi.fn().mockResolvedValue({ path: null, ambiguous: false })
    const piSessions = join(root, '.pi', 'agent', 'sessions')
    mkdirSync(piSessions, { recursive: true })
    await expect(
      resolveHandoffTranscript(
        request({
          agent: 'pi',
          transcriptPath: join(piSessions, 'gone.jsonl'),
          workspacePath
        }),
        deps({ rootOptions: { piSessionsDir: piSessions }, scanProjectTranscript })
      )
    ).resolves.toEqual({ outcome: 'missing' })
    expect(scanProjectTranscript).not.toHaveBeenCalled()
  })

  // F4: with the pane history empty, two live conversations in one workspace are
  // indistinguishable, and handing over the wrong one is worse than declining.
  it('declines a project scan it cannot attribute to the source pane', async () => {
    const bucket = join(claudeProjectsDir, encodeClaudeProjectPath(workspacePath))
    mkdirSync(bucket, { recursive: true })
    for (const name of ['one.jsonl', 'two.jsonl']) {
      writeFileSync(join(bucket, name), '{}\n')
    }
    await expect(
      resolveHandoffTranscript(
        request({
          sessionId: 'rotated-id',
          transcriptPath: join(projectsDir, 'rotated-id.jsonl'),
          workspacePath
        }),
        deps()
      )
    ).resolves.toEqual({ outcome: 'unverifiable', reason: 'ambiguous-project-scan' })
  })

  it('reports an SSH target as unverifiable', async () => {
    await expect(
      resolveHandoffTranscript(request({ connectionId: 'build-box' }), deps())
    ).resolves.toEqual({ outcome: 'unverifiable', reason: 'host-unavailable' })
  })
})
