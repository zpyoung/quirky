import { describe, expect, it } from 'vitest'
import { explainMath, MATH_ERROR_COLOR, readMathFailure } from './math-errors'

describe('readMathFailure', () => {
  const annotation = {
    type: 'element',
    tagName: 'annotation',
    children: [{ type: 'text', value: '\\frac{' }]
  }

  it('reads the tex from a tree painted in the error colour', () => {
    const tree = {
      type: 'element',
      tagName: 'span',
      properties: { style: `color:${MATH_ERROR_COLOR}` },
      children: [annotation]
    }
    expect(readMathFailure(tree)).toEqual({ tex: '\\frac{' })
  })

  it('reads a failure marked through mathcolor', () => {
    const tree = {
      type: 'element',
      tagName: 'span',
      children: [
        {
          type: 'element',
          tagName: 'mstyle',
          properties: { mathcolor: MATH_ERROR_COLOR },
          children: [annotation]
        }
      ]
    }
    expect(readMathFailure(tree)).toEqual({ tex: '\\frac{' })
  })

  it('is null for good math and for no node', () => {
    expect(readMathFailure({ type: 'element', tagName: 'span', children: [annotation] })).toBeNull()
    expect(readMathFailure(undefined)).toBeNull()
  })
})

describe('explainMath', () => {
  it('names the problem without the position tail', () => {
    const message = explainMath('\\frac{1')
    expect(message).not.toMatch(/at position/)
    expect(message).not.toMatch(/^KaTeX parse error/)
    expect(message.length).toBeGreaterThan(0)
  })

  it('falls back when KaTeX accepts the formula', () => {
    expect(explainMath('x^2')).toBe('invalid math')
  })
})
