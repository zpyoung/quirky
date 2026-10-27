import { afterEach, describe, expect, test } from 'bun:test'
import { runCli, type CliResult } from '../../../packages/cli/test/fixtures/fake-daemon'
import { HandoffRig } from './support'

let rig: HandoffRig
afterEach(async () => {
  await rig?.cleanup()
  rig = undefined as unknown as HandoffRig
})

const cli = (...args: string[]): Promise<CliResult> => runCli(['handoff', ...args], { home: rig.h.home })

async function json(...args: string[]) {
  const result = await cli(...args, '--json')
  expect(result.stderr).toBe('')
  expect(result.code).toBe(0)
  return JSON.parse(result.stdout)
}

describe('SC-2: no context, no dialog (CLI)', () => {
  test('preview exits non-zero with reason no-context', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    rig.setHistory([])
    const result = await cli('preview', s.id, '--json')
    expect(result.code).toBe(1)
    const { error } = JSON.parse(result.stdout)
    expect(error).toMatchObject({
      message: 'No session context is available to continue in a new session.',
      reason: 'no-context'
    })
    const text = await cli('preview', s.id)
    expect(text.code).toBe(1)
    expect(text.stdout).toBe('')
    expect(text.stderr).toBe('quirky: No session context is available to continue in a new session.\n')
  })
})

describe('SC-4: the preview brief has the base, repo state and note in order (CLI)', () => {
  test('--json carries the brief, cost, warnings and secret hits, and the notice apart', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('feature')
    const transcript = rig.claudeTranscript('feature', 'abc')
    await rig.reportTranscript(s.id, 'abc', transcript)
    await rig.turn(s.id, 'fix the parser', 'Parser fixed; tests pending')
    rig.status([{ path: 'src/parse.ts', area: 'unstaged', status: 'modified' }])
    const result = await json('preview', s.id, '--note', 'Run the tests first')
    const order = ['Continue work from the prior Quirky session.', '## Repository state', '## Operator steering note'].map((part) =>
      result.brief.indexOf(part)
    )
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(result.brief).toContain('- Last user prompt: fix the parser\n- Last assistant update: Parser fixed; tests pending')
    expect(result.brief).toContain(`\`\`\`text\n${transcript}\n\`\`\``)
    expect(result.brief).toContain('unstaged: modified src/parse.ts')
    expect(result.brief).toContain('```text\nRun the tests first\n```')
    expect(result).toMatchObject({ characters: result.brief.length, warnings: [], secrets: [], repoState: 'ok', busy: false, live: true })
    expect(result.tokens).toBeGreaterThan(0)
    expect(result.notice).toStartWith('## Locked Quirky handoff notice')
    expect(result.brief).not.toContain('Locked Quirky handoff notice')
  })

  test('text mode prints the brief, the cost and the warnings', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    rig.setHistory(['some output'])
    const result = await cli('preview', s.id, '--no-repo-state', '--no-editor-tabs', '--note', 'key AKIAABCDEFGHIJKLMNOP')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Continue work from the prior Quirky session.')
    expect(result.stdout).toMatch(/\d+ characters · about \d+ tokens/)
    expect(result.stdout).toContain('warning: 1 potential secrets found. Review the inline preview markers before starting.')
  })

  test('flags choose the target, relationship, context, toggles and template', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    const w2 = await rig.worktree('w2')
    const transcript = rig.claudeTranscript('w', 'abc')
    await rig.reportTranscript(s.id, 'abc', transcript)
    const asked: string[] = []
    const status = rig.git.statusV2
    rig.git.statusV2 = async (cwd) => {
      asked.push(cwd)
      return status(cwd)
    }
    const result = await json(
      'preview', s.id, '--worktree', 'w2', '--agent', 'codex', '--relationship', 'reviews', '--context', 'full',
      '--diff-bodies', '--no-editor-tabs', '--template', 'debug-failure'
    )
    expect(result.brief).toContain('Read the whole transcript before you continue.')
    expect(result.brief).toContain('Template: Debug the failure')
    expect(result.brief).toContain('Included diff bodies:')
    expect(asked.every((cwd) => cwd !== w2.path)).toBe(true)

    const bad = await cli('preview', s.id, '--worktree', 'w2', '--new-worktree', 'x')
    expect(bad.code).toBe(2)
    const missing = await cli('preview')
    expect(missing.code).toBe(2)
    const blank = await cli('preview', s.id, '--new-worktree', ' ', '--json')
    expect(JSON.parse(blank.stdout).error).toMatchObject({ reason: 'invalid-target' })
  })
})

describe('SC-32: an archived source (CLI)', () => {
  test('preview describes the source with flags alone', async () => {
    rig = await HandoffRig.start()
    const result = await json('preview', '--source-agent', 'codex', '--provider-session', 'X', '--last-message', 'Half the migration is done')
    expect(result.live).toBe(false)
    expect(result.warnings.map((warning: { message: string }) => warning.message)).toEqual([
      'This source has no live pane. Idle waiting and live scrollback recapture are unavailable.',
      'No transcript context will travel. The brief uses repository state, status hints, and your note only.'
    ])
    expect(result.brief).toContain('Source: codex session')
    const refused = await cli('preview', '--source-agent', 'codex', '--provider-session', 'X', '--json')
    expect(JSON.parse(refused.stdout).error.reason).toBe('no-context')
    const both = await cli('preview', 's_1', '--source-agent', 'codex')
    expect(both.code).toBe(2)
  })
})

describe('SC-22: the built-in templates (CLI)', () => {
  test('list, add, edit, rm and reset', async () => {
    rig = await HandoffRig.start()
    const first = await json('templates', 'list')
    expect(first.templates.map((template: { name: string }) => template.name)).toEqual([
      'Continue implementation',
      'Review what was done',
      'Debug the failure'
    ])
    expect(first.custom).toBe(false)
    const text = await cli('templates', 'list')
    expect(text.stdout).toContain('continue-implementation  Continue implementation')

    const added = await json('templates', 'add', '--name', 'Mine', '--body', 'x')
    expect(added.templates.map((template: { name: string }) => template.name)).toEqual([
      'Continue implementation',
      'Review what was done',
      'Debug the failure',
      'Mine'
    ])
    const id = added.templates.at(-1).id
    const edited = await json('templates', 'edit', id, '--name', 'Renamed')
    expect(edited.templates.at(-1)).toEqual({ id, name: 'Renamed', body: 'x' })
    const body = await json('templates', 'edit', id, '--body', 'new body')
    expect(body.templates.at(-1)).toEqual({ id, name: 'Renamed', body: 'new body' })
    const removed = await json('templates', 'rm', id)
    expect(removed.templates).toHaveLength(3)
    await json('templates', 'add', '--name', 'Again', '--body', 'y')
    const reset = await json('templates', 'reset')
    expect(reset.custom).toBe(false)
    expect(reset.templates).toHaveLength(3)
  })

  test('refuses what the daemon refuses', async () => {
    rig = await HandoffRig.start()
    const unknown = await cli('templates', 'rm', 'nope', '--json')
    expect(unknown.code).toBe(1)
    expect(JSON.parse(unknown.stdout).error).toMatchObject({ code: 'not-found', reason: 'invalid' })
    const edit = await cli('templates', 'edit', 'nope', '--name', 'x')
    expect(edit.code).toBe(1)
    const bare = await cli('templates', 'edit', 'debug-failure')
    expect(bare.code).toBe(2)
    const duplicate = await cli('templates', 'add', '--name', 'Debug the failure', '--body', 'z')
    expect(duplicate.stdout).toContain('warning: duplicate-name')
  })

  test('the group lists preview and templates in its help', async () => {
    rig = await HandoffRig.start()
    const help = await cli('--help')
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('preview')
    expect(help.stdout).toContain('templates list')
    expect(help.stdout).toContain('templates reset')
  })
})
