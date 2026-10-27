import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { EditorView, type DecorationSet } from '@codemirror/view'
import { conflictBlocks, conflictDecorationSet, conflictDecorations } from '../../src/view/conflict-markers'

const lines = (...l: string[]) => l.join('\n')

describe('conflictBlocks', () => {
  test('finds one block with its 1-based marker lines', () => {
    const text = lines('top', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> feature', 'bottom')
    expect(conflictBlocks(text)).toEqual([{ start: 2, separator: 4, end: 6 }])
  })

  test('finds a common-ancestor section (diff3)', () => {
    const text = lines('<<<<<<< HEAD', 'ours', '||||||| merged common ancestors', 'base', '=======', 'theirs', '>>>>>>> topic')
    expect(conflictBlocks(text)).toEqual([{ start: 1, base: 3, separator: 5, end: 7 }])
  })

  test('SC-44: two blocks, the second with a base', () => {
    const text = lines(
      'a',
      '<<<<<<< HEAD',
      'x',
      '=======',
      'y',
      '>>>>>>> t',
      'mid',
      '<<<<<<< HEAD',
      'x2',
      '|||||||',
      'b2',
      '=======',
      'y2',
      '>>>>>>> t'
    )
    expect(conflictBlocks(text)).toEqual([
      { start: 2, separator: 4, end: 6 },
      { start: 8, base: 10, separator: 12, end: 14 }
    ])
  })

  test('markers may be bare', () => {
    expect(conflictBlocks(lines('<<<<<<<', '=======', '>>>>>>>'))).toEqual([{ start: 1, separator: 2, end: 3 }])
  })

  test('CRLF and lone CR line endings count lines like the editor does', () => {
    expect(conflictBlocks('a\r\n<<<<<<< HEAD\r\nx\r\n=======\r\ny\r\n>>>>>>> t\r\n')).toEqual([{ start: 2, separator: 4, end: 6 }])
    expect(conflictBlocks('<<<<<<< a\r=======\r>>>>>>> b')).toEqual([{ start: 1, separator: 2, end: 3 }])
  })

  test('an unterminated block is ignored', () => {
    expect(conflictBlocks(lines('<<<<<<< HEAD', 'ours', '=======', 'theirs'))).toEqual([])
    expect(conflictBlocks(lines('<<<<<<< HEAD', 'ours'))).toEqual([])
  })

  test('a block with no separator is ignored', () => {
    expect(conflictBlocks(lines('<<<<<<< HEAD', 'ours', '>>>>>>> t'))).toEqual([])
  })

  test('an unterminated block does not hide a later complete one', () => {
    const text = lines('<<<<<<< HEAD', 'x', '=======', 'y', '<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> t')
    expect(conflictBlocks(text)).toEqual([{ start: 5, separator: 7, end: 9 }])
  })

  test('marker-like text outside a block is ignored', () => {
    expect(conflictBlocks(lines('=======', '>>>>>>> x', '||||||| y', 'Title', '======='))).toEqual([])
  })

  test('markers must start the line and have exactly seven characters', () => {
    expect(conflictBlocks(lines(' <<<<<<< a', '=======', '>>>>>>> b'))).toEqual([])
    expect(conflictBlocks(lines('<<<<<<<<', '=======', '>>>>>>> b'))).toEqual([])
    expect(conflictBlocks(lines('<<<<<<< a', '========', '>>>>>>> b'))).toEqual([])
    expect(conflictBlocks(lines('<<<<<<< a', '=======', '>>>>>>>b'))).toEqual([])
  })

  test('a repeated separator or base inside a block is content', () => {
    const text = lines('<<<<<<< a', '=======', 'x', '=======', '||||||| y', '>>>>>>> b')
    expect(conflictBlocks(text)).toEqual([{ start: 1, separator: 2, end: 6 }])
  })

  test('nested-looking text: an inner start abandons the unfinished outer block', () => {
    const text = lines('<<<<<<< outer', '<<<<<<< inner', 'x', '=======', 'y', '>>>>>>> inner', '>>>>>>> outer')
    expect(conflictBlocks(text)).toEqual([{ start: 2, separator: 4, end: 6 }])
  })

  test('text with no conflicts, or empty', () => {
    expect(conflictBlocks('')).toEqual([])
    expect(conflictBlocks('just text\n')).toEqual([])
  })
})

type Found = { from: number; to: number; class?: string; label?: string }

function collect(set: DecorationSet): Found[] {
  const out: Found[] = []
  const cursor = set.iter()
  while (cursor.value) {
    const spec = cursor.value.spec as { class?: string; widget?: { label?: string } }
    out.push({ from: cursor.from, to: cursor.to, class: spec.class, label: spec.widget?.label })
    cursor.next()
  }
  return out
}

describe('conflictDecorationSet', () => {
  const doc = lines('top', '<<<<<<< HEAD', 'ours', '||||||| base', 'old', '=======', 'theirs', '>>>>>>> t', 'bottom')
  const state = EditorState.create({ doc })
  const found = collect(conflictDecorationSet(state.doc))
  const lineClasses = (cls: string) =>
    found.filter((f) => f.class === cls).map((f) => state.doc.lineAt(f.from).number)

  test('tints marker lines', () => {
    expect(lineClasses('qg-conflict-marker')).toEqual([2, 4, 6, 8])
  })

  test('tints the current, base and incoming sides', () => {
    expect(lineClasses('qg-conflict-current')).toEqual([3])
    expect(lineClasses('qg-conflict-base')).toEqual([5])
    expect(lineClasses('qg-conflict-incoming')).toEqual([7])
  })

  test('labels the marker lines at their end', () => {
    const labels = found.filter((f) => f.label).map((f) => [state.doc.lineAt(f.from).number, f.label, f.from === state.doc.lineAt(f.from).to])
    expect(labels).toEqual([
      [2, 'Current change', true],
      [4, 'Common ancestor', true],
      [6, 'Incoming change', true],
      [8, 'End conflict', true]
    ])
  })

  test('leaves lines outside blocks alone', () => {
    const touched = new Set(found.map((f) => state.doc.lineAt(f.from).number))
    expect([...touched].sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8])
  })

  test('without a base section the current side runs to the separator', () => {
    const s = EditorState.create({ doc: lines('<<<<<<< a', 'x', 'y', '=======', 'z', '>>>>>>> b') })
    const f = collect(conflictDecorationSet(s.doc))
    expect(f.filter((d) => d.class === 'qg-conflict-current').map((d) => s.doc.lineAt(d.from).number)).toEqual([2, 3])
    expect(f.filter((d) => d.label === 'Common ancestor')).toEqual([])
  })

  test('an empty side adds no side lines', () => {
    const s = EditorState.create({ doc: lines('<<<<<<< a', '=======', 'z', '>>>>>>> b') })
    const f = collect(conflictDecorationSet(s.doc))
    expect(f.filter((d) => d.class === 'qg-conflict-current')).toEqual([])
  })

  test('works with CRLF documents', () => {
    const s = EditorState.create({ doc: '<<<<<<< a\r\nx\r\n=======\r\ny\r\n>>>>>>> b' })
    const f = collect(conflictDecorationSet(s.doc))
    expect(f.filter((d) => d.class === 'qg-conflict-marker')).toHaveLength(3)
  })
})

describe('conflictDecorations extension', () => {
  const decorationsOf = (state: EditorState): Found[] => {
    const sets = state.facet(EditorView.decorations).filter((v): v is DecorationSet => typeof v !== 'function')
    return sets.flatMap(collect)
  }

  test('recomputes when the document changes', () => {
    let state = EditorState.create({ doc: 'plain\n', extensions: [conflictDecorations()] })
    expect(decorationsOf(state)).toEqual([])

    state = state.update({ changes: { from: 0, insert: '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n' } }).state
    expect(decorationsOf(state).filter((d) => d.class === 'qg-conflict-marker')).toHaveLength(3)

    const resolved = state.update({ changes: { from: 0, to: state.doc.length, insert: 'resolved\n' } }).state
    expect(decorationsOf(resolved)).toEqual([])
  })

  test('shows blocks present in the initial document', () => {
    const state = EditorState.create({ doc: '<<<<<<< a\n=======\n>>>>>>> b', extensions: [conflictDecorations()] })
    expect(decorationsOf(state).filter((d) => d.label).map((d) => d.label)).toEqual([
      'Current change',
      'Incoming change',
      'End conflict'
    ])
  })
})

