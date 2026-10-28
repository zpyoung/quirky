import { afterEach, beforeEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENVIRONMENT_KEYS = [
  'HOME', 'QUIRKY_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  'GIT_TERMINAL_PROMPT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
] as const

/** Isolate in-process plugin activation as well as child Git and Python processes. */
export function isolateEditorTestEnvironment(): () => void {
  const previous = new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]))
  const home = mkdtempSync(join(tmpdir(), 'quirky-editor-user-'))
  const xdg = join(home, 'xdg')
  mkdirSync(xdg)
  Object.assign(process.env, {
    HOME: home, QUIRKY_HOME: home, CODEX_HOME: join(home, '.codex'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0'
  })
  for (const key of [
    'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR',
    'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'
  ]) delete process.env[key]
  return () => {
    try {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  }
}

/** Run each file's owned teardown before restoring the ambient environment. */
export function registerIsolatedEditorFixtures(cleanup: () => Promise<void>): void {
  let restore: (() => void) | undefined
  beforeEach(() => { restore = isolateEditorTestEnvironment() })
  afterEach(async () => {
    try {
      await cleanup()
    } finally {
      restore?.()
      restore = undefined
    }
  })
}
