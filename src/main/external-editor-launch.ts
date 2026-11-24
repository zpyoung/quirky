import { quotePosixShellUnlessPlain } from '../shared/shell-argument-quoting'
import type { ChildProcess } from 'node:child_process'
import { spawnProcess } from '@orca/process-host'
import { existsSync } from 'node:fs'
import { posix } from 'node:path'
import { isVsCodeLauncherExecutable } from '../shared/vscode-remote-ssh-launcher'
import { resolveCliCommand } from './codex-cli/command'
import {
  getLauncherBaseName,
  hasMatchingOuterQuotes,
  stripMatchingQuotes
} from './editor-launcher-name'

export const EXTERNAL_EDITOR_CLI_COMMAND = 'code'

export type ExternalEditorExecutableLaunchSpec = {
  kind: 'executable'
  spawnCmd: string
  spawnArgs: string[]
}

export type ExternalEditorShellLaunchSpec = {
  kind: 'shell'
  spawnCmd: string
  spawnArgs: string[]
}

export type ExternalEditorLaunchSpec =
  | ExternalEditorExecutableLaunchSpec
  | ExternalEditorShellLaunchSpec

function escapePathForShell(pathValue: string): string {
  return quotePosixShellUnlessPlain(pathValue)
}

function isDirectExecutablePath(command: string, fileExists: (path: string) => boolean): boolean {
  const unquoted = stripMatchingQuotes(command)
  if (!/[\\/]/.test(unquoted)) {
    return false
  }
  if (!posix.isAbsolute(unquoted)) {
    return false
  }
  if (!/\s/.test(unquoted) || hasMatchingOuterQuotes(command)) {
    return true
  }
  // Why: unquoted POSIX paths can contain spaces, but so can shell commands
  // with arguments. Only an existing path is safe to treat as one executable.
  return fileExists(unquoted)
}

function buildExecutableArgs(editorCommand: string, pathValue: string): string[] {
  // Why: Cursor can route bare folder launches through the last active
  // workbench. A new window keeps "Open in Cursor" scoped to this worktree.
  return getLauncherBaseName(editorCommand) === 'cursor' ? ['--new-window', pathValue] : [pathValue]
}

function isCompoundShellCommand(command: string): boolean {
  return /\s/.test(command)
}

function buildExecutableLaunchSpec(
  editorCommand: string,
  pathValue: string
): ExternalEditorExecutableLaunchSpec {
  return {
    kind: 'executable',
    spawnCmd: editorCommand,
    spawnArgs: buildExecutableArgs(editorCommand, pathValue)
  }
}

function buildShellLaunchSpec(command: string, pathValue: string): ExternalEditorLaunchSpec {
  return {
    kind: 'shell',
    spawnCmd: '/bin/sh',
    spawnArgs: ['-c', `${command} ${escapePathForShell(pathValue)}`]
  }
}

export function resolveExternalEditorLaunchSpec(
  command: string | undefined,
  pathValue: string,
  options: { platform?: NodeJS.Platform; fileExists?: (path: string) => boolean } = {}
): ExternalEditorLaunchSpec {
  const platform = options.platform ?? process.platform
  const fileExists = options.fileExists ?? existsSync
  const trimmed = command?.trim() || EXTERNAL_EDITOR_CLI_COMMAND

  if (isDirectExecutablePath(trimmed, fileExists)) {
    return buildExecutableLaunchSpec(stripMatchingQuotes(trimmed), pathValue)
  }

  if (isCompoundShellCommand(trimmed)) {
    return buildShellLaunchSpec(trimmed, pathValue)
  }

  return buildExecutableLaunchSpec(resolveCliCommand(trimmed, { platform }), pathValue)
}

export function resolveVsCodeRemoteSshLaunchSpec(
  command: string | undefined,
  pathValue: string,
  authority: string,
  options: { platform?: NodeJS.Platform; fileExists?: (path: string) => boolean } = {}
): ExternalEditorLaunchSpec | null {
  const platform = options.platform ?? process.platform
  const fileExists = options.fileExists ?? existsSync
  const trimmed = command?.trim() || EXTERNAL_EDITOR_CLI_COMMAND

  let editorCommand: string
  if (isDirectExecutablePath(trimmed, fileExists)) {
    editorCommand = stripMatchingQuotes(trimmed)
  } else {
    if (isCompoundShellCommand(trimmed)) {
      return null
    }
    editorCommand = resolveCliCommand(trimmed, { platform })
  }

  if (!isVsCodeLauncherExecutable(editorCommand)) {
    return null
  }
  return {
    kind: 'executable',
    spawnCmd: editorCommand,
    spawnArgs: ['--remote', `ssh-remote+${authority}`, pathValue]
  }
}

function startExternalEditorProcess(launchSpec: ExternalEditorLaunchSpec): ChildProcess {
  return spawnProcess({
    program: launchSpec.spawnCmd,
    args: launchSpec.spawnArgs,
    detached: true,
    stdio: 'ignore'
  })
}

export async function launchExternalEditor(launchSpec: ExternalEditorLaunchSpec): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = startExternalEditorProcess(launchSpec)
    let settled = false
    function cleanup(): void {
      child.off('error', onError)
      child.off('spawn', onSpawn)
    }
    function settle(callback: () => void): void {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      callback()
    }
    function onError(error: Error): void {
      settle(() => rejectPromise(error))
    }
    function onSpawn(): void {
      child.unref()
      settle(resolvePromise)
    }
    child.once('error', onError)
    child.once('spawn', onSpawn)
  })
}
