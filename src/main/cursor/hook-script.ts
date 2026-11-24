import {
  buildWindowsAgentHookPostCommand,
  wrapPosixHookCommand,
  buildWindowsHookPowerShellCommand,
  wrapWindowsPowerShellEncodedCommand
} from '../agent-hooks/installer-utils'
import {
  buildPosixHookPayloadCapture,
  buildPosixHookSpoolLines,
  buildWindowsHookEnvironmentGuardLines,
  buildWindowsHookStdinDrainEpilogue
} from '../agent-hooks/hook-stdin-contract'
import {
  buildPosixGrokReplayGuardLines,
  buildWindowsGrokReplayGuardLines
} from '../agent-hooks/grok-replay-guard'
import { quoteStartupArg } from '../../shared/tui-agent-startup-shell'
import { getCursorHookResponse, type CursorEvent } from './hook-events'

const CURSOR_HOOK_RESPONSE_ENV = 'QUIRKY_CURSOR_HOOK_RESPONSE'

export function getPosixManagedCommand(scriptPath: string, eventName: CursorEvent): string {
  const response = getCursorHookResponse(eventName)
  return wrapPosixHookCommand(
    scriptPath,
    { [CURSOR_HOOK_RESPONSE_ENV]: response },
    { fallbackStdout: response }
  )
}

export function getManagedCommand(scriptPath: string, eventName: CursorEvent): string {
  if (process.platform !== 'win32') {
    // Cursor uses the login shell; keep the POSIX guard inside sh with portable argument quoting.
    return `/bin/sh -c ${quoteStartupArg(getPosixManagedCommand(scriptPath, eventName), 'posix')}`
  }
  const response = getCursorHookResponse(eventName)
  const command = buildWindowsHookPowerShellCommand(
    scriptPath,
    { [CURSOR_HOOK_RESPONSE_ENV]: response },
    { fallbackStdout: response }
  )
  // PowerShell 5.1 defaults to the ANSI code page when translating hook stdin.
  return wrapWindowsPowerShellEncodedCommand(
    `[Console]::InputEncoding = New-Object System.Text.UTF8Encoding; $OutputEncoding = [Console]::InputEncoding; ${command}`
  )
}

export function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return [
      '@echo off',
      'setlocal',
      // Why: Cursor permission hooks fail closed on empty/invalid stdout (#15462).
      `if defined ${CURSOR_HOOK_RESPONSE_ENV} (echo %${CURSOR_HOOK_RESPONSE_ENV}%) else (echo {})`,
      // Why: source current endpoint coordinates for PTYs surviving an Quirky restart.
      'if defined QUIRKY_AGENT_HOOK_ENDPOINT if exist "%QUIRKY_AGENT_HOOK_ENDPOINT%" call "%QUIRKY_AGENT_HOOK_ENDPOINT%" 2>nul',
      ...buildWindowsHookEnvironmentGuardLines(),
      ...buildWindowsGrokReplayGuardLines(),
      buildWindowsAgentHookPostCommand('cursor'),
      'exit /b 0',
      ...buildWindowsHookStdinDrainEpilogue(),
      ''
    ].join('\r\n')
  }

  return [
    '#!/bin/sh',
    // Why: Cursor permission hooks fail closed on empty/invalid stdout (#15462).
    `if [ -n "$${CURSOR_HOOK_RESPONSE_ENV}" ]; then`,
    `  printf '%s\\n' "$${CURSOR_HOOK_RESPONSE_ENV}"`,
    'else',
    '  printf "{}\\n"',
    'fi',
    ...buildPosixHookPayloadCapture(),
    ...buildPosixGrokReplayGuardLines(),
    ...buildPosixHookSpoolLines('cursor'),
    // Why: refresh endpoint coordinates so surviving PTYs keep reporting.
    'if [ -n "$QUIRKY_AGENT_HOOK_ENDPOINT" ] && [ -r "$QUIRKY_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$QUIRKY_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$QUIRKY_AGENT_HOOK_PORT" ] || [ -z "$QUIRKY_AGENT_HOOK_TOKEN" ] || [ -z "$QUIRKY_PANE_KEY" ]; then',
    '  spool_hook_event',
    '  exit 0',
    'fi',
    // Why: post form fields because path-bearing worktree IDs are unsafe in hand-built JSON.
    // Why: pipe payload to curl stdin to keep large output off the command line.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${QUIRKY_AGENT_HOOK_PORT}/hook/cursor" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Quirky-Agent-Hook-Token: ${QUIRKY_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${QUIRKY_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${QUIRKY_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${QUIRKY_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${QUIRKY_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${QUIRKY_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${QUIRKY_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || spool_hook_event',
    'exit 0',
    ''
  ].join('\n')
}
