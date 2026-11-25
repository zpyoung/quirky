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
  line: '#a1a1a1',
  pie: ['#bedbff', '#2b7fff', '#155dfc', '#1447e6', '#193cb8'] as const
}

const graphiteDark = {
  background: '#16171b',
  foreground: '#eceef2',
  primary: '#22242b',
  secondary: '#101114',
  tertiary: '#16171b',
  line: '#7c828d',
  pie: ['#bedbff', '#2b7fff', '#155dfc', '#1447e6', '#193cb8'] as const
}

const graphiteLight = {
  background: '#ffffff',
  foreground: '#1b1d22',
  primary: '#e7e9ef',
  secondary: '#f6f7f9',
  tertiary: '#ffffff',
  line: '#646b76',
  pie: ['#bedbff', '#2b7fff', '#155dfc', '#1447e6', '#193cb8'] as const
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
        primaryBorderColor: colors.line,
        lineColor: colors.line,
        edgeLabelBackground: colors.background,
        pie1: colors.pie[0],
        pie5: colors.pie[4]
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
        primaryBorderColor: colors.line,
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

  it.each([
    ['dark', true, graphiteDark],
    ['light', false, graphiteLight]
  ] as const)(
    'gives the five pie categories distinct resolved colors (%s)',
    (_mode, isDark, colors) => {
      const variables = resolvedTheme(isDark, colors)
      expect(
        new Set([variables.pie1, variables.pie2, variables.pie3, variables.pie4, variables.pie5])
          .size
      ).toBe(5)
    }
  )

  it('keeps node borders off the surface fills so shapes stay outlined', () => {
    const variables = resolvedTheme(true, graphiteDark)
    expect(variables.primaryBorderColor).toBe(graphiteDark.line)
    expect(variables.primaryBorderColor).not.toBe(variables.primaryColor)
  })
})
