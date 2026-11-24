/**
 * The end of a slot's quirkyd.log, appended to a failed deploy, launch or rollback so the error
 * says why quirkyd stopped rather than only where its log is. Errors and the main log only; never
 * telemetry. Best-effort: a host that can't answer leaves the error as it was.
 */
import { redactString } from '../../observability/redactor'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { QUIRKYD_LOG_FILENAME } from './quirkyd-remote-host-support'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import {
  quirkydWindowsSlotOpCommand,
  readQuirkydWindowsEncodedAnswer
} from './quirkyd-remote-windows-node'
import { QUIRKYD_WINDOWS_LOG_TAIL_MARKER } from '../host-state/quirkyd-windows-host-script'
import type { QuirkydRemoteExecTarget } from './quirkyd-remote-runtime-control'

export const QUIRKYD_LOG_TAIL_LINES = 40
export const QUIRKYD_LOG_TAIL_MAX_BYTES = 8 * 1024
// Short, because it only decorates an error the caller already has.
const QUIRKYD_LOG_TAIL_TIMEOUT_MS = 10_000

export function quirkydLogTailCommand(host: RemoteHostPlatform, slotDir: string): string {
  const log = joinRemotePath(host, slotDir, QUIRKYD_LOG_FILENAME)
  if (isWindowsRemoteHost(host)) {
    return quirkydWindowsSlotOpCommand(host, slotDir, 'log-tail', [
      log,
      String(QUIRKYD_LOG_TAIL_MAX_BYTES)
    ])
  }
  return `tail -c ${QUIRKYD_LOG_TAIL_MAX_BYTES} ${quotePosixShell(log)} 2>/dev/null || true`
}

/** The last lines of what the host printed, redacted; null when the log is empty or absent. */
export function parseQuirkydLogTail(host: RemoteHostPlatform, output: string): string | null {
  const raw = isWindowsRemoteHost(host)
    ? (readQuirkydWindowsEncodedAnswer(output, QUIRKYD_WINDOWS_LOG_TAIL_MARKER) ?? '')
    : output
  const bounded = Buffer.from(raw, 'utf8').subarray(-QUIRKYD_LOG_TAIL_MAX_BYTES).toString('utf8')
  const lines = bounded.replace(/\s+$/u, '').split(/\r?\n/u).slice(-QUIRKYD_LOG_TAIL_LINES)
  const tail = redactString(lines.join('\n'))
  return tail.trim() ? tail : null
}

export async function readQuirkydLogTail(
  target: QuirkydRemoteExecTarget,
  slotDir: string
): Promise<string | null> {
  try {
    // No abort signal: the failure being reported may be the cancellation itself.
    const output = await execCommand(target.conn, quirkydLogTailCommand(target.host, slotDir), {
      wrapCommand: target.host.commandDialect !== 'powershell',
      timeoutMs: QUIRKYD_LOG_TAIL_TIMEOUT_MS
    })
    return parseQuirkydLogTail(target.host, output)
  } catch (error) {
    console.warn('[ssh] Could not read the quirkyd.log tail:', error)
    return null
  }
}

/** `message` followed by the log tail, or `message` alone when the host had none to give. */
export async function withQuirkydLogTail(
  target: QuirkydRemoteExecTarget,
  slotDir: string,
  message: string
): Promise<string> {
  const tail = await readQuirkydLogTail(target, slotDir)
  return tail ? `${message}\nLast lines of quirkyd.log:\n${tail}` : message
}
