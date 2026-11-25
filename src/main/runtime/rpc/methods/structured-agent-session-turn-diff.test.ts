import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session-journal-types'
import { snapshotWorkspaceTree } from '../../../git/turn-tree-snapshot'
import { readTurnDiff, TURN_DIFF_MAX_BYTES } from './structured-agent-session-turn-diff'

describe('agentSession.turnDiff', () => {
  const temps: string[] = []

  afterEach(() => {
    for (const path of temps.splice(0)) {
      rmSync(path, { recursive: true, force: true })
    }
  })

  async function twoTurnRepo(second: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'quirky-turn-diff-'))
    temps.push(dir)
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    git('init', '--quiet')
    git('config', 'user.name', 'Quirky Test')
    git('config', 'user.email', 'quirky@example.test')
    writeFileSync(join(dir, 'app.ts'), 'one\n')
    git('add', 'app.ts')
    git('commit', '--quiet', '-m', 'base')
    const from = await snapshotWorkspaceTree(dir)
    for (const [name, content] of Object.entries(second)) {
      writeFileSync(join(dir, name), content)
    }
    const to = await snapshotWorkspaceTree(dir)
    if (!('tree' in from) || !('tree' in to)) {
      throw new Error('snapshot failed')
    }
    return { dir, fromTree: from.tree, toTree: to.tree }
  }

  function sourceOf(body: AgentJournalItemBody | null, directory: string | null) {
    return {
      itemBody: async () => body,
      directory: async () => directory
    }
  }

  function changesBody(
    fromTree: string,
    toTree: string,
    files: { path: string; status: 'modified' | 'added' }[]
  ): AgentJournalItemBody {
    return { kind: 'turn-changes', turnId: 't1', source: 'git-tree', fromTree, toTree, files }
  }

  it('is gone when the turn has no changes item', async () => {
    expect(await readTurnDiff(sourceOf(null, '/w'), 't1', 'app.ts')).toEqual({
      ok: false,
      reason: 'gone'
    })
  })

  it('is not-git for an edit-tools item', async () => {
    const body: AgentJournalItemBody = {
      kind: 'turn-changes',
      turnId: 't1',
      source: 'edit-tools',
      files: [{ path: 'notes.md', status: 'modified' }]
    }
    expect(await readTurnDiff(sourceOf(body, '/w'), 't1', 'notes.md')).toEqual({
      ok: false,
      reason: 'not-git'
    })
  })

  it('returns one file patch between the two trees', async () => {
    const { dir, fromTree, toTree } = await twoTurnRepo({
      'app.ts': 'one\ntwo\n',
      'other.ts': 'unrelated\n'
    })
    const body = changesBody(fromTree, toTree, [
      { path: 'app.ts', status: 'modified' },
      { path: 'other.ts', status: 'added' }
    ])

    const result = await readTurnDiff(sourceOf(body, dir), 't1', 'app.ts')

    expect(result).toMatchObject({ ok: true, truncated: false })
    expect(result.ok && result.patch).toContain('+two')
    expect(result.ok && result.patch).not.toContain('unrelated')
  })

  it('is gone when the trees are no longer in the object store', async () => {
    const { dir } = await twoTurnRepo({ 'app.ts': 'two\n' })
    const missing = 'a'.repeat(40)
    const body = changesBody(missing, 'b'.repeat(40), [{ path: 'app.ts', status: 'modified' }])

    expect(await readTurnDiff(sourceOf(body, dir), 't1', 'app.ts')).toEqual({
      ok: false,
      reason: 'gone'
    })
  })

  it('fails when the workspace directory is unknown', async () => {
    const body = changesBody('a'.repeat(40), 'b'.repeat(40), [])
    expect(await readTurnDiff(sourceOf(body, null), 't1', 'app.ts')).toEqual({
      ok: false,
      reason: 'failed'
    })
  })

  it('caps a large patch at 512 KiB and says so', async () => {
    const big = Array.from({ length: 60_000 }, (_, index) => `line ${index} of a big file`).join(
      '\n'
    )
    const { dir, fromTree, toTree } = await twoTurnRepo({ 'big.txt': big })
    const body = changesBody(fromTree, toTree, [{ path: 'big.txt', status: 'added' }])

    const result = await readTurnDiff(sourceOf(body, dir), 't1', 'big.txt')

    expect(result).toMatchObject({ ok: true, truncated: true })
    expect(result.ok && Buffer.byteLength(result.patch)).toBeLessThanOrEqual(TURN_DIFF_MAX_BYTES)
    expect(result.ok && result.patch.startsWith('diff --git')).toBe(true)
  })

  it('reads a path with pathspec characters literally', async () => {
    const { dir, fromTree, toTree } = await twoTurnRepo({ 'a*.ts': 'star\n', 'ab.ts': 'plain\n' })
    const body = changesBody(fromTree, toTree, [
      { path: 'a*.ts', status: 'added' },
      { path: 'ab.ts', status: 'added' }
    ])

    const result = await readTurnDiff(sourceOf(body, dir), 't1', 'a*.ts')

    expect(result.ok && result.patch).toContain('+star')
    expect(result.ok && result.patch).not.toContain('plain')
  })
})
