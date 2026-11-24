import { QuirkyRuntimeWithCreateAgentPromptRenderGate } from '../input/terminal-agent-prompt-render'
import type {
  RuntimeProviderSnapshotReadOptions,
  TerminalWaiter
} from '../../runtime-terminal-contracts'
import {
  TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS,
  VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS
} from '../../quirky-runtime-postlude'
import { withTimeout } from '../../runtime-async-boundaries'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptBody,
  isKnownReadyPromptSettled,
  tuiIdleNeedsVisibleScreenProbe
} from '../../terminal-wait-detection'
import { readsTrustedScreen } from '../../agent-state-rules/agent-state-rules-engine'
import { restoreProjectedComposerDraft } from '../../quirky-runtime-terminal-projection'
import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason
} from '../../../../shared/runtime-terminal-contracts'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitResult,
  buildTerminalWaitBlockedResult,
  buildTerminalWaitResult
} from '../../terminal-wait-results'
import { createSetupCompletionScanner } from '../../orchestration/setup-completion-signal'
import { buildTerminalWaitText } from '../../terminal-wait-tail-state'
import type { TuiAgent } from '../../../../shared/tui-agent'

// Why re-probe: a TUI that paints with cursor moves (Claude Code) never reaches the newline tail the
// poll reads, and its first frame lands after the wait starts, so a single look sees a blank screen.
const TUI_IDLE_VISIBLE_PROBE_RETRY_MS = 1_000

export abstract class QuirkyRuntimeWithStartTuiIdleVisibleReadProbe extends QuirkyRuntimeWithCreateAgentPromptRenderGate {
  /** One bounded look at the provider's screen for an adopted PTY whose retained
   *  readiness metadata was lost. Deliberately single-shot: it answers "is the
   *  screen already showing a settled prompt", and the poll above owns every
   *  later transition. A provider screen that is still working when this fires
   *  resolves through the poll, not here. */
  protected startTuiIdleVisibleReadProbe(
    waiter: TerminalWaiter,
    waiterTimeoutMs: number,
    agent: TuiAgent | null,
    deadlineMs = Date.now() + waiterTimeoutMs
  ): void {
    const settleMarginMs = Math.min(
      TUI_IDLE_VISIBLE_PROBE_SETTLE_MARGIN_MS,
      Math.max(1, Math.floor(waiterTimeoutMs / 3))
    )
    const probeTimeoutMs = Math.min(
      VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS + settleMarginMs,
      Math.max(0, waiterTimeoutMs - settleMarginMs)
    )
    const providerTimeoutMs = Math.min(
      VISIBLE_TERMINAL_SNAPSHOT_TIMEOUT_MS,
      Math.max(0, probeTimeoutMs - settleMarginMs)
    )
    if (providerTimeoutMs < 1) {
      return
    }
    const screenRule = readsTrustedScreen(agent)
    void withTimeout(
      this.readTerminal(waiter.handle, screenRule ? { screen: true } : {}, {
        timeoutMs: providerTimeoutMs,
        retireOnTimeout: true,
        // Why: the ready banner stays in scrollback for the whole session, so
        // classifying history would call a working agent idle (#15569 review).
        visibleScreenOnly: true
      } satisfies RuntimeProviderSnapshotReadOptions),
      probeTimeoutMs,
      null
    )
      .then((projection) => {
        if (!this.terminalWaiters.get(waiter.handle)?.has(waiter)) {
          return
        }
        // Why re-arm on a missing screen too: a fresh pane's first snapshot can time out or come
        // back before the provider holds a screen, and that says nothing about readiness.
        if (!projection || projection.source !== 'screen') {
          this.rearmTuiIdleVisibleReadProbe(waiter, deadlineMs, agent)
          return
        }
        const snapshotText = projection.tail.join('\n')
        const blockedReason = detectTerminalWaitBlockedReason(snapshotText)
        // Why the shared tier-1 rule: a probe must not settle what the live screen would refuse.
        const ready = screenRule
          ? isKnownReadyPromptBody(
              snapshotText,
              agent,
              () => restoreProjectedComposerDraft(projection.tail, projection.draft),
              // Why read now: output since the probe started makes the pane clocked.
              (
                this.getLivePtyForHandle(waiter.handle)?.pty ??
                this.getLiveLeafForHandle(waiter.handle).leaf
              ).lastOutputAt !== null
            )
          : isKnownReadyPromptSettled(snapshotText)
        if (!blockedReason && !ready) {
          this.rearmTuiIdleVisibleReadProbe(waiter, deadlineMs, agent)
          return
        }
        const result = this.buildTuiIdleProbeResult(waiter.handle, blockedReason)
        if (waiter.cancelIdlePoll) {
          waiter.cancelIdlePoll()
        }
        this.terminalWaiters.resolve(waiter, result)
      })
      .catch(() => {
        this.rearmTuiIdleVisibleReadProbe(waiter, deadlineMs, agent)
      })
  }

  /** Looks again only while the screen is still the only usable evidence and the waiter has time left. */
  protected rearmTuiIdleVisibleReadProbe(
    waiter: TerminalWaiter,
    deadlineMs: number,
    agent: TuiAgent | null
  ): void {
    const remainingMs = deadlineMs - Date.now() - TUI_IDLE_VISIBLE_PROBE_RETRY_MS
    if (remainingMs <= 0) {
      return
    }
    setTimeout(() => {
      if (!this.terminalWaiters.get(waiter.handle)?.has(waiter)) {
        return
      }
      // Why try: the handle can go stale between looks; the waiter's own timeout then settles it.
      try {
        const record =
          this.getLivePtyForHandle(waiter.handle)?.pty ??
          this.getLiveLeafForHandle(waiter.handle).leaf
        if (
          !tuiIdleNeedsVisibleScreenProbe(
            record.lastAgentStatus,
            buildTerminalWaitText(record.tailBuffer, record.tailPartialLine, record.preview),
            this.getPaneAgentForTuiIdle(record.ptyId)
          )
        ) {
          return
        }
        this.startTuiIdleVisibleReadProbe(waiter, deadlineMs - Date.now(), agent, deadlineMs)
      } catch {
        // Stale handle; nothing left to probe.
      }
    }, TUI_IDLE_VISIBLE_PROBE_RETRY_MS).unref?.()
  }

  protected buildTuiIdleProbeResult(
    handle: string,
    blockedReason: RuntimeTerminalWaitBlockedReason | null
  ): RuntimeTerminalWait {
    const pty = this.getLivePtyForHandle(handle)
    if (pty) {
      return blockedReason
        ? buildPtyTerminalWaitBlockedResult(handle, 'tui-idle', pty.pty, blockedReason)
        : buildPtyTerminalWaitResult(handle, 'tui-idle', pty.pty)
    }
    const { leaf } = this.getLiveLeafForHandle(handle)
    return blockedReason
      ? buildTerminalWaitBlockedResult(handle, 'tui-idle', leaf, blockedReason)
      : buildTerminalWaitResult(handle, 'tui-idle', leaf)
  }

  async waitForSetupTerminalCompletion(
    handle: string,
    signal?: AbortSignal
  ): Promise<{ exitCode: number | null }> {
    const ptyId = this.getLivePtyForHandle(handle)?.pty.ptyId
    if (!ptyId) {
      throw new Error('terminal_handle_stale')
    }
    const completionToken = this.setupCompletionTokenByPtyId.get(ptyId)
    const exitAbort = new AbortController()
    return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
      let settled = false
      let unsubscribe: (() => void) | null = null
      const onAbort = (): void => {
        fail(signal?.reason ?? new Error('request_aborted'))
      }
      const cleanup = (): void => {
        unsubscribe?.()
        exitAbort.abort()
        signal?.removeEventListener('abort', onAbort)
      }
      const finish = (exitCode: number | null): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        this.setupCompletionTokenByPtyId.delete(ptyId)
        resolve({ exitCode })
      }
      const fail = (error: unknown): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const scanner = completionToken ? createSetupCompletionScanner(completionToken, finish) : null

      if (scanner) {
        unsubscribe = this.subscribeToTerminalData(ptyId, scanner.scan)
      }
      // Why: setup can finish before the observer is registered on fast local worktrees.
      const replay = this.recentPtyOutputById.get(ptyId)?.read()
      if (scanner && replay) {
        scanner.scan(replay)
      }
      if (!settled) {
        void this.waitForTerminal(handle, {
          condition: 'exit',
          signal: exitAbort.signal
        })
          .then((wait) => {
            if (wait.satisfied && wait.condition === 'exit' && wait.status === 'exited') {
              finish(wait.exitCode)
            }
          })
          .catch(fail)
      }
    })
  }
}
