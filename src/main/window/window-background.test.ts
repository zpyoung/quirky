import { describe, expect, it } from 'vitest'
import { WINDOW_BACKGROUND, resolveWindowBackground } from './window-background'

describe('resolveWindowBackground', () => {
  it('pins the graphite rail colours', () => {
    expect(WINDOW_BACKGROUND).toEqual({ dark: '#0c0d0f', light: '#eef0f3' })
  })

  it.each([true, false])('returns dark for the dark preference (dark OS=%s)', (prefersDark) => {
    expect(resolveWindowBackground('dark', prefersDark)).toBe('#0c0d0f')
  })

  it.each([true, false])('returns light for the light preference (dark OS=%s)', (prefersDark) => {
    expect(resolveWindowBackground('light', prefersDark)).toBe('#eef0f3')
  })

  it('follows the operating system for the system preference', () => {
    expect(resolveWindowBackground('system', true)).toBe('#0c0d0f')
    expect(resolveWindowBackground('system', false)).toBe('#eef0f3')
  })
})
