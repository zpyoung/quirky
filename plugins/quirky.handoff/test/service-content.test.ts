import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GitDiff, GitStatusEntry } from '@quirky/protocol'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import type { Preview } from '../src/daemon/types'
import { HandoffRig } from './support'

let rig: HandoffRig
afterEach(async () => {
  await rig?.cleanup()
  rig = undefined as unknown as HandoffRig
})

const preview = (params: Record<string, unknown>) => rig.call('quirky.handoff/preview', params) as Promise<Preview>

/** A claude session `w` whose transcript is readable, so the base names a path and nothing else interferes. */
async function readable(): Promise<{ id: string; path: string }> {
  const s = await rig.session('w')
  const path = rig.claudeTranscript('w', 'abc')
  await rig.reportTranscript(s.id, 'abc', path)
  return { id: s.id, path }
}

const entry = (path: string, area: GitStatusEntry['area'], status: GitStatusEntry['status'], extra: Partial<GitStatusEntry> = {}): GitStatusEntry => ({
  path,
  area,
  status,
  ...extra
})

const textDiff = (path: string, staged: boolean, original: string, modified: string): GitDiff => ({
  path,
  staged,
  original,
  modified,
  binary: false,
  source: staged ? 'staged' : 'unstaged',
  kind: 'text'
})

describe('SC-13: Full transcript needs a usable transcript', () => {
  test('(a) a usable transcript makes the base read the whole transcript', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    const focused = await preview({ source: { session: id }, controls: { context: 'focused' } })
    const full = await preview({ source: { session: id }, controls: { context: 'full' } })
    expect(focused.brief).toContain('Read only the parts you need from it')
    expect(full.brief).toContain('Read the whole transcript before you continue.')
    expect(full.warnings.map((warning) => warning.code)).not.toContain('full-unavailable')
  })

  test('(b) an unverifiable transcript keeps Focused with the full-unavailable warning', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    const outside = join(makeTempDir('qho-out-'), 'elsewhere.jsonl')
    writeFileSync(outside, '{}\n')
    await rig.reportTranscript(s.id, 'abc', outside)
    rig.setHistory(['some output'])
    const full = await preview({ source: { session: s.id }, controls: { context: 'full' } })
    expect(full.probe.verdict).toBe('unverifiable')
    expect(full.brief).not.toContain('Read the whole transcript')
    expect(full.warnings).toContainEqual({
      code: 'full-unavailable',
      message: 'A full saved transcript could not be verified on this target. Focused context will be used.'
    })
  })

  test('(c) an unreachable transcript keeps Focused with the not-reachable wording', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    await rig.reportTranscript(s.id, 'abc', join(rig.userHome, '.claude/projects/w/missing.jsonl'))
    rig.setHistory(['some output'])
    const full = await preview({ source: { session: s.id }, controls: { context: 'full' } })
    expect(full.probe.verdict).toBe('unreachable')
    expect(full.warnings).toContainEqual({
      code: 'full-unavailable',
      message: 'A full saved transcript is not reachable on this target. Focused context will be used.'
    })
  })

  test('reopening always starts Focused, even from a draft that chose Full', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    const base = ((await rig.call('quirky.handoff/prepare', { source: { session: id } })) as { controls: Record<string, unknown> }).controls
    await rig.call('quirky.handoff/draft', { source: { session: id }, draft: { controls: { ...base, context: 'full' }, preview: null } })
    const reopened = (await rig.call('quirky.handoff/prepare', { source: { session: id } })) as { controls: { context: string } }
    expect(reopened.controls.context).toBe('focused')
  })
})

describe('SC-14: repository lines cover staged, unstaged, untracked and renames', () => {
  test('lists each area and the changed paths', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    rig.status([
      entry('b.ts', 'staged', 'renamed', { oldPath: 'a.ts' }),
      entry('c.ts', 'unstaged', 'modified'),
      entry('d.ts', 'untracked', 'untracked')
    ])
    const result = await preview({ source: { session: id }, controls: {} })
    expect(result.brief).toContain(
      '## Repository state\nBranch: feature\nGit status:\nstaged: renamed a.ts -> b.ts\nunstaged: modified c.ts\nuntracked: untracked d.ts\nChanged file paths:\nb.ts\nc.ts\nd.ts'
    )
  })

  test('a clean tree reads Clean working tree.', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    rig.status([])
    const result = await preview({ source: { session: id }, controls: {} })
    expect(result.brief).toContain('Git status:\nClean working tree.\nChanged file paths:')
  })

  test('a folder workspace source has no repository block and no git call', async () => {
    rig = await HandoffRig.start()
    const folder = await rig.folder('notes')
    const s = (await rig.call('quirky.session/create', { worktree: folder.workspace.id, agent: 'claude' })) as { id: string }
    rig.setHistory(['output'])
    const result = await preview({ source: { session: s.id }, controls: {} })
    expect(result.brief).not.toContain('## Repository state')
    expect(result.repoState).toBe('none')
    expect(rig.git.calls.filter((call) => call.fn === 'statusV2')).toEqual([])
  })
})

describe('SC-15: diff bodies are opt-in, per file, and capped', () => {
  function seedDiffs(count: number) {
    const entries = [
      entry('c.ts', 'unstaged', 'modified'),
      entry('logo.png', 'unstaged', 'modified', { binary: true }),
      ...Array.from({ length: count }, (_, i) => entry(`f${i}.ts`, 'unstaged', 'modified'))
    ]
    rig.status(entries)
    const fetched: string[] = []
    rig.git.diffSource = async (_cwd, request) => {
      fetched.push(request.path)
      if (request.path === 'logo.png') {
        return { path: 'logo.png', staged: false, original: '', modified: '', binary: true, source: 'unstaged', kind: 'binary' }
      }
      return textDiff(request.path, false, `old ${request.path} `.repeat(30), `new ${request.path} `.repeat(30))
    }
    return fetched
  }

  test('bodies are per file, binary files are omitted and the section stops at 12,000 characters', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    const fetched = seedDiffs(60)
    const result = await preview({
      source: { session: id },
      controls: { include: { repoState: true, diffBodies: true, openEditorTabs: false } }
    })
    expect(result.brief).toContain('### unstaged: modified c.ts\n--- before\nold c.ts ')
    expect(result.brief).toContain('\n+++ after\nnew c.ts ')
    expect(result.brief).toContain('### unstaged: modified logo.png\n[binary diff omitted]')
    const bodies = result.brief.slice(result.brief.indexOf('Included diff bodies:\n') + 'Included diff bodies:\n'.length)
    expect(bodies.indexOf('\n[Diff bodies truncated at 12000 characters.]')).toBe(12_000)
    expect(result.warnings).toContainEqual({
      code: 'diff-truncated',
      message: 'Some repository state was cut and will not travel in full.'
    })
    expect(fetched.length).toBeLessThan(62)
  })

  test('with repo state off, diff bodies are off and nothing is fetched', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    const fetched = seedDiffs(3)
    const result = await preview({
      source: { session: id },
      controls: { include: { repoState: false, diffBodies: true, openEditorTabs: false } }
    })
    expect(result.brief).not.toContain('Included diff bodies')
    expect(result.brief).not.toContain('## Repository state')
    expect(result.repoState).toBe('off')
    expect(fetched).toEqual([])
  })

  test('diff bodies stay out unless asked for', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    const fetched = seedDiffs(3)
    const result = await preview({ source: { session: id }, controls: {} })
    expect(result.brief).not.toContain('Included diff bodies')
    expect(fetched).toEqual([])
  })
})

describe('SC-16: a capped status list says more were omitted', () => {
  test('ends the status lines with the omitted note and warns', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    rig.status([entry('a.ts', 'unstaged', 'modified'), entry('b.ts', 'unstaged', 'modified')], { capped: true })
    const result = await preview({ source: { session: id }, controls: {} })
    expect(result.brief).toContain('unstaged: modified b.ts\n... additional changes omitted.\nChanged file paths:')
    expect(result.warnings.map((warning) => warning.code)).toContain('diff-truncated')
  })
})

describe('SC-17: a repo-state failure does not block', () => {
  test('warns, leaves the repository block out and still composes', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    rig.git.statusV2 = async () => {
      throw new Error('git is unavailable')
    }
    const result = await preview({ source: { session: id }, controls: {} })
    expect(result.repoState).toBe('failed')
    expect(result.warnings).toContainEqual({
      code: 'repo-state-failed',
      message: 'Could not refresh repository state. The handoff can still continue.'
    })
    expect(result.brief).not.toContain('## Repository state')
    expect(result.brief).toContain('Continue work from the prior Quirky session.')
    expect(result.contextAvailable).toBe(true)
  })
})

describe('SC-18: open editor tabs come from the editor when it runs', () => {
  test('(a) with no editor plugin the block is left out', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    const result = await preview({ source: { session: id }, controls: {} })
    expect(result.brief).not.toContain('## Open editor tabs')
  })

  test('(b) a fake editor reports open tabs relative to the worktree', async () => {
    rig = await HandoffRig.start({ editor: ['src/a.ts', 'README.md'] })
    const { id } = await readable()
    const result = await preview({ source: { session: id }, controls: {} })
    expect(result.brief).toContain('## Open editor tabs\nsrc/a.ts\nREADME.md')
    expect(result.brief).not.toContain('/outside/the/worktree.ts')
    const off = await preview({ source: { session: id }, controls: { include: { repoState: true, diffBodies: false, openEditorTabs: false } } })
    expect(off.brief).not.toContain('## Open editor tabs')
  })

  test('(c) the real editor lists open tabs, deduplicates buffers and omits closed edits', async () => {
    rig = await HandoffRig.start({ realEditor: true })
    const { id } = await readable()
    const worktree = rig.worktrees.w!
    const activePath = 'src/active.ts'
    const closedPath = 'src/closed.ts'
    rig.writeFile(join(worktree.path, activePath))
    rig.writeFile(join(worktree.path, closedPath))

    const active = await rig.call('quirky.editor/open', {
      worktree: worktree.id,
      path: activePath,
      mode: 'source',
      focus: false
    }) as { id: string }
    const previewTab = await rig.call('quirky.editor/open', {
      worktree: worktree.id,
      path: activePath,
      mode: 'preview',
      focus: false
    }) as { id: string }
    expect(previewTab.id).toBe(active.id)

    const closed = await rig.call('quirky.editor/open', {
      worktree: worktree.id,
      path: closedPath,
      mode: 'source',
      focus: false
    }) as { id: string; openedTabId: string }
    const opened = await preview({ source: { session: id }, controls: {} })
    expect(opened.brief).toContain('## Open editor tabs\nsrc/active.ts\nsrc/closed.ts')

    expect(await rig.call('quirky.editor/close', { bufferId: closed.id, tabId: closed.openedTabId })).toEqual({ closed: true })
    const afterClose = await preview({ source: { session: id }, controls: {} })
    expect(afterClose.brief).toContain('## Open editor tabs\nsrc/active.ts')
    expect(afterClose.brief).not.toContain('src/closed.ts')
  })
})

describe('SC-19: a template variables are filled', () => {
  test('a variable whose data was not included reads as a sentence saying so', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    const added = (await rig.call('quirky.handoff/templateMutate', {
      op: 'add',
      template: { name: 'Triage', body: 'Status: {{gitStatus}} / {{CHANGED_PATHS}} / {{openEditorTabs}}' }
    })) as { templates: { id: string; name: string }[] }
    const triage = added.templates.find((template) => template.name === 'Triage')!
    const result = await preview({
      source: { session: id },
      controls: { templateId: triage.id, include: { repoState: false, diffBodies: false, openEditorTabs: true } }
    })
    expect(result.brief).toContain(
      '## Selected handoff template\nTemplate: Triage\n```text\nStatus: No git status was included. / No changed paths were included. / No open editor tabs were included.\n```'
    )
  })

  test('a built-in fills its variables from the repository', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    rig.status([entry('c.ts', 'unstaged', 'modified')])
    const result = await preview({ source: { session: id }, controls: { templateId: 'review-completed-work' } })
    expect(result.brief).toContain('Template: Review what was done')
    expect(result.brief).toContain('Changed paths:\nc.ts\nLook for bugs')
  })
})

describe('SC-20: user text is fenced past its own backticks', () => {
  test('a note with a run of five backticks sits in a fence of at least six', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    const result = await preview({ source: { session: id }, controls: { note: 'before\n`````\nafter' } })
    expect(result.brief).toContain('## Operator steering note\n``````text\nbefore\n`````\nafter\n``````')
  })
})

describe('SC-37: a detached preview is analyzed as edited', () => {
  test('body is returned as the brief, with its own cost and secrets, whatever the controls say', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    const edited = 'My own brief.\nkey AKIAABCDEFGHIJKLMNOP end'
    const first = await preview({ source: { session: id }, controls: {}, body: edited })
    const afterChange = await preview({ source: { session: id }, controls: { note: 'a new note', context: 'full' }, body: edited })
    for (const result of [first, afterChange]) {
      expect(result.brief).toBe(edited)
      expect(result.characters).toBe(edited.length)
      expect(result.secrets.map((hit) => hit.excerpt)).toEqual(['AKIA…'])
      expect(result.secrets[0]).toMatchObject({ start: edited.indexOf('AKIA'), end: edited.indexOf('AKIA') + 20 })
      expect(result.notice.startsWith('## Locked Quirky handoff notice')).toBe(true)
      expect(result.brief).not.toContain(result.notice)
    }
    const attached = await preview({ source: { session: id }, controls: { note: 'a new note' } })
    expect(attached.brief).not.toBe(edited)
    expect(attached.secrets).toEqual([])
  })

  test('warnings in a detached preview still come from the controls and the probe', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    rig.setHistory(['output'])
    const result = await preview({ source: { session: s.id }, controls: { context: 'full' }, body: 'edited' })
    expect(result.warnings.map((warning) => warning.code)).toContain('full-unavailable')
  })
})

describe('SC-38: the notice is separate', () => {
  test('the composed text never carries the locked notice', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    const result = await preview({ source: { session: id }, controls: { note: 'x' } })
    expect(result.brief).not.toContain('Locked Quirky handoff notice')
    expect(result.notice).toContain('untrusted reference data')
  })
})

describe('SC-39: likely secrets are flagged and never block', () => {
  test('two hits in text order, with excerpts and the banner count', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    const result = await preview({
      source: { session: id },
      controls: { note: 'use AKIAABCDEFGHIJKLMNOP and api_key=abcdefghijklmnop1234' }
    })
    expect(result.secrets.map((hit) => [hit.rule, hit.excerpt])).toEqual([
      ['aws-access-key-id', 'AKIA…'],
      ['env-assignment', 'api_…']
    ])
    expect(result.secrets[0]!.start).toBeLessThan(result.secrets[1]!.start)
    expect(result.brief.slice(result.secrets[0]!.start, result.secrets[0]!.end)).toBe('AKIAABCDEFGHIJKLMNOP')
    expect(result.warnings).toContainEqual({
      code: 'secrets',
      message: '2 potential secrets found. Review the inline preview markers before starting.'
    })
    expect(result.contextAvailable).toBe(true)
  })
})

describe('SC-41: the cost readout weighs prose, code and diffs', () => {
  test('1450 characters come to about 300 tokens', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    const line = (chars: number, make: (length: number) => string) => make(chars - 1)
    const diff = [100, 100, 100, 50].map((chars) => line(chars, (n) => `+${'d'.repeat(n - 1)}`))
    const code = [150, 150, 150].map((chars) => line(chars, (n) => 'c'.repeat(n)))
    const prose = [200, 200, 200].map((chars) => line(chars, (n) => 'p'.repeat(n)))
    const body = [...diff, '```', ...code, '```', ...prose, 'e'.repeat(42)].join('\n')
    const result = await preview({ source: { session: id }, controls: {}, body })
    expect(result.characters).toBe(1450)
    expect(result.tokens).toBe(300)
  })
})

describe('SC-42: Start is disabled until the dialog can start (content side)', () => {
  test('a brief with nothing in it reports contextAvailable false', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    await rig.reportTranscript(s.id, 'gone', join(rig.userHome, '.claude/projects/w/gone.jsonl'))
    rig.setHistory([])
    const result = await preview({
      source: { session: s.id },
      controls: { include: { repoState: false, diffBodies: false, openEditorTabs: false } }
    })
    expect(result.probe.verdict).toBe('unreachable')
    expect(result.contextAvailable).toBe(false)
    expect(result.warnings.map((warning) => warning.code)).toContain('no-context')
  })

  test('a detached preview takes contextAvailable and the no-context warning from the edited body', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    await rig.reportTranscript(s.id, 'gone', join(rig.userHome, '.claude/projects/w/gone.jsonl'))
    rig.setHistory([])
    const bare = { include: { repoState: false, diffBodies: false, openEditorTabs: false } }
    const written = await preview({ source: { session: s.id }, controls: bare, body: 'My own brief.' })
    expect(written.contextAvailable).toBe(true)
    expect(written.warnings.map((warning) => warning.code)).not.toContain('no-context')

    const { id } = await readable()
    const blank = await preview({ source: { session: id }, controls: {}, body: '  \n ' })
    expect(blank.contextAvailable).toBe(false)
    expect(blank.warnings.map((warning) => warning.code)).toContain('no-context')
  })

  test('a note or repository state gives the brief something to send', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    await rig.reportTranscript(s.id, 'gone', join(rig.userHome, '.claude/projects/w/gone.jsonl'))
    rig.setHistory([])
    const noted = await preview({
      source: { session: s.id },
      controls: { note: 'do the thing', include: { repoState: false, diffBodies: false, openEditorTabs: false } }
    })
    expect(noted.contextAvailable).toBe(true)
    expect((await preview({ source: { session: s.id }, controls: {} })).contextAvailable).toBe(true)
  })

  test('a new worktree with a blank name is an invalid target', async () => {
    rig = await HandoffRig.start()
    const { id } = await readable()
    const error = await rig.failure('quirky.handoff/preview', { source: { session: id }, controls: { target: { create: { name: '' } } } })
    expect(error.data).toEqual({ reason: 'invalid-target' })
  })
})
