import { describe, expect, it } from 'vitest'
import { parseChartSpec } from './DataBlocks'

const errorOf = (source: string): string | undefined => {
  const parsed = parseChartSpec(source)
  return 'error' in parsed ? parsed.error : undefined
}

describe('parseChartSpec', () => {
  it('accepts bar and line specs with inline data', () => {
    expect(parseChartSpec('{"type":"bar","data":[{"label":"a","value":1}]}')).toEqual({
      type: 'bar',
      data: [{ label: 'a', value: 1 }]
    })
    expect(
      parseChartSpec(
        '{"type":"line","title":"t","unit":"ms","data":[{"x":1,"y":2},{"x":"b","y":3}]}'
      )
    ).toEqual({
      type: 'line',
      title: 't',
      unit: 'ms',
      data: [
        { x: 1, y: 2 },
        { x: 'b', y: 3 }
      ]
    })
  })

  it('accepts a from spec with column names', () => {
    expect(parseChartSpec('{"type":"bar","from":"sizes","x":"session","y":"ms"}')).toEqual({
      type: 'bar',
      from: 'sizes',
      x: 'session',
      y: 'ms'
    })
  })

  it('rejects what the schema forbids', () => {
    expect(errorOf('nope')).toMatch(/^invalid JSON/)
    expect(errorOf('[]')).toBe('expected a JSON object')
    expect(errorOf('{"type":"pie","data":[]}')).toBe('"type" must be "bar" or "line"')
    expect(errorOf('{"type":"bar"}')).toBe('exactly one of "data" and "from" is required')
    expect(errorOf('{"type":"bar","from":"a","x":"b","y":"c","data":[]}')).toBe(
      'exactly one of "data" and "from" is required'
    )
    expect(errorOf('{"type":"bar","from":"a"}')).toBe('"from" needs "x" and "y" column names')
    expect(errorOf('{"type":"bar","data":[]}')).toBe('"data" must be a non-empty array')
    expect(errorOf('{"type":"bar","data":[{"label":"a","value":"1"}]}')).toContain('data[0]')
    expect(errorOf('{"type":"line","data":[{"x":1,"y":"2"}]}')).toContain('data[0]')
    expect(errorOf('{"type":"bar","title":3,"data":[{"label":"a","value":1}]}')).toBe(
      '"title" must be a string'
    )
  })

  it('rejects negative bar values but allows them on a line', () => {
    expect(errorOf('{"type":"bar","data":[{"label":"a","value":-1}]}')).toBe(
      'bar values must be zero or more'
    )
    expect(errorOf('{"type":"line","data":[{"x":"a","y":-1}]}')).toBeUndefined()
  })
})
