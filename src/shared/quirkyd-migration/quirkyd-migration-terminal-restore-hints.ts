/**
 * The `terminal-restore-hints` blob: each moved pane's last working directory on the source, so
 * the destination reopens it there instead of at the worktree root. One JSON document per
 * migration; a later format is a new capability, never a silent reinterpretation of this one.
 */
import { z } from 'zod'
import { MAX_PANE_KEY_LEN } from '../agent-hook-listener/listener-limits'
import { QUIRKYD_MIGRATION_BLOB_KIND_CONTRACTS } from './quirkyd-migration-blob-transfer'
import { parsePaneKey } from '../stable-pane-id'

export const QUIRKYD_MIGRATION_TERMINAL_RESTORE_HINTS_VERSION = 1
export const QUIRKYD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY = 'migration'
export const MAX_QUIRKYD_MIGRATION_TERMINAL_RESTORE_HINTS = 8192
// Linux PATH_MAX; a longer cwd cannot be a directory a shell could have been in.
export const MAX_QUIRKYD_MIGRATION_TERMINAL_RESTORE_HINT_CWD_LENGTH = 4096
export const MAX_QUIRKYD_MIGRATION_TERMINAL_RESTORE_HINTS_BYTES =
  QUIRKYD_MIGRATION_BLOB_KIND_CONTRACTS['terminal-restore-hints'].maxBytes

export type QuirkydMigrationTerminalRestoreHint = { paneKey: string; cwd: string }

export type QuirkydMigrationTerminalRestoreHintsDocument = {
  version: typeof QUIRKYD_MIGRATION_TERMINAL_RESTORE_HINTS_VERSION
  hints: QuirkydMigrationTerminalRestoreHint[]
}

export function isQuirkydMigrationTerminalRestoreHintPaneKey(value: string): boolean {
  return value.length <= MAX_PANE_KEY_LEN && parsePaneKey(value) !== null
}

/** Absolute POSIX; `//` is refused because a UNC-style spelling never names a distro path. */
export function isQuirkydMigrationTerminalRestoreHintCwd(value: string): boolean {
  return (
    value.length <= MAX_QUIRKYD_MIGRATION_TERMINAL_RESTORE_HINT_CWD_LENGTH &&
    /^\/(?!\/)/.test(value) &&
    !value.includes('\0')
  )
}

const HintSchema = z.object({
  paneKey: z.string().refine(isQuirkydMigrationTerminalRestoreHintPaneKey, {
    message: 'quirkyd_migration_terminal_restore_hint_pane_key_invalid'
  }),
  cwd: z.string().refine(isQuirkydMigrationTerminalRestoreHintCwd, {
    message: 'quirkyd_migration_terminal_restore_hint_cwd_invalid'
  })
})

// Not strict: a same-version sender may add optional fields this build ignores.
export const QuirkydMigrationTerminalRestoreHintsDocumentSchema = z
  .object({
    version: z.literal(QUIRKYD_MIGRATION_TERMINAL_RESTORE_HINTS_VERSION),
    hints: z.array(HintSchema).max(MAX_QUIRKYD_MIGRATION_TERMINAL_RESTORE_HINTS)
  })
  .superRefine((value, context) => {
    const seen = new Set<string>()
    for (const hint of value.hints) {
      if (seen.has(hint.paneKey)) {
        context.addIssue({
          code: 'custom',
          message: 'quirkyd_migration_terminal_restore_hint_duplicate'
        })
        return
      }
      seen.add(hint.paneKey)
    }
  })

export function parseQuirkydMigrationTerminalRestoreHintsDocument(
  value: unknown
): QuirkydMigrationTerminalRestoreHintsDocument {
  const parsed = QuirkydMigrationTerminalRestoreHintsDocumentSchema.safeParse(value)
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? ''
    // Zod's own messages (wrong version, missing field) collapse into one stable code.
    throw new Error(
      message.startsWith('quirkyd_migration_terminal_restore_')
        ? message
        : 'quirkyd_migration_terminal_restore_hints_invalid'
    )
  }
  return {
    version: parsed.data.version,
    hints: parsed.data.hints.map((hint) => ({ paneKey: hint.paneKey, cwd: hint.cwd }))
  }
}

/** The blob's UTF-8 JSON text, size-checked before it is parsed. */
export function parseQuirkydMigrationTerminalRestoreHintsText(
  text: string
): QuirkydMigrationTerminalRestoreHintsDocument {
  if (text.length > MAX_QUIRKYD_MIGRATION_TERMINAL_RESTORE_HINTS_BYTES) {
    throw new Error('quirkyd_migration_terminal_restore_hints_too_large')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('quirkyd_migration_terminal_restore_hints_not_json')
  }
  return parseQuirkydMigrationTerminalRestoreHintsDocument(value)
}
