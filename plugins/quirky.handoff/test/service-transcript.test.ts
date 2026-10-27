import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { readCapture } from '../src/daemon/source'
import type { Preview } from '../src/daemon/types'
import { HandoffRig } from './support'

let rig: HandoffRig
afterEach(async () => {
  await rig?.cleanup()
  rig = undefined as unknown as HandoffRig
})

const preview = (params: Record<string, unknown>) => rig.call('quirky.handoff/preview', params) as Promise<Preview>
const projectOf = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')
const cwdOf = async (session: string) => ((await rig.call('quirky.session/get', { session })) as { cwd: string }).cwd
const noRepo = { include: { repoState: false, diffBodies: false, openEditorTabs: false } }

describe('SC-25: a reported transcript inside the agent root is used by path', () => {
  test('the probe is usable, the base names the path and no capture is inlined', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    const path = rig.claudeTranscript('w', 'abc')
    await rig.reportTranscript(s.id, 'abc', path)
    rig.setHistory(['terminal line that must stay home'])
    const result = await preview({ source: { session: s.id }, controls: noRepo })
    expect(result.probe).toEqual({ verdict: 'usable', path, reason: null, candidate: 'reported' })
    expect(result.brief).toContain(`\`\`\`text\n${path}\n\`\`\``)
    expect(result.brief).not.toContain('terminal line that must stay home')
    expect(result.warnings).toEqual([])
  })

  test('the probe method answers the same verdict', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    const path = rig.claudeTranscript('w', 'abc')
    await rig.reportTranscript(s.id, 'abc', path)
    expect(await rig.call('quirky.handoff/probe', { source: { session: s.id } })).toEqual({
      verdict: 'usable',
      path,
      reason: null,
      candidate: 'reported'
    })
  })
})

describe('SC-26: a stale path is recovered by session id', () => {
  test('finds the file for the provider session id in another project folder', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    const found = rig.claudeTranscript('another-project', 'abc')
    await rig.reportTranscript(s.id, 'abc', join(rig.userHome, '.claude/projects/w/abc.jsonl'))
    const result = await preview({ source: { session: s.id }, controls: noRepo })
    expect(result.probe).toMatchObject({ verdict: 'usable', path: found, candidate: 'session-id' })
    expect(result.brief).toContain(found)
  })
})

describe('SC-27: an earlier path of the same session is used', () => {
  test('reported P1 (exists) then P2 (not written yet) uses P1', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    const first = rig.claudeTranscript('w', 'first')
    await rig.reportTranscript(s.id, 'first', first)
    await rig.reportTranscript(s.id, 'second', join(rig.userHome, '.claude/projects/w/second.jsonl'))
    const result = await preview({ source: { session: s.id }, controls: noRepo })
    expect(result.probe).toMatchObject({ verdict: 'usable', path: first, candidate: 'history' })
    expect(result.brief).toContain(first)
  })
})

describe('SC-28: the Claude project scan picks the newest file, unless two are close', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 27, 10, minutes))

  test('(a) files twenty minutes apart pick the newer', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    const project = projectOf(await cwdOf(s.id))
    rig.claudeTranscript(project, 'old', at(0))
    const newer = rig.claudeTranscript(project, 'new', at(20))
    const result = await preview({ source: { session: s.id }, controls: noRepo })
    rig.setHistory([])
    expect(result.probe).toMatchObject({ verdict: 'usable', path: newer, candidate: 'project-scan' })
  })

  test('(b) files two minutes apart are withheld as ambiguous', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    const project = projectOf(await cwdOf(s.id))
    rig.claudeTranscript(project, 'a', at(18))
    rig.claudeTranscript(project, 'b', at(20))
    rig.setHistory(['fallback output'])
    const result = await preview({ source: { session: s.id }, controls: noRepo })
    expect(result.probe).toMatchObject({ verdict: 'none', path: null, reason: 'ambiguous' })
    expect(result.brief).toContain('fallback output')
  })

  test('a file another live session reported is never chosen', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    const other = await rig.session('w')
    const project = projectOf(await cwdOf(s.id))
    rig.claudeTranscript(project, 'mine', at(0))
    const theirs = rig.claudeTranscript(project, 'theirs', at(30))
    await rig.reportTranscript(other.id, 'theirs', theirs)
    const result = await preview({ source: { session: s.id }, controls: noRepo })
    expect(result.probe.path).not.toBe(theirs)
    expect(result.probe).toMatchObject({ verdict: 'usable', candidate: 'project-scan' })
    expect(result.probe.path!.endsWith('mine.jsonl')).toBe(true)
  })
})

describe('SC-29: a path outside the agent root is unverifiable, and a capture travels', () => {
  test('warns, stays Focused and inlines the bounded capture instead of a path', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    const outside = join(makeTempDir('qho-out-'), 'elsewhere.jsonl')
    writeFileSync(outside, '{}\n')
    await rig.reportTranscript(s.id, 'abc', outside)
    rig.setHistory(['$ make test', 'ok'])
    const result = await preview({ source: { session: s.id }, controls: noRepo })
    expect(result.probe.verdict).toBe('unverifiable')
    expect(result.warnings).toContainEqual({
      code: 'transcript-unverifiable',
      message: 'The transcript could not be verified on the target. A bounded capture will be used when available.'
    })
    expect(result.brief).toContain('```text\n$ make test\nok\n```')
    expect(result.brief).not.toContain(outside)
  })
})

describe('SC-30: a reported transcript that does not exist is unreachable', () => {
  test('warns and the capture travels', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    await rig.reportTranscript(s.id, 'abc', join(rig.userHome, '.claude/projects/w/missing.jsonl'))
    rig.setHistory(['last words'])
    const result = await preview({ source: { session: s.id }, controls: noRepo })
    expect(result.probe.verdict).toBe('unreachable')
    expect(result.warnings).toContainEqual({
      code: 'transcript-unreachable',
      message: 'The transcript is not reachable from the target. A bounded capture will be used when available.'
    })
    expect(result.brief).toContain('last words')
  })
})

describe('SC-31: the capture is bounded and clean', () => {
  test('50,000 characters with colour escapes keep the last 36,000 and say 14000 were dropped', async () => {
    const plain = Array.from({ length: 500 }, (_, i) => `${String(i).padStart(3, '0')}${'x'.repeat(96)}`)
    plain[499] += 'x'
    expect(plain.join('\n').length).toBe(50_000)
    plain.push('')
    const lines = plain.map((line, i) => (i % 2 === 0 ? `\u001b[31m${line}\u001b[0m` : `\u001b]0;title\u0007${line}`))
    const capture = await readCapture(async () => ({ lines, cursor: null }), 's_1')
    const visible = plain.join('\n').trimEnd()
    expect(capture).toBe(`[Earlier terminal output omitted: 14000 characters]\n${visible.slice(14_000)}`)
    expect(capture).not.toContain('\u001b')
  })

  test('through the daemon: pages older history until 800 lines and cuts to the last 36,000 characters', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    const page = Array.from({ length: 40 }, (_, i) => `\u001b[32m${String(i).padStart(2, '0')}${'y'.repeat(57)}\u001b[0m`)
    rig.setHistory(page, 'older')
    const result = await preview({ source: { session: s.id }, controls: noRepo })
    const plain = page.map((line) => line.replace(/\u001b\[[0-9;]*m/g, ''))
    const visible = Array.from({ length: 20 }, () => plain).flat().join('\n')
    const kept = result.brief.split('```text\n')[1]!.split('\n```')[0]!
    expect(kept).toBe(`[Earlier terminal output omitted: ${visible.length - 36_000} characters]\n${visible.slice(visible.length - 36_000)}`)
    expect(result.brief).not.toContain('\u001b')
  })
})

describe('SC-32: an archived source with no transcript travels on notes alone', () => {
  const archived = { agent: 'codex', providerSessionId: 'X', lastMessage: 'Half the migration is done' }

  test('warns, uses the fallback base and allows Start', async () => {
    rig = await HandoffRig.start()
    const result = await preview({ source: { archived }, controls: {} })
    expect(result.warnings.map((warning) => warning.message)).toEqual([
      'This source has no live pane. Idle waiting and live scrollback recapture are unavailable.',
      'No transcript context will travel. The brief uses repository state, status hints, and your note only.'
    ])
    expect(result.brief).toBe(
      'Continue work from the prior Quirky session.\nSource: codex session\n\nLatest Quirky status hints:\n- Last assistant update: Half the migration is done'
    )
    expect(result.live).toBe(false)
    expect(result.busy).toBe(false)
    expect(result.contextAvailable).toBe(true)
  })

  test('an archived source with no transcript, prompt or message is refused with no-context', async () => {
    rig = await HandoffRig.start()
    const error = await rig.failure('quirky.handoff/preview', {
      source: { archived: { agent: 'codex', providerSessionId: 'X' } },
      controls: {}
    })
    expect(error.data).toEqual({ reason: 'no-context' })
    expect(error.message).toBe('No session context is available to continue in a new session.')
  })

  test('a transcript path is enough, and the probe reads it under the agent root', async () => {
    rig = await HandoffRig.start()
    const path = rig.codexTranscript('X')
    const result = await preview({ source: { archived: { agent: 'codex', providerSessionId: 'X', transcriptPath: path } }, controls: noRepo })
    expect(result.probe).toMatchObject({ verdict: 'usable', path })
    expect(result.brief).toContain(path)
    expect(result.warnings.map((warning) => warning.code)).toEqual(['no-live-pane'])
  })

  test('an archived source in a known worktree gets that worktrees repository state and destinations', async () => {
    rig = await HandoffRig.start()
    const w = await rig.worktree('w')
    rig.status([{ path: 'x.ts', area: 'unstaged', status: 'modified' }])
    const source = { archived: { ...archived, worktree: w.id } }
    const result = await preview({ source, controls: {} })
    expect(result.brief).toContain('## Repository state\nBranch: feature')
    const prepared = (await rig.call('quirky.handoff/prepare', { source })) as { controls: { target: unknown }; canCreateWorktree: boolean }
    expect(prepared.controls.target).toEqual({ worktree: w.id })
    expect(prepared.canCreateWorktree).toBe(true)
  })
})

describe('SC-34: Capture anyway recaptures now', () => {
  test('the capture from opening is kept until a recapture is asked for', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    rig.setHistory(['first output'])
    await rig.startTurn(s.id, 'long job')
    await rig.call('quirky.handoff/prepare', { source: { session: s.id } })
    rig.setHistory(['first output', 'newer output'])
    const kept = await preview({ source: { session: s.id }, controls: noRepo })
    expect(kept.busy).toBe(true)
    expect(kept.brief).not.toContain('newer output')
    const again = await preview({ source: { session: s.id }, controls: { note: 'x', ...noRepo } })
    expect(again.brief).not.toContain('newer output')
    const fresh = await preview({ source: { session: s.id }, controls: noRepo, recapture: true })
    expect(fresh.brief).toContain('first output\nnewer output')
    const after = await preview({ source: { session: s.id }, controls: noRepo })
    expect(after.brief).toContain('newer output')
  })

  test('opening again takes a new capture, and going idle clears busy', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    rig.setHistory(['one'])
    await rig.startTurn(s.id, 'job')
    await rig.call('quirky.handoff/prepare', { source: { session: s.id } })
    rig.setHistory(['one', 'two'])
    await rig.stop(s.id, 'done')
    await rig.call('quirky.handoff/prepare', { source: { session: s.id } })
    const result = await preview({ source: { session: s.id }, controls: noRepo })
    expect(result.busy).toBe(false)
    expect(result.brief).toContain('one\ntwo')
  })
})

describe('SC-35: no busy strip without a signal', () => {
  test('a session with no agent status row is not busy', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    rig.setHistory(['output'])
    const prepared = (await rig.call('quirky.handoff/prepare', { source: { session: s.id } })) as { source: { busy: boolean } }
    expect(prepared.source.busy).toBe(false)
    expect((await preview({ source: { session: s.id }, controls: noRepo })).busy).toBe(false)
  })
})
