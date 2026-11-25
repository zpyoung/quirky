// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import mermaid from 'mermaid'

import { getMermaidConfig } from './mermaid-config'

const darkColors = {
  background: '#0a0a0a',
  foreground: '#fafafa',
  primary: '#193cb8',
  secondary: '#1447e6',
  tertiary: '#155dfc',
  border: '#8ec5ff',
  line: '#a1a1a1'
}

const graphiteDark = {
  background: '#16171b',
  foreground: '#eceef2',
  primary: '#22242b',
  secondary: '#22242b',
  tertiary: '#16171b',
  border: '#24262c',
  line: '#7c828d'
}

const graphiteLight = {
  background: '#ffffff',
  foreground: '#1b1d22',
  primary: '#e7e9ef',
  secondary: '#e7e9ef',
  tertiary: '#ffffff',
  border: '#e3e5ea',
  line: '#646b76'
}

function luminance(color: string | boolean | undefined): number {
  if (typeof color !== 'string') {
    throw new Error('Expected a resolved Mermaid color')
  }
  const named: Record<string, string> = {
    lightgrey: '#d3d3d3',
    white: '#ffffff',
    black: '#000000'
  }
  const hex = named[color] ?? color
  if (!/^#[\da-f]{6}$/i.test(hex)) {
    throw new Error(`Unsupported contrast-test color: ${color}`)
  }
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722
}

function resolvedTheme(
  isDark: boolean,
  colors = darkColors
): NonNullable<ReturnType<typeof mermaid.mermaidAPI.getConfig>['themeVariables']> {
  mermaid.initialize(getMermaidConfig(isDark, false, colors))
  const variables = mermaid.mermaidAPI.getConfig().themeVariables
  if (!variables) {
    throw new Error('Mermaid did not resolve the theme')
  }
  return variables
}

describe('getMermaidConfig', () => {
  it('uses strict Mermaid rendering defaults', () => {
    expect(getMermaidConfig(false)).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: 'default',
      htmlLabels: false
    })
  })

  it('can enable HTML labels for callers that explicitly need them', () => {
    expect(getMermaidConfig(false, true)).toMatchObject({
      startOnLoad: false,
      theme: 'default',
      htmlLabels: true
    })
  })

  it('uses the colored dark palette when the preview is dark', () => {
    const colors = darkColors
    expect(getMermaidConfig(true, false, colors)).toMatchObject({
      theme: 'base',
      darkMode: true,
      themeVariables: {
        darkMode: true,
        primaryColor: colors.primary,
        tertiaryColor: colors.tertiary,
        primaryTextColor: colors.foreground,
        tertiaryTextColor: colors.foreground,
        primaryBorderColor: colors.border,
        lineColor: colors.line,
        edgeLabelBackground: colors.background
      },
      htmlLabels: false
    })
  })

  it('themes light previews from the same tokens instead of the stock palette', () => {
    const colors = graphiteLight
    expect(getMermaidConfig(false, false, colors)).toMatchObject({
      theme: 'base',
      darkMode: false,
      themeVariables: {
        darkMode: false,
        background: colors.background,
        primaryColor: colors.primary,
        secondaryColor: colors.secondary,
        tertiaryColor: colors.tertiary,
        primaryTextColor: colors.foreground,
        primaryBorderColor: colors.border,
        lineColor: colors.line,
        textColor: colors.foreground,
        edgeLabelBackground: colors.background
      }
    })
  })

  it.each([
    ['dark', true, graphiteDark],
    ['light', false, graphiteLight]
  ] as const)(
    'keeps Gantt labels readable on completed and active tasks and alternate sections (%s)',
    (_mode, isDark, colors) => {
      const variables = resolvedTheme(isDark, colors)
      for (const [text, background] of [
        ['taskTextDarkColor', 'doneTaskBkgColor'],
        ['taskTextDarkColor', 'activeTaskBkgColor'],
        ['taskTextOutsideColor', 'altSectionBkgColor']
      ]) {
        const first = luminance(variables[text])
        const second = luminance(variables[background])
        const contrast = (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
        expect(contrast, `${text} on ${background}`).toBeGreaterThanOrEqual(4.5)
      }
    }
  )

  it('gives the first three pie categories distinct resolved colors', () => {
    const variables = resolvedTheme(true)
    expect(new Set([variables.pie1, variables.pie2, variables.pie3]).size).toBe(3)
  })
})
