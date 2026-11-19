import { afterEach, expect, test } from 'bun:test'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { byLabel, click, q, qa, rowOf, text } from './dom'
import { boot, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
afterEach(shutdown)

type Added = { id: string }

/** NA-10's notes: two on math.ts (unstaged), util.ts 2-4 (staged), README.md 1 (committed on the branch), gone.ts 3 (nowhere). */
async function setUp(w: World): Promise<void> {
  w.commit({ 'README.md': 'one\ntwo\nthree\n' }, 'readme')
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  w.write('util.ts', 'one\ntwo\nthree\nfour\nfive\n')
  w.git('add', 'util.ts')
  for (const [key, path, startLine, line] of [
    ['readme', 'README.md', 1, 1],
    ['gone', 'gone.ts', 3, 3],
    ['math5', 'math.ts', 5, 5],
    ['math30', 'math.ts', 30, 30],
    ['util', 'util.ts', 2, 4]
  ] as const) {
    const { note } = (await w.agent.callAny('quirky.git/addNote', { worktree: w.feat.id, path, startLine, line, body: `Note ${key}` })) as { note: Added }
    expect(note.id).toBeTruthy()
  }
}

test('NA-9, NA-13: rows carry the note counts from a real daemon, and the panel has no shelf', async () => {
  const w = await boot(scratch)
  expect(q('section[aria-label="Notes"]')).toBeNull()
  await setUp(w)

  await w.win.waitFor(() => q('[data-note-count]', rowOf('math.ts') ?? document.body))
  expect(text(q('[data-note-count]', rowOf('math.ts')!))).toBe('✎2')
  await w.win.waitFor(() => rowOf('util.ts', 'staged') && rowOf('README.md', 'branch'))
  expect(text(q('[data-note-count]', rowOf('util.ts')!))).toBe('✎1')
  expect(text(q('[data-note-count]', rowOf('README.md')!))).toBe('✎1')
  expect(rowOf('gone.ts')).toBeNull()
  expect(q('section[aria-label="Notes"]')).toBeNull()
  expect(q('[data-note-row]')).toBeNull()

  await click(byLabel('More source control actions'))
  expect(qa('[role="menuitem"]').map(text)).not.toContain('Notes 5')

  await w.agent.callAny('quirky.git/clearNotes', { worktree: w.feat.id, yes: true })
  await w.win.waitFor(() => q('[data-note-count]') === null)
  expect(w.problems()).toEqual([])
}, SLOW)
