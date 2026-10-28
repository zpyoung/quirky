import { expect, test } from 'bun:test'
import { classifyDraftUpdate as classify, expectedDraftAcknowledgement } from '../src/window/DocumentSurface'

test('an own draft subscription arriving before its response is held as a pending acknowledgment', () => {
  const pending = [{ contentRevision: 2, draft: 'typed\n' }]
  expect(classify({ contentRevision: 2, draft: 'typed\n' }, new Map(), pending)).toBe('pending')

  const acknowledged = new Map<number, string | null>([[2, 'typed\n']])
  expect(classify({ contentRevision: 2, draft: 'typed\n' }, acknowledged, [])).toBe('acknowledged')
})

test('an own response arriving before its subscription remains recognizable after repeated edit and undo writes', () => {
  const acknowledged = new Map<number, string | null>()
  const edit = { contentRevision: 2, draft: 'edited\n' }
  const undo = { contentRevision: 3, draft: null }

  acknowledged.set(edit.contentRevision, edit.draft)
  expect(classify(edit, acknowledged, [])).toBe('acknowledged')
  expect(classify(undo, acknowledged, [undo])).toBe('pending')
  acknowledged.set(undo.contentRevision, undo.draft)
  expect(classify(undo, acknowledged, [])).toBe('acknowledged')
})

test('both edit and undo subscription/response orderings correlate without using text alone', () => {
  const initial = { content: 'base\n', draft: null }
  const edit = expectedDraftAcknowledgement('edited\n', initial, 1)
  const undo = expectedDraftAcknowledgement('base\n', { ...initial, draft: edit.draft }, edit.contentRevision)
  const eventFirst = new Map<number, string | null>()
  expect(classify(edit, eventFirst, [edit])).toBe('pending')
  eventFirst.set(edit.contentRevision, edit.draft)
  expect(classify(edit, eventFirst, [])).toBe('acknowledged')
  expect(classify(undo, eventFirst, [undo])).toBe('pending')
  eventFirst.set(undo.contentRevision, undo.draft)
  expect(classify(undo, eventFirst, [])).toBe('acknowledged')

  const responseFirst = new Map<number, string | null>([[edit.contentRevision, edit.draft], [undo.contentRevision, undo.draft]])
  expect(classify(edit, responseFirst, [])).toBe('acknowledged')
  expect(classify(undo, responseFirst, [])).toBe('acknowledged')
})

test('a genuinely newer uncorrelated competing draft is not mistaken for an own acknowledgment', () => {
  const acknowledged = new Map<number, string | null>([[2, 'mine\n']])
  expect(classify({ contentRevision: 3, draft: 'peer version\n' }, acknowledged, [])).toBe('competing')
  expect(classify({ contentRevision: 3, draft: 'mine\n' }, acknowledged, [])).toBe('competing')
})
