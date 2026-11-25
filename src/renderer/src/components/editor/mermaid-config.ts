import type mermaid from 'mermaid'

export type MermaidThemeColors = {
  background: string
  foreground: string
  primary: string
  secondary: string
  tertiary: string
  line: string
  pie: readonly [string, string, string, string, string]
}

export function getMermaidConfig(
  isDark: boolean,
  htmlLabels = false,
  colors?: MermaidThemeColors
): Parameters<typeof mermaid.initialize>[0] {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    // The legacy dark theme removes color from flowcharts.
    theme: colors ? 'base' : isDark ? 'dark' : 'default',
    darkMode: isDark,
    ...(colors
      ? {
          themeVariables: {
            darkMode: isDark,
            background: colors.background,
            primaryColor: colors.primary,
            secondaryColor: colors.secondary,
            tertiaryColor: colors.tertiary,
            primaryTextColor: colors.foreground,
            secondaryTextColor: colors.foreground,
            tertiaryTextColor: colors.foreground,
            primaryBorderColor: colors.line,
            secondaryBorderColor: colors.line,
            tertiaryBorderColor: colors.line,
            lineColor: colors.line,
            textColor: colors.foreground,
            edgeLabelBackground: colors.background,
            // Base defaults to light Gantt surfaces even when darkMode is enabled.
            altSectionBkgColor: colors.background,
            excludeBkgColor: colors.background,
            doneTaskBkgColor: colors.background,
            doneTaskBorderColor: colors.line,
            activeTaskBkgColor: colors.secondary,
            pie1: colors.pie[0],
            pie2: colors.pie[1],
            pie3: colors.pie[2],
            pie4: colors.pie[3],
            pie5: colors.pie[4],
            pieSectionTextColor: '#ffffff'
          }
        }
      : {}),
    htmlLabels
  }
}
