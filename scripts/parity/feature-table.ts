import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const REQUIRED_FEATURE_IDS = [
  'terminal-workspace',
  'terminal-dock',
  'agent-state',
  'launch-settings',
  'notifications',
  'workspace-cards',
  'workspace-comments',
  'sidebar-activity',
  'reader-editor',
  'non-code-files',
  'changes',
  'hosted-review',
  'hosted-issues-checks',
  'pr-sitter',
  'vault-search',
  'session-handoff',
  'session-info',
  'watchers',
  'objective-runner',
  'project-ledger',
  'mobile-owner-access',
  'linked-references',
  'remote-workspaces',
  'environment-recipes',
  'diagnostics-memory',
  'runtime-health',
  'loop-workflow',
  'excluded-publishing',
  'excluded-computer-and-trackers',
  'excluded-dictation-and-chat',
  'excluded-remote-hosts',
  'excluded-operations',
  'excluded-provider-profiles',
  'excluded-quick-open',
  'excluded-emulator-and-teams',
  'delegated-browser',
  'delegated-command-discovery',
  'delegated-definitions-references',
  'delegated-profile-recovery'
] as const

export type FeatureDisposition = 'covered' | 'gap' | 'excluded' | 'delegated'

export interface FeatureCheck {
  file: string
  testTitle: string | null
}

export interface FeatureTableRow {
  id: string
  disposition: FeatureDisposition
  checks: FeatureCheck[]
  reason: string | null
}

export interface FeatureTableError {
  code: string
  rowId: string | null
  file: string | null
}

export interface FeatureTableExport {
  schemaVersion: 1
  rows: FeatureTableRow[]
  errors: FeatureTableError[]
}

const USAGE = 'Usage: bun scripts/parity/feature-table.ts [--json | --help]'
const REQUIRED_HEADERS = ['ID', 'Orca feature / provenance', 'Quirky equivalent', 'Check', 'Disposition / reason']
const CHECK_PATTERN = /`(bun test[^`]*)`(?:\s+title:\s*`([^`]+)`)?/g

function markdownCells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
}

function checkPathsFromList(list: string): Set<string> {
  return new Set(list
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => line.split(/\s+/)[0]!))
}

function isRepositoryRelativeFile(file: string): boolean {
  return file.length > 0 && !file.startsWith('-') && !file.includes(':') && !isAbsolute(file) &&
    !file.includes('\\') && !file.includes('\0') &&
    file.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}

function existsUnderRoot(root: string, file: string): boolean {
  if (!isRepositoryRelativeFile(file)) return false
  const absoluteRoot = resolve(root)
  const absoluteFile = resolve(absoluteRoot, file)
  const fromRoot = relative(absoluteRoot, absoluteFile)
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot) && existsSync(absoluteFile)
}

function parseChecks(cell: string, rowId: string, errors: FeatureTableError[]): FeatureCheck[] {
  const checks: FeatureCheck[] = []
  let invalid = false
  for (const match of cell.matchAll(CHECK_PATTERN)) {
    const command = /^bun test (\S+)$/.exec(match[1]!)
    if (!command || !isRepositoryRelativeFile(command[1]!)) {
      invalid = true
      continue
    }
    checks.push({ file: command[1]!, testTitle: match[2] ?? null })
  }
  if ([...cell.matchAll(/\bbun\s+test\b/g)].length !== checks.length) invalid = true
  if (invalid) errors.push({ code: 'invalid-check', rowId, file: null })
  return checks
}

function readRows(markdown: string, errors: FeatureTableError[]): FeatureTableRow[] {
  let indexes: Map<string, number> | null = null
  const rows: FeatureTableRow[] = []

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = markdownCells(line)
    if (indexes === null) {
      if (cells[0] !== 'ID') continue
      if (REQUIRED_HEADERS.some((header) => !cells.includes(header))) {
        errors.push({ code: 'invalid-header', rowId: null, file: null })
        return rows
      }
      indexes = new Map(cells.map((header, index) => [header, index]))
      continue
    }
    if (isSeparator(cells)) continue

    const id = cells[indexes.get('ID')!] ?? ''
    const checkCell = cells[indexes.get('Check')!] ?? ''
    const dispositionCell = cells[indexes.get('Disposition / reason')!] ?? ''
    if (cells.length !== indexes.size || id.length === 0) {
      errors.push({ code: 'invalid-row', rowId: id || null, file: null })
      continue
    }

    const dispositionMatch = /^(covered|gap|excluded|delegated)(?::\s*(.*))?$/.exec(dispositionCell)
    if (!dispositionMatch) {
      errors.push({ code: 'invalid-disposition', rowId: id, file: null })
      continue
    }

    const disposition = dispositionMatch[1] as FeatureDisposition
    rows.push({
      id,
      disposition,
      checks: parseChecks(checkCell, id, errors),
      reason: disposition === 'covered' ? null : dispositionMatch[2]?.trim() ?? null
    })
  }

  if (indexes === null) errors.push({ code: 'missing-table', rowId: null, file: null })
  return rows
}

export function parseFeatureTable(
  markdown: string,
  repositoryRoot: string,
  notOnCiList: string,
  requiredIds: readonly string[] = REQUIRED_FEATURE_IDS
): FeatureTableExport {
  const errors: FeatureTableError[] = []
  const rows = readRows(markdown, errors)
  const notOnCi = checkPathsFromList(notOnCiList)
  const seen = new Set<string>()

  for (const row of rows) {
    if (seen.has(row.id)) errors.push({ code: 'duplicate-feature', rowId: row.id, file: null })
    seen.add(row.id)
  }
  for (const id of requiredIds) {
    if (!seen.has(id)) errors.push({ code: 'missing-feature', rowId: id, file: null })
  }

  for (const row of rows) {
    if (row.disposition !== 'covered' && !row.reason) {
      errors.push({ code: 'missing-reason', rowId: row.id, file: null })
    }
    if (row.disposition === 'covered' && row.checks.length === 0) {
      errors.push({ code: 'missing-check', rowId: row.id, file: null })
    }
    for (const check of row.checks) {
      if (row.disposition !== 'covered') continue
      if (!existsUnderRoot(repositoryRoot, check.file)) {
        errors.push({ code: 'missing-check', rowId: row.id, file: check.file })
      }
      if (notOnCi.has(check.file)) {
        errors.push({ code: 'check-not-on-ci', rowId: row.id, file: check.file })
      }
    }
  }

  return {
    schemaVersion: 1,
    rows: errors.length === 0 ? rows : [],
    errors
  }
}

function readExport(): FeatureTableExport {
  const repositoryRoot = resolve(import.meta.dir, '../..')
  const tablePath = resolve(repositoryRoot, 'docs/parity/orca-features.md')
  const notOnCiPath = resolve(repositoryRoot, 'scripts/test-not-on-ci.txt')
  let markdown: string
  try {
    markdown = readFileSync(tablePath, 'utf8')
  } catch {
    return { schemaVersion: 1, rows: [], errors: [{ code: 'read-error', rowId: null, file: 'docs/parity/orca-features.md' }] }
  }
  let notOnCi: string
  try {
    notOnCi = readFileSync(notOnCiPath, 'utf8')
  } catch {
    return { schemaVersion: 1, rows: [], errors: [{ code: 'read-error', rowId: null, file: 'scripts/test-not-on-ci.txt' }] }
  }
  return parseFeatureTable(markdown, repositoryRoot, notOnCi)
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    console.log(USAGE)
    return 0
  }
  if (args.length !== 1 || args[0] !== '--json') {
    console.error(USAGE)
    return 2
  }

  const result = readExport()
  console.log(JSON.stringify(result))
  return result.errors.length === 0 ? 0 : 1
}

if (import.meta.main) process.exitCode = await main()
