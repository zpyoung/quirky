import { describe, expect, test } from 'bun:test'
import {
  PALETTE_SCOPES,
  cycleScope,
  decodeFileId,
  encodeFileId,
  entryKey,
  rankPaletteEntries,
  fileEntry,
  filterScope,
  paletteKey,
  paletteSections,
  resolveRecents,
  searchesFiles,
  type PaletteEntry
} from '../src/plugins/palette'

const entries: PaletteEntry[] = [
  { id: 'acme/one', title: 'One', kind: 'command' },
  { id: 'acme/two', title: 'Two', kind: 'command' },
  { id: 'acme/tool', title: 'Tool', kind: 'tool', icon: 'terminal-window', hue: 'teal' },
  { id: 'acme/page', title: 'Page', kind: 'view' },
  { id: '/wt/a', title: 'alpha', kind: 'worktree' },
  { id: '/wt/b', title: 'beta', kind: 'worktree' }
]
const worktreeIds = new Set(['/wt/a', '/wt/b'])
const keys = (list: readonly PaletteEntry[]) => list.map(entryKey)

describe('scope filter', () => {
  test('each scope keeps only its kinds', () => {
    const withFile = [...entries, fileEntry('/wt/a', 'src/a.ts')]
    expect(filterScope(withFile, 'all')).toHaveLength(withFile.length)
    expect(filterScope(withFile, 'worktrees').map((entry) => entry.kind)).toEqual(['worktree', 'worktree'])
    expect(filterScope(withFile, 'commands').map((entry) => entry.kind)).toEqual(['command', 'command'])
    expect(filterScope(withFile, 'files').map((entry) => entry.kind)).toEqual(['file'])
  })

  test('only All and Files search files', () => {
    expect(PALETTE_SCOPES.filter((scope) => searchesFiles(scope.id)).map((scope) => scope.id)).toEqual(['all', 'files'])
  })

  test('cycling wraps in both directions', () => {
    expect(cycleScope('all', 1)).toBe('worktrees')
    expect(cycleScope('files', 1)).toBe('all')
    expect(cycleScope('all', -1)).toBe('files')
    expect(cycleScope('commands', -1)).toBe('worktrees')
  })
})

describe('file ids', () => {
  test('round trip a worktree and path with separators and unicode', () => {
    for (const [worktree, path] of [['/work/tree', 'src/a b/ü.ts'], ['wt:1', 'a/b/c%20d.md']] as const) {
      expect(decodeFileId(encodeFileId(worktree, path))).toEqual({ worktree, path })
    }
  })

  test('malformed ids decode to null', () => {
    expect(decodeFileId('no-separator')).toBeNull()
    expect(decodeFileId('a/b/c')).toBeNull()
    expect(decodeFileId('/x')).toBeNull()
    expect(decodeFileId('%E0%A4%A/path')).toBeNull()
  })

  test('a file entry is titled by its name and described by its path', () => {
    expect(fileEntry('/wt/a', 'src/deep/file.ts')).toMatchObject({ title: 'file.ts', description: 'src/deep/file.ts', kind: 'file' })
  })
})

describe('recents', () => {
  test('resolve in stored order and skip targets that no longer exist', () => {
    const resolved = resolveRecents(['worktree:/wt/b', 'command:acme/gone', 'command:acme/one', 'worktree:/wt/removed'], entries, 'all', worktreeIds)
    expect(keys(resolved)).toEqual(['worktree:/wt/b', 'command:acme/one'])
  })

  test('follow the scope', () => {
    const recents = ['worktree:/wt/b', 'command:acme/one', 'view:acme/page']
    expect(keys(resolveRecents(recents, entries, 'worktrees', worktreeIds))).toEqual(['worktree:/wt/b'])
    expect(keys(resolveRecents(recents, entries, 'commands', worktreeIds))).toEqual(['command:acme/one'])
    expect(resolveRecents(recents, entries, 'files', worktreeIds)).toEqual([])
  })

  test('a file recent resolves from its id while its worktree exists', () => {
    const key = entryKey(fileEntry('/wt/a', 'src/x.ts'))
    expect(resolveRecents([key], entries, 'all', worktreeIds)).toEqual([fileEntry('/wt/a', 'src/x.ts')])
    expect(resolveRecents([key], entries, 'files', worktreeIds)).toHaveLength(1)
    expect(resolveRecents([key], entries, 'all', new Set(['/wt/b']))).toEqual([])
    expect(resolveRecents([key], entries, 'commands', worktreeIds)).toEqual([])
  })
})

describe('sections', () => {
  const base = { entries, scope: 'all' as const, query: '', worktreeIds }

  test('with no query, Recent leads and the list does not repeat it', () => {
    const sections = paletteSections({ ...base, recents: ['worktree:/wt/b', 'command:acme/two'] })
    expect(sections.map((section) => section.title)).toEqual(['Recent', 'All'])
    expect(keys(sections[0]!.entries)).toEqual(['worktree:/wt/b', 'command:acme/two'])
    expect(keys(sections[1]!.entries)).not.toContain('worktree:/wt/b')
    expect(sections.flatMap((section) => section.entries)).toHaveLength(entries.length)
  })

  test('the list section carries the scope name', () => {
    const sections = paletteSections({ ...base, scope: 'worktrees', recents: ['worktree:/wt/b'] })
    expect(sections.map((section) => section.title)).toEqual(['Recent', 'Worktrees'])
    expect(keys(sections[1]!.entries)).toEqual(['worktree:/wt/a'])
  })

  test('without recents there is a single untitled list', () => {
    expect(paletteSections({ ...base, recents: [] })).toEqual([{ title: null, entries }])
  })

  test('a query drops Recent and headers and keeps the given order', () => {
    const sections = paletteSections({ ...base, query: 'o', recents: ['worktree:/wt/b'] })
    expect(sections).toEqual([{ title: null, entries }])
  })

  test('an empty scope yields no sections', () => {
    expect(paletteSections({ ...base, scope: 'files', recents: [] })).toEqual([])
  })
})

describe('paletteKey', () => {
  test('arrows wrap and Enter runs', () => {
    expect(paletteKey('ArrowDown', 2, 3)).toEqual({ selected: 0, run: false })
    expect(paletteKey('ArrowUp', 0, 3)).toEqual({ selected: 2, run: false })
    expect(paletteKey('Enter', 1, 3)).toEqual({ selected: 1, run: true })
    expect(paletteKey('Enter', 0, 0)).toEqual({ selected: 0, run: false })
  })
})

describe('palette entry ranking', () => {
  const entry = (kind: PaletteEntry['kind'], title: string, description?: string): PaletteEntry => ({
    id: `${kind}:${title}`,
    title,
    kind,
    ...(description ? { description } : {})
  })

  test('ranks exact, prefix, title substring and metadata matches stably', () => {
    const ordered = rankPaletteEntries(
      [
        entry('command', 'Terminal Dock'),
        entry('worktree', 'DocsPass'),
        entry('command', 'Copy Context', 'Document path'),
        entry('view', 'Editor Document'),
        entry('file', '  dOc  '),
        entry('tool', 'Document Viewer'),
        entry('view', 'Details', 'Documentation')
      ],
      'doc'
    )

    expect(ordered.map(({ kind, title }) => `${kind}:${title}`)).toEqual([
      'file:  dOc  ',
      'worktree:DocsPass',
      'tool:Document Viewer',
      'command:Terminal Dock',
      'view:Editor Document',
      'command:Copy Context',
      'view:Details'
    ])
  })

  test('leaves the order alone with no query', () => {
    const entries = [entry('command', 'b'), entry('file', 'a')]
    expect(rankPaletteEntries(entries, '')).toEqual(entries)
  })
})
