import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { EditorView, WidgetType } from '@codemirror/view'
import { conflictBlocks, conflictDecorations } from '../../src/view/conflict-markers'
import { lineBreakExtension } from '../../src/view/theme'

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

function annotatedState(text: string): EditorState {
  return EditorState.create({ doc: text, extensions: [lineBreakExtension(text), conflictDecorations()] })
}

/** Inspect actual field output, without coupling the contract to classes or label copy. */
function expectAnnotations(state: EditorState, lineNumbers: number[], widgetLines: number[]): void {
  const lineRanges: { from: number; to: number }[] = []
  const widgetRanges: { from: number; to: number }[] = []
  for (const decorations of state.facet(EditorView.decorations)) {
    if (typeof decorations === 'function') throw new Error('Expected state-provided conflict decorations')
    for (let cursor = decorations.iter(); cursor.value; cursor.next()) {
      const ranges = cursor.value.spec.widget instanceof WidgetType ? widgetRanges : lineRanges
      ranges.push({ from: cursor.from, to: cursor.to })
    }
  }
  expect(lineRanges).toEqual(lineNumbers.map(n => {
    const from = state.doc.line(n).from
    return { from, to: from }
  }))
  expect(widgetRanges).toEqual(widgetLines.map(n => {
    const to = state.doc.line(n).to
    return { from: to, to }
  }))
}

describe('conflict annotation state', () => {
  test('Unicode CRLF diff3 annotations cover only conflict lines and end at the full marker text', () => {
    const text = [
      'before 🧭 e\u0301',
      '<<<<<<< HEAD 🧑‍💻',
      'ours 🦊',
      '',
      '||||||| base é',
      'base 🇨🇦',
      '=======',
      'incoming 漢字',
      '>>>>>>> topic 🚀',
      'after'
    ].join('\r\n')
    const state = annotatedState(text)

    expect(state.sliceDoc()).toBe(text)
    expectAnnotations(state, [2, 3, 4, 5, 6, 7, 8, 9], [2, 5, 7, 9])
  })

  test('incremental CRLF edits move marker ends and newly split content-line anchors', () => {
    let state = annotatedState([
      'before 🧭',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> topic',
      'after'
    ].join('\r\n'))
    expectAnnotations(state, [2, 3, 4, 5, 6], [2, 4, 6])

    state = state.update({ changes: { from: 0, insert: 'new 🪶\r\n' } }).state
    expectAnnotations(state, [3, 4, 5, 6, 7], [3, 5, 7])

    const marker = state.doc.line(3)
    state = state.update({ changes: { from: marker.from + 8, to: marker.to, insert: 'HEAD 🧑‍💻 e\u0301' } }).state
    expectAnnotations(state, [3, 4, 5, 6, 7], [3, 5, 7])

    state = state.update({ changes: { from: state.doc.line(4).to, insert: '\r\nmore 🦊' } }).state
    expectAnnotations(state, [3, 4, 5, 6, 7, 8], [3, 6, 8])
  })

  test('joining a separator to content removes only that block until the line boundary is restored', () => {
    let state = annotatedState(lines(
      'before',
      '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> first',
      'between',
      '<<<<<<< HEAD', 'local', '=======', 'remote', '>>>>>>> second',
      'after'
    ))
    expectAnnotations(state, [2, 3, 4, 5, 6, 8, 9, 10, 11, 12], [2, 4, 6, 8, 10, 12])

    const boundary = state.doc.line(3).to
    state = state.update({ changes: { from: boundary, to: state.doc.line(4).from } }).state
    expectAnnotations(state, [7, 8, 9, 10, 11], [7, 9, 11])

    state = state.update({ changes: { from: boundary, insert: '\n' } }).state
    expectAnnotations(state, [2, 3, 4, 5, 6, 8, 9, 10, 11, 12], [2, 4, 6, 8, 10, 12])
  })

  test('resolving one block preserves the other, and new conflicts reappear after full resolution', () => {
    let state = annotatedState(lines(
      'before',
      '<<<<<<< HEAD', 'ours 🦊', '=======', 'theirs', '>>>>>>> first',
      'between',
      '<<<<<<< HEAD', 'local', '=======', 'remote', '>>>>>>> second',
      'after'
    ))
    expectAnnotations(state, [2, 3, 4, 5, 6, 8, 9, 10, 11, 12], [2, 4, 6, 8, 10, 12])

    state = state.update({
      changes: { from: state.doc.line(2).from, to: state.doc.line(6).to, insert: 'ours 🦊' }
    }).state
    expectAnnotations(state, [4, 5, 6, 7, 8], [4, 6, 8])

    state = state.update({
      changes: { from: state.doc.line(4).from, to: state.doc.line(8).to, insert: 'remote' }
    }).state
    expectAnnotations(state, [], [])

    state = state.update({
      changes: {
        from: state.doc.line(4).from,
        to: state.doc.line(4).to,
        insert: lines('<<<<<<< HEAD', 'local', '=======', 'remote', '>>>>>>> topic')
      }
    }).state
    expectAnnotations(state, [4, 5, 6, 7, 8], [4, 6, 8])
  })
})

