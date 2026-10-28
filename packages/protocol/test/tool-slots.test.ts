import { describe, expect, test } from 'bun:test'
import { KERNEL_METHOD_SCHEMAS, UI_TOOL_SLOTS, validateValue } from '../src'

describe('tool slot RPC schemas', () => {
  test('tool mutations are represented with valid slot and geometry contracts', () => {
    expect(UI_TOOL_SLOTS).toEqual(['left-top', 'left-bottom', 'right-top', 'right-bottom', 'bottom-left', 'bottom-right'])

    const open = KERNEL_METHOD_SCHEMAS['ui.tool.open'].params
    const close = KERNEL_METHOD_SCHEMAS['ui.tool.close'].params
    const move = KERNEL_METHOD_SCHEMAS['ui.tool.move'].params
    const resize = KERNEL_METHOD_SCHEMAS['ui.tool.resize'].params

    expect(validateValue(open, { id: 'panel:quirky.git/source-control' })).toBeNull()
    expect(validateValue(open, {})).toBe('params.id is required')
    expect(validateValue(close, { slot: 'bottom-right' })).toBeNull()
    expect(validateValue(close, { slot: 'middle' })).toBe("params.slot must be one of left-top, left-bottom, right-top, right-bottom, bottom-left, bottom-right")
    expect(validateValue(move, { id: 'panel:quirky.git/source-control', slot: 'right-bottom' })).toBeNull()
    expect(validateValue(move, { id: 'panel:quirky.git/source-control', slot: 'middle' })).toContain('params.slot must be one of')
    expect(validateValue(resize, { left: 160, right: 1200, bottom: 1000, leftSplit: 0.15, rightSplit: 0.5, bottomSplit: 0.85 })).toBeNull()
    expect(validateValue(resize, { left: 159 })).toBe('params.left must be at least 160')
    expect(validateValue(resize, { bottom: 1001 })).toBe('params.bottom must be at most 1000')
    expect(validateValue(resize, { leftSplit: 0.14 })).toBe('params.leftSplit must be at least 0.15')
    expect(validateValue(resize, { right: 300, unexpected: 1 })).toBe('params.unexpected is not allowed')
  })
})
