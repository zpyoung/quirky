import type * as Monaco from 'monaco-editor'

type MonacoModule = typeof Monaco
type GraphiteThemeData = Parameters<MonacoModule['editor']['defineTheme']>[1]

export const MONACO_THEME_DARK = 'quirky-graphite-dark'
export const MONACO_THEME_LIGHT = 'quirky-graphite-light'

export function monacoThemeFor(
  isDark: boolean
): typeof MONACO_THEME_DARK | typeof MONACO_THEME_LIGHT {
  return isDark ? MONACO_THEME_DARK : MONACO_THEME_LIGHT
}

type SyntaxPalette = {
  keyword: string
  function: string
  string: string
  number: string
  comment: string
  type: string
  constant: string
  punctuation: string
}

// Monaco rule foregrounds are bare hex without the leading '#'.
function tokenRules(palette: SyntaxPalette): GraphiteThemeData['rules'] {
  const bare = (hex: string): string => hex.slice(1)
  return [
    { token: 'keyword', foreground: bare(palette.keyword) },
    { token: 'keyword.control', foreground: bare(palette.keyword) },
    { token: 'storage', foreground: bare(palette.keyword) },
    { token: 'function', foreground: bare(palette.function) },
    { token: 'entity.name.function', foreground: bare(palette.function) },
    { token: 'support.function', foreground: bare(palette.function) },
    { token: 'string', foreground: bare(palette.string) },
    { token: 'string.escape', foreground: bare(palette.string) },
    { token: 'number', foreground: bare(palette.number) },
    { token: 'constant.numeric', foreground: bare(palette.number) },
    { token: 'comment', foreground: bare(palette.comment), fontStyle: 'italic' },
    { token: 'type', foreground: bare(palette.type) },
    { token: 'type.identifier', foreground: bare(palette.type) },
    { token: 'entity.name.type', foreground: bare(palette.type) },
    { token: 'constant', foreground: bare(palette.constant) },
    { token: 'variable.constant', foreground: bare(palette.constant) },
    { token: 'delimiter', foreground: bare(palette.punctuation) },
    { token: 'punctuation', foreground: bare(palette.punctuation) }
  ]
}

const DARK_THEME: GraphiteThemeData = {
  base: 'vs-dark',
  inherit: true,
  rules: tokenRules({
    keyword: '#c79bff',
    function: '#6fb3ff',
    string: '#6dd6b4',
    number: '#ff9d7a',
    comment: '#8a909b',
    type: '#5fd0d6',
    constant: '#d6b58c',
    punctuation: '#a0a6b1'
  }),
  colors: {
    'editor.background': '#16171b',
    'editor.foreground': '#eceef2',
    'editor.selectionBackground': '#5fd0d638',
    'editorLineNumber.foreground': '#7c828d',
    'editorLineNumber.activeForeground': '#eceef2',
    'editorWidget.background': '#1b1c21',
    'editorWidget.border': '#24262c',
    'editorSuggestWidget.background': '#1b1c21',
    'editorSuggestWidget.border': '#24262c',
    'diffEditor.insertedTextBackground': '#3fb95024',
    'diffEditor.insertedLineBackground': '#3fb95024',
    'diffEditor.removedTextBackground': '#e5534b24',
    'diffEditor.removedLineBackground': '#e5534b24'
  }
}

const LIGHT_THEME: GraphiteThemeData = {
  base: 'vs',
  inherit: true,
  rules: tokenRules({
    keyword: '#7f4fc9',
    function: '#2a6cb5',
    string: '#1a7a5c',
    number: '#b4532f',
    comment: '#5c6570',
    type: '#0f6f78',
    constant: '#8f6a3a',
    punctuation: '#57606a'
  }),
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#1b1d22',
    'editor.selectionBackground': '#14808a38',
    'editorLineNumber.foreground': '#646b76',
    'editorLineNumber.activeForeground': '#1b1d22',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#e3e5ea',
    'editorSuggestWidget.background': '#ffffff',
    'editorSuggestWidget.border': '#e3e5ea',
    'diffEditor.insertedTextBackground': '#2da44e1f',
    'diffEditor.insertedLineBackground': '#2da44e1f',
    'diffEditor.removedTextBackground': '#cf222e1a',
    'diffEditor.removedLineBackground': '#cf222e1a'
  }
}

/** Registers the graphite dark and light editor themes; safe to call repeatedly. */
export function defineGraphiteMonacoThemes(m: MonacoModule): void {
  m.editor.defineTheme(MONACO_THEME_DARK, DARK_THEME)
  m.editor.defineTheme(MONACO_THEME_LIGHT, LIGHT_THEME)
}
