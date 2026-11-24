import type { RuntimeTerminalSend } from '../../../shared/runtime-types'
import { isTerminalInputTooLargeWithDeferredMeasurement } from '../../../shared/terminal-input'
import { recordRuntimeTerminalInputForPtyId } from './runtime-terminal-input-recording'
import { callRuntimeRpc } from './runtime-rpc-client'
import { readTerminalSendAcknowledgment } from '../../../shared/terminal-send-acknowledgment'
import { sendRuntimePtyInputVerified as sendRuntimePtyInputVerifiedUpstream } from './runtime-terminal-verified-input'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimePtyOwner
} from './runtime-terminal-stream'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { isRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import {
  classifyTerminalProcessInspectionFailure,
  clientOnlyUnverifiableInspection,
  isClientOnlyUnverifiableInspection,
  type TerminalProcessInspection
} from '../../../shared/terminal-process-inspection'

import type { TerminalInputKind } from '../../../shared/terminal-input-kind'

export type RuntimeTerminalProcessInspection = TerminalProcessInspection

const DESKTOP_RUNTIME_CLIENT = { id: 'quirky-desktop', type: 'desktop' } as const
function isRuntimePtyInputTooLarge(data: string): boolean | Promise<boolean> {
  return isTerminalInputTooLargeWithDeferredMeasurement(data)
}

function isRemoteInspectionPtyId(ptyId: string): boolean {
  return getRemoteRuntimePtyEnvironmentId(ptyId) !== null || parseAppSshPtyId(ptyId) !== null
}

function normalizeInspectionResult(
  result: TerminalProcessInspection,
  remote: boolean
): RuntimeTerminalProcessInspection {
  if (typeof result !== 'object' || result === null) {
    return clientOnlyUnverifiableInspection(remote ? 'old_host' : 'terminal_gone')
  }
  // A client-only result may have crossed a mixed-version preload/runtime boundary.
  if (isClientOnlyUnverifiableInspection(result)) {
    return clientOnlyUnverifiableInspection(
      typeof result.reason === 'string' ? result.reason : 'transport_loss'
    )
  }
  // An old host has no evidence member. Its compatibility process name is not
  // an observation and must never reach remote identity consumers.
  if (remote && result.foregroundProcessEvidence === undefined) {
    return clientOnlyUnverifiableInspection('old_host')
  }
  // Older main/preload pairs may still return the removed boolean. Normalize it
  // at the boundary while those peers are being upgraded.
  if (
    result &&
    typeof result === 'object' &&
    'unavailable' in result &&
    (result as { unavailable?: unknown }).unavailable === true
  ) {
    return clientOnlyUnverifiableInspection('terminal_gone')
  }
  return result
}

export async function inspectRuntimeTerminalProcess(
  ptyId: string,
  options?: { expectedIncarnationId?: string; scanChildProcesses?: boolean; steadyState?: boolean }
): Promise<RuntimeTerminalProcessInspection> {
  const owner = getRemoteRuntimePtyOwner(ptyId)
  const remote = isRemoteInspectionPtyId(ptyId)
  if (!owner) {
    try {
      const result = await (options
        ? window.api.pty.inspectProcess(ptyId, options)
        : window.api.pty.inspectProcess(ptyId))
      return normalizeInspectionResult(result, remote)
    } catch (error) {
      const reason = classifyTerminalProcessInspectionFailure(error)
      if (reason) {
        return clientOnlyUnverifiableInspection(reason)
      }
      throw error
    }
  }

  try {
    const result = await callRuntimeRpc<{ process: RuntimeTerminalProcessInspection }>(
      owner.target,
      'terminal.inspectProcess',
      {
        terminal: owner.terminal,
        ...(options?.expectedIncarnationId
          ? { expectedIncarnationId: options.expectedIncarnationId }
          : {}),
        // Why forwarded: the close guards pass this so the host pays for a real child-process read.
        // Dropped here, the host declines to scan and answers `unverifiable`, which the guard reads
        // as running work -- a confirmation dialog on every idle close of a remote Windows pane.
        ...(options?.scanChildProcesses === true ? { scanChildProcesses: true } : {})
      },
      { timeoutMs: 15_000 }
    )
    return normalizeInspectionResult(result.process, true)
  } catch (error) {
    const reason = classifyTerminalProcessInspectionFailure(error)
    if (reason) {
      return clientOnlyUnverifiableInspection(reason)
    }
    throw error
  }
}

/**
 * Forces a fresh, uncached foreground scan for a pane whose cached inspection
 * is suspect (issue #11064: the cached read can flap to the shell for a live
 * agent). Local/daemon panes only — runtime environments expose no fresh-scan
 * RPC, and an SSH provider without confirm support answers null, which callers
 * must read as "no new evidence", never as a shell confirmation.
 */
export async function confirmRuntimeTerminalForegroundProcess(
  ptyId: string
): Promise<string | null> {
  // Why any remote id: an id without an owner segment still runs off this host, never locally.
  if (isRemoteRuntimePtyId(ptyId)) {
    return null
  }
  const confirmForegroundProcess = window.api.pty.confirmForegroundProcess
  // Why the shape check: a preload older than this handler has no such method.
  if (typeof confirmForegroundProcess !== 'function') {
    return null
  }
  return confirmForegroundProcess(ptyId).catch(() => null)
}

export function sendRuntimePtyInput(
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind
): boolean {
  const tooLarge = isRuntimePtyInputTooLarge(data)
  if (tooLarge === true) {
    return false
  }
  if (tooLarge !== false) {
    // Why: this is a fire-and-forget path, so accepted paste-sized input must
    // yield before validation and then dispatch without blocking the renderer.
    void tooLarge
      .then((resolvedTooLarge) => {
        if (!resolvedTooLarge) {
          sendRuntimePtyInputWithinLimit(ptyId, data, inputKind)
        }
      })
      .catch(() => {})
    return true
  }
  return sendRuntimePtyInputWithinLimit(ptyId, data, inputKind)
}

// Why the kind reaches only the local write: terminal.send has no launch kind, and its query-reply
// kind is for mobile clients, so the host classifies a desktop's environment write by its bytes.
function sendRuntimePtyInputWithinLimit(
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind
): boolean {
  const owner = getRemoteRuntimePtyOwner(ptyId)
  if (!owner) {
    window.api.pty.write(ptyId, data, inputKind)
    recordRuntimeTerminalInputForPtyId(ptyId)
    return true
  }

  void callRuntimeRpc<{ send: RuntimeTerminalSend }>(
    owner.target,
    'terminal.send',
    { terminal: owner.terminal, text: data, client: DESKTOP_RUNTIME_CLIENT },
    { timeoutMs: 15_000 }
  )
    .then((result) => {
      if (result.send.accepted === true) {
        recordRuntimeTerminalInputForPtyId(ptyId)
      }
    })
    .catch(() => {
      // Why: web session snapshots can retire a remote handle while xterm still
      // flushes a final input event. The next host snapshot will reattach.
    })
  return true
}

/** `unverifiable` means the write may or may not have landed: never resend its bytes. */
export type RuntimePtyInputDelivery = 'accepted' | 'refused' | 'unverifiable'

/**
 * Observed send for pipelines that must know what happened to a write before
 * issuing a follow-up (e.g. the composer's submit CR). Resolves only after the
 * deferred size check and, for a remote target, the RPC round-trip have
 * settled, and never throws. Local desktop writes report main's real answer.
 *
 * `isCancelled`, when given, is re-checked after the deferred size validation
 * and immediately before dispatch, so a cancel that lands while validation was
 * pending still stops the write. An in-flight RPC cannot be recalled.
 */
export async function sendRuntimePtyInputDelivery(
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  isCancelled?: () => boolean,
  writeOptions?: { requireWriteSettlement?: true }
): Promise<RuntimePtyInputDelivery> {
  const tooLarge = isRuntimePtyInputTooLarge(data)
  if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
    return 'refused'
  }
  if (isCancelled?.()) {
    return 'refused'
  }
  const owner = getRemoteRuntimePtyOwner(ptyId)
  if (!owner) {
    // Why: fire-and-forget `write` can't observe a PTY-gone or mobile-lease
    // rejection; settlement makes main answer over the provider, SSH included.
    try {
      const accepted = await window.api.pty.writeAccepted(ptyId, data, inputKind, {
        requireWriteSettlement: true
      })
      if (accepted) {
        recordRuntimeTerminalInputForPtyId(ptyId)
      }
      return accepted ? 'accepted' : 'refused'
    } catch {
      return 'unverifiable'
    }
  }
  try {
    const result = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      owner.target,
      'terminal.send',
      {
        terminal: owner.terminal,
        text: data,
        client: DESKTOP_RUNTIME_CLIENT,
        ...(writeOptions?.requireWriteSettlement ? { requireWriteSettlement: true } : {})
      },
      { timeoutMs: 15_000 }
    )
    if (result.send.accepted === true) {
      recordRuntimeTerminalInputForPtyId(ptyId)
    }
    return readTerminalSendAcknowledgment(result)
  } catch (error) {
    return classifyTerminalProcessInspectionFailure(error) === 'terminal_gone'
      ? 'refused'
      : 'unverifiable'
  }
}

/** `sendRuntimePtyInputDelivery` collapsed to "known accepted": a lost acknowledgment reads false. */
export async function sendRuntimePtyInputAcceptance(
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  isCancelled?: () => boolean
): Promise<boolean> {
  return (await sendRuntimePtyInputDelivery(ptyId, data, inputKind, isCancelled)) === 'accepted'
}

/**
 * Upstream's verified write, plus `isCancelled` for writes bound to a quarantine-scoped target:
 * it is re-checked after size validation and again before the local fallback write, so a
 * replaced PTY never receives a write queued for the old one.
 */
export async function sendRuntimePtyInputVerified(
  ptyId: string,
  data: string,
  inputKind: TerminalInputKind,
  options?: { requireWriteSettlement?: true; isCancelled?: () => boolean }
): Promise<boolean> {
  const isCancelled = options?.isCancelled
  const writeOptions = options?.requireWriteSettlement
    ? ({ requireWriteSettlement: true } as const)
    : undefined
  if (!isCancelled) {
    return sendRuntimePtyInputVerifiedUpstream(ptyId, data, inputKind, writeOptions)
  }
  const tooLarge = isRuntimePtyInputTooLarge(data)
  if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
    return false
  }
  if (isCancelled()) {
    return false
  }
  const owner = getRemoteRuntimePtyOwner(ptyId)
  if (!owner) {
    if (writeOptions?.requireWriteSettlement) {
      const settled = await window.api.pty.writeAccepted(ptyId, data, inputKind, writeOptions)
      if (settled) {
        recordRuntimeTerminalInputForPtyId(ptyId)
      }
      return settled
    }
    const accepted = await window.api.pty.writeAccepted(ptyId, data, inputKind)
    if (!accepted) {
      if (isCancelled()) {
        return false
      }
      window.api.pty.write(ptyId, data, inputKind)
      // Why: SSH/local fallback writes are fire-and-forget. Callers use this
      // boolean to continue UX flow, while hook telemetry confirms real turns.
      recordRuntimeTerminalInputForPtyId(ptyId)
      return true
    }
    recordRuntimeTerminalInputForPtyId(ptyId)
    return accepted
  }
  try {
    const result = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      owner.target,
      'terminal.send',
      {
        terminal: owner.terminal,
        text: data,
        client: DESKTOP_RUNTIME_CLIENT,
        ...(writeOptions?.requireWriteSettlement ? { requireWriteSettlement: true } : {})
      },
      { timeoutMs: 15_000 }
    )
    if (result.send.accepted === true) {
      recordRuntimeTerminalInputForPtyId(ptyId)
    }
    const acknowledgment = readTerminalSendAcknowledgment(result)
    if (acknowledgment === 'unverifiable') {
      throw new Error('PTY write acknowledgment unavailable')
    }
    return acknowledgment === 'accepted'
  } catch (error) {
    if (classifyTerminalProcessInspectionFailure(error) === 'terminal_gone') {
      return false
    }
    throw error
  }
}
