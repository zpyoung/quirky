export type LanguageId = 'javascript' | 'jsx' | 'typescript' | 'tsx' | 'json' | 'markdown' | 'python' | 'plain'

const BY_EXTENSION: Record<string, LanguageId> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  md: 'markdown',
  py: 'python'
}

export function languageForPath(path: string): LanguageId {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return 'plain'
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'plain'
}
