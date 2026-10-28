import { expect, test } from 'bun:test'
import {
  eraseShapes,
  mapClientPointToSource,
  type MarkupShape
} from '../src/markup/geometry'
import {
  clearMarkup,
  commitMarkupAction,
  createMarkupHistory,
  redoMarkup,
  undoMarkup
} from '../src/markup/history'

const pen: MarkupShape = { kind: 'pen', points: [{ x: 0, y: 10 }, { x: 100, y: 10 }], color: '#ff0000', size: 2 }
const text: MarkupShape = { kind: 'text', point: { x: 50, y: 50 }, text: 'Label', color: '#0000ff', fontSize: 12 }

test('maps scaled CSS pointer coordinates to original screenshot pixels and clamps outside capture', () => {
  const bounds = { left: 10, top: 20, width: 400, height: 200 }
  expect(mapClientPointToSource(110, 70, bounds, 1200, 600)).toEqual({ x: 300, y: 150 })
  expect(mapClientPointToSource(-10, 400, bounds, 1200, 600)).toEqual({ x: 0, y: 600 })
})

test('eraser removes hit strokes and text but leaves non-intersecting shapes intact', () => {
  const rectangle: MarkupShape = {
    kind: 'rectangle', start: { x: 140, y: 20 }, end: { x: 180, y: 60 }, color: '#00aa00', size: 4
  }
  const result = eraseShapes([pen, text, rectangle], [{ x: 50, y: 11 }, { x: 55, y: 48 }], 3)
  expect(result.removed).toEqual([pen, text])
  expect(result.remaining).toEqual([rectangle])
})

test('eraser hits arrow, ellipse, and rectangle outlines', () => {
  const arrow: MarkupShape = { kind: 'arrow', start: { x: 10, y: 20 }, end: { x: 100, y: 20 }, color: '#ff0000', size: 4 }
  const ellipse: MarkupShape = { kind: 'ellipse', start: { x: 120, y: 0 }, end: { x: 180, y: 60 }, color: '#00aa00', size: 2 }
  const rectangle: MarkupShape = { kind: 'rectangle', start: { x: 200, y: 10 }, end: { x: 240, y: 50 }, color: '#0000ff', size: 2 }
  expect(eraseShapes([arrow], [{ x: 99, y: 20 }], 1).removed).toEqual([arrow])
  expect(eraseShapes([ellipse], [{ x: 120, y: 30 }], 1).removed).toEqual([ellipse])
  expect(eraseShapes([rectangle], [{ x: 200, y: 30 }], 1).removed).toEqual([rectangle])
})

test('eraser catches a large ellipse at the rendered outline between tessellation vertices', () => {
  const ellipse: MarkupShape = { kind: 'ellipse', start: { x: 0, y: 0 }, end: { x: 2000, y: 2000 }, color: '#00aa00', size: 1 }
  const angle = Math.PI / 96
  const point = { x: 1000 + 1000 * Math.cos(angle), y: 1000 + 1000 * Math.sin(angle) }
  expect(eraseShapes([ellipse], [point], 0.5).removed).toEqual([ellipse])
})

test('clear is reversible and new actions after undo discard redo history', () => {
  const rectangle: MarkupShape = {
    kind: 'rectangle', start: { x: 1, y: 2 }, end: { x: 30, y: 40 }, color: '#00aa00', size: 3
  }
  let history = createMarkupHistory()
  history = commitMarkupAction(history, [pen])
  history = commitMarkupAction(history, [pen, text])
  history = clearMarkup(history)
  expect(history.shapes).toEqual([])
  history = undoMarkup(history)
  expect(history.shapes).toEqual([pen, text])
  history = undoMarkup(history)
  expect(history.shapes).toEqual([pen])
  history = commitMarkupAction(history, [pen, rectangle])
  expect(history.redo).toEqual([])
  expect(redoMarkup(history).shapes).toEqual([pen, rectangle])
})

test('undo and redo restore immutable vector snapshots', () => {
  let history = createMarkupHistory()
  history = commitMarkupAction(history, [pen])
  history = commitMarkupAction(history, [pen, text])
  history = undoMarkup(history)
  expect(history.shapes).toEqual([pen])
  expect(redoMarkup(history).shapes).toEqual([pen, text])
})
