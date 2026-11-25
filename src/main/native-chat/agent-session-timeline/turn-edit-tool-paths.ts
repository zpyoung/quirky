import { isAbsolute, relative, resolve } from 'node:path'
import { isRecord } from '../../../shared/agent-status-child-work-value-guards'
import type { AgentJournalItemBody } from '../../../shared/agent-session-journal-types'
import type { TurnChangesFile } from '../../../shared/agent-session-journal-v1-items'

const EDIT_TOOL_NAMES = new Set([
  'edit',
  'write',
  'multiedit',
  'notebookedit',
  'apply_patch',
  'patch',
  'str_replace_editor'
])

const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'filePath', 'file'] as const
const PATCH_FIELDS = ['input', 'patch'] as const
const PATCH_FILE_HEADER = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm
const BRACKETED_PATH = /^\[([^\]#\n]+)(?:#[^\]\n]*)?\]/gm
const MULTI_FILE_DIFF_PATH = /^\d+ files$/

function stringField(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') {
      return value
    }
  }
  return undefined
}

function patchPaths(patch: string): string[] {
  const found = [...patch.matchAll(PATCH_FILE_HEADER)].map((match) => match[1]?.trim() ?? '')
  if (found.length === 0) {
    found.push(...[...patch.matchAll(BRACKETED_PATH)].map((match) => match[1] ?? ''))
  }
  return found.filter((path) => path !== '')
}

/** Paths one completed edit tool call or `diff` item names: Claude `Edit`/`Write`/`MultiEdit`/
 *  `NotebookEdit`, Codex `apply_patch` and `diff`, and the ACP and pi edit tools. Empty for every
 *  other row, and for a call that did not complete. */
export function editedPathsOfItem(body: AgentJournalItemBody): string[] {
  if (body.kind === 'diff') {
    // Codex names a multi-file change by its count, which is no path.
    return MULTI_FILE_DIFF_PATH.test(body.path) ? [] : [body.path]
  }
  if (
    body.kind !== 'tool-call' ||
    body.state !== 'completed' ||
    !EDIT_TOOL_NAMES.has(body.name.toLowerCase())
  ) {
    return []
  }
  const { input } = body
  if (!isRecord(input)) {
    return []
  }
  const fields = input
  const direct = stringField(fields, PATH_FIELDS)
  if (direct !== undefined) {
    return [direct]
  }
  const patch = stringField(fields, PATCH_FIELDS)
  if (patch !== undefined) {
    return patchPaths(patch)
  }
  if (Array.isArray(fields.changes)) {
    return fields.changes.flatMap((change) => {
      const path = isRecord(change) ? stringField(change, ['path']) : undefined
      return path === undefined ? [] : [path]
    })
  }
  return []
}

/** The turn's edited files as `turn-changes` entries: workspace-relative when inside `cwd`,
 *  deduplicated in the order first named. Status is `modified` because no tool says whether it
 *  created the file. */
export function editToolFiles(paths: readonly string[], cwd: string): TurnChangesFile[] {
  const seen = new Set<string>()
  const files: TurnChangesFile[] = []
  for (const raw of paths) {
    const inside = relative(cwd, resolve(cwd, raw))
    const path = isAbsolute(raw) && (inside.startsWith('..') || isAbsolute(inside)) ? raw : inside
    if (path === '' || seen.has(path)) {
      continue
    }
    seen.add(path)
    files.push({ path, status: 'modified' })
  }
  return files
}
