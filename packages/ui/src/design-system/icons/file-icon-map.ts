import type { GeneratedFileIconName } from './generated-files'

const FILENAMES: Record<string, GeneratedFileIconName> = {
  'package.json': 'package-json',
  'package-lock.json': 'npm-lock',
  'npm-shrinkwrap.json': 'npm-lock',
  'pnpm-lock.yaml': 'pnpm-lock',
  'yarn.lock': 'yarn-lock',
  'bun.lock': 'bun-lock',
  'bun.lockb': 'bun-lock',
  'cargo.lock': 'cargo-lock',
  'cargo.toml': 'cargo',
  'go.mod': 'go-mod',
  'go.sum': 'lock',
  'dockerfile': 'docker',
  '.dockerignore': 'docker',
  'docker-compose.yml': 'docker-compose',
  'docker-compose.yaml': 'docker-compose',
  'compose.yml': 'docker-compose',
  'compose.yaml': 'docker-compose',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitkeep': 'git',
  '.editorconfig': 'editorconfig',
  '.npmrc': 'npm',
  '.nvmrc': 'npm',
  'makefile': 'makefile',
  'readme': 'readme',
  'readme.md': 'readme',
  'license': 'license',
  'license.md': 'license',
  'license.txt': 'license',
  'copying': 'license'
}

const NAME_PREFIXES: readonly [prefix: string, icon: GeneratedFileIconName][] = [
  ['.env', 'env'],
  ['.eslintrc', 'eslint'],
  ['eslint.config.', 'eslint'],
  ['.prettierrc', 'prettier'],
  ['prettier.config.', 'prettier'],
  ['vite.config.', 'vite'],
  ['tailwind.config.', 'tailwind']
]

const EXTENSIONS: Record<string, GeneratedFileIconName> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'typescript-react',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascript-react',
  json: 'json', jsonc: 'json', json5: 'json',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  html: 'html', htm: 'html',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  ps1: 'powershell',
  py: 'python', pyi: 'python', pyw: 'python',
  rs: 'rust',
  go: 'go',
  yml: 'yaml', yaml: 'yaml',
  toml: 'toml',
  sql: 'database', db: 'database', sqlite: 'database',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', ico: 'image', avif: 'image',
  svg: 'svg',
  lock: 'lock', lockb: 'bun-lock',
  txt: 'text',
  xml: 'xml',
  csv: 'csv',
  pdf: 'pdf',
  zip: 'zip', tar: 'zip', gz: 'zip', tgz: 'zip',
  log: 'log',
  env: 'env',
  conf: 'config', cfg: 'config', ini: 'config',
  mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video'
}

const own = (table: Record<string, GeneratedFileIconName>, key: string) => (Object.hasOwn(table, key) ? table[key] : undefined)

/**
 * The Catppuccin icon name for a file path. Exact filenames win over extensions, extensions match
 * case-insensitively, and anything unrecognised (including extensionless files and unknown dotfiles)
 * is the plain `file` icon.
 */
export function fileIconName(path: string): GeneratedFileIconName {
  const filename = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  if (filename === '') return 'file'
  const lower = filename.toLowerCase()
  const exact = own(FILENAMES, filename) ?? own(FILENAMES, lower)
  if (exact) return exact
  if (/^tsconfig(?:\.[^.]+)*\.json$/.test(lower)) return 'typescript-config'
  if (lower.endsWith('.d.ts') || lower.endsWith('.d.mts') || lower.endsWith('.d.cts')) return 'typescript-def'
  const prefixed = NAME_PREFIXES.find(([prefix]) => lower.startsWith(prefix))
  if (prefixed) return prefixed[1]
  const dot = lower.lastIndexOf('.')
  return dot > 0 ? own(EXTENSIONS, lower.slice(dot + 1)) ?? 'file' : 'file'
}
