import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { SessionInfoStatusLineChainStatus } from '../../shared/fork-session-info/session-info-types'
import {
  createManagedCommandMatcher,
  getSharedManagedScriptPath,
  isPlainObject,
  readHooksJsonWithRaw,
  writeHooksJson,
  writeManagedScript,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import {
  CLAUDE_HOOK_SETTINGS,
  getConfigPath,
  getManagedCommand,
  getStatusLineInstallMarkerPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  removeManagedStatusLine as removeUpstreamManagedStatusLine
} from '../claude/hook-settings'
import {
  getManagedStatusLineScript,
  POSIX_STATUSLINE_CHAIN_RUNNER,
  WINDOWS_STATUSLINE_CHAIN_RUNNER
} from './session-info-statusline-chain-script'

export { getManagedStatusLineScript }

const CHAIN_METADATA_FILE = 'claude-statusline-chain.json'
const CHAIN_LOCK_FILE = 'claude-statusline-chain.lock'
const CHAIN_METADATA_VERSION = 1
const STALE_LOCK_MILLISECONDS = 30_000

type CapturedStatusLine = Record<string, unknown> & { command: string }
type ChainMetadata = { version: 1; statusLine: CapturedStatusLine }
type MetadataRead =
  | { state: 'absent' }
  | { state: 'invalid' }
  | { state: 'valid'; value: ChainMetadata }

function getMetadataPath(): string {
  return getSharedManagedScriptPath(CHAIN_METADATA_FILE)
}

function getLockPath(): string {
  return getSharedManagedScriptPath(CHAIN_LOCK_FILE)
}

function getRunnerPath(windows = process.platform === 'win32'): string {
  return getSharedManagedScriptPath(
    windows ? WINDOWS_STATUSLINE_CHAIN_RUNNER : POSIX_STATUSLINE_CHAIN_RUNNER
  )
}

function readMetadata(): MetadataRead {
  const path = getMetadataPath()
  if (!existsSync(path)) {
    return { state: 'absent' }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (
      !isPlainObject(parsed) ||
      parsed.version !== CHAIN_METADATA_VERSION ||
      !isPlainObject(parsed.statusLine) ||
      typeof parsed.statusLine.command !== 'string'
    ) {
      return { state: 'invalid' }
    }
    return {
      state: 'valid',
      value: {
        version: CHAIN_METADATA_VERSION,
        statusLine: parsed.statusLine as CapturedStatusLine
      }
    }
  } catch {
    return { state: 'invalid' }
  }
}

function writePrivateFile(path: string, content: string, mode: number): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporaryPath = join(directory, `.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporaryPath, content, { encoding: 'utf-8', mode })
    if (process.platform !== 'win32') {
      chmodSync(temporaryPath, mode)
    }
    renameSync(temporaryPath, path)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function getRunnerContent(command: string): string {
  if (process.platform === 'win32') {
    return `@echo off\r\n${command}${command.endsWith('\n') ? '' : '\r\n'}`
  }
  return `#!/bin/sh\n${command}${command.endsWith('\n') ? '' : '\n'}`
}

function cleanupChainFiles(): void {
  for (const path of [getMetadataPath(), getRunnerPath(false), getRunnerPath(true)]) {
    try {
      rmSync(path, { force: true })
    } catch {
      // cleanup is best-effort because settings ownership must not depend on stale sidecars
    }
  }
}

function isFileError(error: unknown, code: string): boolean {
  return isPlainObject(error) && error.code === code
}

function acquireLock(): number | null {
  const path = getLockPath()
  mkdirSync(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return openSync(path, 'wx', 0o600)
    } catch (error) {
      if (!isFileError(error, 'EEXIST')) {
        throw error
      }
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_LOCK_MILLISECONDS) {
          rmSync(path, { force: true })
          continue
        }
      } catch {
        continue
      }
      return null
    }
  }
  return null
}

function releaseLock(descriptor: number): void {
  try {
    closeSync(descriptor)
  } finally {
    try {
      rmSync(getLockPath(), { force: true })
    } catch {
      // a stale lock is recovered by the next explicit enable attempt
    }
  }
}

/** Reports whether Claude's single status-line slot can safely opt into chaining. */
export function getSessionInfoStatusLineChainStatus(): SessionInfoStatusLineChainStatus {
  const configPath = getConfigPath(CLAUDE_HOOK_SETTINGS)
  const snapshot = readHooksJsonWithRaw(configPath)
  if (!snapshot.config) {
    return { state: 'error', detail: 'Claude settings could not be read.' }
  }

  const metadata = readMetadata()
  if (metadata.state === 'invalid') {
    return { state: 'error', detail: 'Status line chain metadata is invalid.' }
  }
  const slot = getStatusLineSlotState(snapshot.config)
  if (slot === 'managed') {
    if (metadata.state === 'valid' && existsSync(getRunnerPath())) {
      return { state: 'chained' }
    }
    return metadata.state === 'valid'
      ? { state: 'error', detail: 'The captured status line runner is missing.' }
      : { state: 'managed' }
  }
  if (metadata.state === 'valid') {
    return {
      state: 'drifted',
      detail: 'Claude status line settings changed after chaining was enabled.'
    }
  }
  return slot === 'user'
    ? { state: 'available' }
    : { state: 'disabled', detail: 'Claude has no custom status line to chain.' }
}

/** Captures a user-owned Claude status line and installs the managed chain. */
export function enableSessionInfoStatusLineChaining(): SessionInfoStatusLineChainStatus {
  let descriptor: number | null = null
  try {
    descriptor = acquireLock()
    if (descriptor === null) {
      return { state: 'error', detail: 'Status line chaining is busy.' }
    }
    const existingStatus = getSessionInfoStatusLineChainStatus()
    if (existingStatus.state === 'chained') {
      return existingStatus
    }

    const configPath = getConfigPath(CLAUDE_HOOK_SETTINGS)
    const snapshot = readHooksJsonWithRaw(configPath)
    const current = snapshot.config?.statusLine
    const command = isPlainObject(current) ? current.command : undefined
    if (!snapshot.config || typeof command !== 'string') {
      return { state: 'disabled', detail: 'Claude has no custom status line to chain.' }
    }
    if (createManagedCommandMatcher(getStatusLineScriptFileName())(command)) {
      return { state: 'managed' }
    }
    if (getStatusLineSlotState(snapshot.config) !== 'user') {
      return { state: 'disabled', detail: 'Claude has no custom status line to chain.' }
    }

    const metadata: ChainMetadata = {
      version: CHAIN_METADATA_VERSION,
      statusLine: current as CapturedStatusLine
    }
    writePrivateFile(getRunnerPath(), getRunnerContent(command), 0o700)
    writePrivateFile(getMetadataPath(), `${JSON.stringify(metadata, null, 2)}\n`, 0o600)

    if (readHooksJsonWithRaw(configPath).raw !== snapshot.raw) {
      return {
        state: 'drifted',
        detail: 'Claude status line settings changed while chaining was enabled.'
      }
    }

    const managedScriptPath = getStatusLineScriptPath(CLAUDE_HOOK_SETTINGS)
    writeManagedScript(managedScriptPath, getManagedStatusLineScript('local'))
    writeHooksJson(
      configPath,
      {
        ...snapshot.config,
        statusLine: {
          ...(current as CapturedStatusLine),
          type: 'command',
          command: getManagedCommand(managedScriptPath)
        }
      },
      { preserveMode: true }
    )
    writePrivateFile(getStatusLineInstallMarkerPath(CLAUDE_HOOK_SETTINGS), '', 0o600)
    return getSessionInfoStatusLineChainStatus()
  } catch {
    return { state: 'error', detail: 'Status line chaining could not be enabled.' }
  } finally {
    if (descriptor !== null) {
      releaseLock(descriptor)
    }
  }
}

/** Delete captured chain state after the settings update has committed. */
export function finalizeManagedStatusLineRemoval(
  scriptFileName = getStatusLineScriptFileName()
): void {
  if (scriptFileName === getStatusLineScriptFileName(CLAUDE_HOOK_SETTINGS)) {
    cleanupChainFiles()
  }
}

/** Remove Quirky's managed status line and restore its captured predecessor when safe. */
export function removeManagedStatusLine(
  config: HooksConfig,
  scriptFileName = getStatusLineScriptFileName()
): { config: HooksConfig; changed: boolean } {
  const removed = removeUpstreamManagedStatusLine(config, scriptFileName)
  if (scriptFileName !== getStatusLineScriptFileName(CLAUDE_HOOK_SETTINGS)) {
    return removed
  }

  const metadata = readMetadata()
  if (!removed.changed || metadata.state !== 'valid') {
    return removed
  }
  return {
    config: { ...removed.config, statusLine: metadata.value.statusLine },
    changed: true
  }
}
