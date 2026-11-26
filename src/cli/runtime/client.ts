import { randomUUID } from 'node:crypto'
import type { CliStatusResult, RuntimeStatus } from '../../shared/runtime-types'
import { runtimeHostConnectionState } from '../../shared/runtime-host-connection-state'
import type { RuntimeOrchestrationEnvelope } from '../../shared/runtime-rpc-envelope'
import {
  isDurableMutation,
  isOrchestrationMutation,
  isTerminalPromptMutation,
  orchestrationMigrationData
} from '../../shared/orchestration-rpc-contract'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import { launchQuirkyApp } from './launch'
import { getDefaultUserDataPath, readMetadata } from './metadata'
import { getCliStatus, projectRemoteAppStatus } from './status'
import { sendRequest } from './transport'
import { sendStreamingRequest } from './streaming-transport'
import type { CallerHint } from '../../shared/public-rpc/caller-hint'
import { classifyMethod } from '../../shared/public-rpc/method-classification'
import { publicSpecForMethod } from '../../shared/public-rpc/public-methods'
import { PUBLIC_CLI_RUNTIME_CAPABILITY } from '../../shared/public-cli-runtime-capabilities'
import type { RemoteRuntimeRequestEnvelope } from '../../shared/remote-runtime-memory-limits'
import { RuntimeClientError, RuntimeRpcFailureError, type RuntimeRpcSuccess } from './types'
import { markPublicContractError } from '../cli-error'
import {
  attachDurableMutationRecovery,
  attachLegacyTerminalPromptRecovery,
  attachUnverifiedTerminalPromptRecovery,
  didAnotherRuntimeHandleTerminalPrompt
} from './terminal-prompt-mutation-recovery'
import { markEnvironmentUsed } from './environments'
import { createRuntimeSourceFence, type RuntimeSourceFence } from './runtime-source-fence'
import { resolveRemoteConnection } from './runtime-remote-pairing'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_CONTRACT_VERSION
} from '../../shared/protocol-version'
import { RemoteRuntimeCompatGate } from './remote-runtime-compat-gate'
import { createOrchestrationCompatibilityEnvelope } from './orchestration-compatibility-envelope'
import { getTimeoutMsParam, isWaitingCheck } from './runtime-request-timeout'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartClientTimeoutMs,
  resolveWorkerStartReadinessTimeoutMs
} from '../../shared/orchestration-timing-budgets'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import {
  buildOrchestrationRecoveryCommand,
  resolveOrchestrationCliExecutable
} from './orchestration-recovery-command'

const LONG_POLL_CLIENT_GRACE_MS = 10_000

// The server holds an approval question open for 10 minutes; the margin keeps the client from
// abandoning a call the server is still entitled to answer.
const PUBLIC_APPROVAL_CLIENT_TIMEOUT_MS = 600_000 + 30_000

/** Whether a public-contract call to this method can park on a user approval before it answers. */
function publicCallMayAwaitApproval(method: string): boolean {
  const spec = publicSpecForMethod(method)
  if (spec) {
    return (
      spec.effect === 'mutate' ||
      spec.destructive !== undefined ||
      spec.approvalCategory !== undefined
    )
  }
  const classification = classifyMethod(method)
  return classification?.kind === 'unstable' && classification.destructive !== undefined
}

const loadWebSocketTransport = async () => await import('./websocket-transport.js')

type CallOptions = {
  timeoutMs?: number
  legacyTerminalPrompt?: true
  terminalPromptPreflight?: { runtimeId: string | null }
  /** Opts into the public-CLI server contract: preview-then-confirm gating and attribution. */
  publicContract?: true
  confirm?: boolean
  caller?: CallerHint
} & RuntimeOrchestrationEnvelope

type StreamOptions = {
  timeoutMs?: number
  signal?: AbortSignal
  publicContract?: true
  caller?: CallerHint
}

/** Marks client and server failures of a public-contract call so the CLI reports their stable code. */
function markClientFailure(error: unknown): unknown {
  return error instanceof RuntimeRpcFailureError || error instanceof RuntimeClientError
    ? markPublicContractError(error)
    : error
}

export class RuntimeClient {
  readonly userDataPath: string
  private readonly requestTimeoutMs: number
  private readonly remote: PairedRuntimeConnection | null
  readonly environmentSelector: string | null
  private readonly cliExecutable: string
  private readonly originalArgs: readonly string[] | undefined
  private readonly remoteCompat: RemoteRuntimeCompatGate
  private orchestrationContractCheck: Promise<void> | null = null
  private publicCliContractCheck: Promise<void> | null = null
  private readonly orchestrationCompatibility = createOrchestrationCompatibilityEnvelope(
    process.env
  )
  private readonly runtimeSourceFence: RuntimeSourceFence

  // Why: browser commands trigger first-time session init (agent-browser connect +
  // CDP proxy setup) which can take 15-30s. 60s accommodates cold start without
  // being so large that genuine hangs go unnoticed.
  constructor(
    userDataPath = getDefaultUserDataPath(),
    requestTimeoutMs = 60_000,
    remotePairingCode = process.env.QUIRKY_PAIRING_CODE ??
      process.env.QUIRKY_REMOTE_PAIRING ??
      null,
    environmentSelector = process.env.QUIRKY_ENVIRONMENT ?? null,
    cliExecutable = resolveOrchestrationCliExecutable(),
    originalArgs?: readonly string[]
  ) {
    this.userDataPath = userDataPath
    this.requestTimeoutMs = requestTimeoutMs
    this.environmentSelector = environmentSelector
    this.cliExecutable = cliExecutable
    this.originalArgs = originalArgs ? [...originalArgs] : undefined
    this.remote = resolveRemoteConnection(userDataPath, remotePairingCode, environmentSelector)
    this.remoteCompat = new RemoteRuntimeCompatGate(userDataPath, environmentSelector)
    this.runtimeSourceFence = createRuntimeSourceFence(process.env, userDataPath, requestTimeoutMs)
  }

  get isRemote(): boolean {
    return this.remote !== null
  }

  async call<TResult>(
    method: string,
    params?: unknown,
    options?: CallOptions
  ): Promise<RuntimeRpcSuccess<TResult>> {
    try {
      return await this.callUnmarked<TResult>(method, params, options)
    } catch (error) {
      throw options?.publicContract ? markClientFailure(error) : error
    }
  }

  private async callUnmarked<TResult>(
    method: string,
    params?: unknown,
    options?: CallOptions
  ): Promise<RuntimeRpcSuccess<TResult>> {
    const effectiveTimeoutMs =
      options?.timeoutMs ?? this.resolveCallTimeoutMs(method, params, options)
    if (options?.publicContract) {
      await this.ensurePublicCliContract()
    }
    const orchestrationMutation = isOrchestrationMutation(method, params)
    const terminalPromptMutation = isTerminalPromptMutation(method, params)
    const legacyTerminalPrompt = options?.legacyTerminalPrompt === true && terminalPromptMutation
    const durableMutation = !legacyTerminalPrompt && isDurableMutation(method, params)
    if (orchestrationMutation) {
      await this.ensureOrchestrationContractCompatible(effectiveTimeoutMs)
    }
    const orchestrationRequestId = durableMutation
      ? (options?.orchestrationRequestId ?? randomUUID())
      : undefined
    const originalCommand = durableMutation
      ? buildOrchestrationRecoveryCommand(method, params, this.cliExecutable, this.originalArgs)
      : undefined
    const recover = (error: unknown, targetRuntimeId: string | null) => {
      if (legacyTerminalPrompt) {
        return attachLegacyTerminalPromptRecovery(error)
      }
      if (
        terminalPromptMutation &&
        options?.terminalPromptPreflight &&
        didAnotherRuntimeHandleTerminalPrompt(
          error,
          options.terminalPromptPreflight.runtimeId,
          targetRuntimeId
        )
      ) {
        return attachUnverifiedTerminalPromptRecovery(error)
      }
      return attachDurableMutationRecovery(error, orchestrationRequestId, originalCommand, method)
    }
    const compatibilityEnvelope = method.startsWith('orchestration.')
      ? {
          ...this.orchestrationCompatibility,
          compatibilityInvocationId:
            orchestrationRequestId ?? this.orchestrationCompatibility.compatibilityInvocationId
        }
      : method.startsWith('agentSession.view.')
        ? {
            orchestrationCompatibilityEvidence:
              this.orchestrationCompatibility.orchestrationCompatibilityEvidence
          }
        : {}
    const envelope = {
      orchestrationCapability: options?.orchestrationCapability,
      orchestrationContractVersion: method.startsWith('orchestration.')
        ? ORCHESTRATION_CONTRACT_VERSION
        : undefined,
      orchestrationRequestId,
      ...compatibilityEnvelope
    }
    if (this.remote) {
      const transport = await loadWebSocketTransport()
      const remoteEnvelope: RemoteRuntimeRequestEnvelope = {
        ...envelope,
        ...(options?.publicContract ? { publicContract: 1 } : {}),
        ...(options?.confirm === undefined ? {} : { confirm: options.confirm }),
        ...(options?.caller === undefined ? {} : { caller: options.caller })
      }
      let response
      try {
        response = await this.remoteCompat.send<TResult>({
          transport,
          connection: this.remote,
          method,
          params,
          timeoutMs: effectiveTimeoutMs,
          envelope: remoteEnvelope
        })
      } catch (error) {
        throw recover(error, null)
      }
      if (response.ok === false) {
        throw recover(new RuntimeRpcFailureError(response), null)
      }
      if (this.environmentSelector) {
        markEnvironmentUsed(this.userDataPath, this.environmentSelector, {
          runtimeId: response._meta.runtimeId
        })
      }
      return response
    }
    const metadata = readMetadata(this.userDataPath)
    // Why outside recover(): a refusal here happens before anything is sent, so there is nothing to retry.
    const expectedRuntimeSource = await this.runtimeSourceFence.check(metadata, method)
    let response
    try {
      response = await sendRequest<TResult>(
        metadata,
        method,
        params,
        effectiveTimeoutMs,
        envelope,
        expectedRuntimeSource,
        {
          publicContract: options?.publicContract ? 1 : undefined,
          confirm: options?.confirm,
          caller: options?.caller
        }
      )
    } catch (error) {
      throw recover(error, metadata.runtimeId ?? null)
    }
    if (response.ok === false) {
      throw recover(new RuntimeRpcFailureError(response), metadata.runtimeId ?? null)
    }
    return response
  }

  /**
   * Opens a streaming method and delivers each frame's result to `onFrame` until the server ends the
   * stream or `signal` aborts. Unlike `call`, no per-request timeout applies; `timeoutMs` is an
   * optional wall-clock budget for the whole stream and rejects with `timeout` when it elapses.
   */
  async stream(
    method: string,
    params: unknown,
    onFrame: (result: unknown) => void,
    options?: StreamOptions
  ): Promise<void> {
    try {
      await this.streamUnmarked(method, params, onFrame, options)
    } catch (error) {
      throw options?.publicContract ? markClientFailure(error) : error
    }
  }

  private async streamUnmarked(
    method: string,
    params: unknown,
    onFrame: (result: unknown) => void,
    options?: StreamOptions
  ): Promise<void> {
    if (options?.publicContract) {
      await this.ensurePublicCliContract()
    }
    if (this.remote) {
      const transport = await loadWebSocketTransport()
      await transport.streamWebSocketRequest(this.remote, method, params, onFrame, {
        startTimeoutMs: this.requestTimeoutMs,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal
      })
      return
    }
    const metadata = readMetadata(this.userDataPath)
    const expectedRuntimeSource = await this.runtimeSourceFence.check(metadata, method)
    await sendStreamingRequest(metadata, method, params, onFrame, {
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
      publicRequest: {
        publicContract: options?.publicContract ? 1 : undefined,
        caller: options?.caller
      },
      expectedRuntimeSource
    })
  }

  private resolveCallTimeoutMs(method: string, params: unknown, options?: CallOptions): number {
    const base = this.resolveMethodTimeoutMs(method, params)
    return options?.publicContract && publicCallMayAwaitApproval(method)
      ? Math.max(base, PUBLIC_APPROVAL_CLIENT_TIMEOUT_MS)
      : base
  }

  // Why: centralises the per-method timeout policy. Long-poll inner waiter
  // budgets live in `params.timeoutMs`; widen the client-side socket timeout
  // to `timeoutMs + grace` so it doesn't fire before the server has a chance
  // to resolve. Without this, a 5 min wait would still die at the 60 s default.
  // See design doc §3.1.
  private resolveMethodTimeoutMs(method: string, params?: unknown): number {
    if (method === 'orchestration.workerStart') {
      const requestedValue = getTimeoutMsParam(params)
      const requested = typeof requestedValue === 'number' ? requestedValue : Number(requestedValue)
      if (!isWorkerStartTimeoutWithinTimerLimit(requested)) {
        throw new RuntimeClientError(
          'invalid_argument',
          `--timeout-ms is too large for worker-start transport grace; the derived timeout must be <= ${MAX_TIMER_DELAY_MS}ms.`
        )
      }
      const readiness = resolveWorkerStartReadinessTimeoutMs(requested)
      return Math.max(resolveWorkerStartClientTimeoutMs(readiness), this.requestTimeoutMs)
    }
    if (
      (method === 'orchestration.check' && isWaitingCheck(params)) ||
      method === 'terminal.wait'
    ) {
      const inner = Number(getTimeoutMsParam(params))
      if (Number.isFinite(inner) && inner > 0) {
        return Math.max(inner + LONG_POLL_CLIENT_GRACE_MS, this.requestTimeoutMs)
      }
    }
    return this.requestTimeoutMs
  }

  async getCliStatus(): Promise<RuntimeRpcSuccess<CliStatusResult>> {
    if (this.remote) {
      const response = await this.call<RuntimeStatus>('status.get')
      this.remoteCompat.noteVerifiedStatus(response.result)
      const graphState = response.result.graphStatus
      return {
        id: response.id,
        ok: true,
        result: {
          target: {
            kind: 'environment',
            environment: this.environmentSelector ?? 'pairing-code'
          },
          app: projectRemoteAppStatus(response.result),
          runtime: {
            state: graphState === 'ready' ? 'ready' : 'graph_not_ready',
            reachable: true,
            connectionState: runtimeHostConnectionState({
              hasStatusEntry: true,
              status: response.result
            }),
            runtimeId: response.result.runtimeId,
            ...(response.result.appVersion ? { appVersion: response.result.appVersion } : {}),
            ...(response.result.remoteUpdateSupport
              ? { remoteUpdateSupport: response.result.remoteUpdateSupport }
              : {}),
            ...(response.result.capabilities ? { capabilities: response.result.capabilities } : {}),
            ...(response.result.degradations ? { degradations: response.result.degradations } : {})
          },
          graph: {
            state: graphState
          }
        },
        _meta: response._meta
      }
    }
    return getCliStatus(this.userDataPath)
  }

  private async ensureOrchestrationContractCompatible(timeoutMs: number): Promise<void> {
    if (!this.orchestrationContractCheck) {
      this.orchestrationContractCheck = this.checkOrchestrationContractCompatibility(
        timeoutMs
      ).catch((error: unknown) => {
        // Why: a failed probe must not be cached, or a retry after a brief outage never reaches the app.
        this.orchestrationContractCheck = null
        throw error
      })
    }
    await this.orchestrationContractCheck
  }

  /**
   * Refuses a public-contract call before anything is sent when the runtime predates `public-cli.v1`.
   * An older runtime ignores the `publicContract` and `confirm` fields, so it would run a destructive
   * call without the confirmation gate.
   */
  private async ensurePublicCliContract(): Promise<void> {
    if (!this.publicCliContractCheck) {
      this.publicCliContractCheck = this.checkPublicCliContract().catch((error: unknown) => {
        // Why: a missing capability is final for this connection; only a failed probe may be retried.
        if (!(error instanceof RuntimeClientError && error.code === 'capability_unsupported')) {
          this.publicCliContractCheck = null
        }
        throw error
      })
    }
    await this.publicCliContractCheck
  }

  private async checkPublicCliContract(): Promise<void> {
    const response = await this.call<RuntimeStatus>('status.get', undefined, {
      timeoutMs: this.requestTimeoutMs
    })
    if (this.remote) {
      this.remoteCompat.noteVerifiedStatus(response.result)
    }
    if (!response.result.capabilities?.includes(PUBLIC_CLI_RUNTIME_CAPABILITY)) {
      throw new RuntimeClientError(
        'capability_unsupported',
        `The connected Quirky runtime does not support the public CLI contract (${PUBLIC_CLI_RUNTIME_CAPABILITY}). Nothing was sent.`
      )
    }
  }

  private async checkOrchestrationContractCompatibility(timeoutMs: number): Promise<void> {
    const response = await this.call<RuntimeStatus>('status.get', undefined, { timeoutMs })
    if (this.remote) {
      this.remoteCompat.noteVerifiedStatus(response.result)
    }
    if (!response.result.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
      throw new RuntimeClientError(
        'orchestration_migration_required',
        'The connected Quirky runtime does not support the current orchestration contract. No effects were applied.',
        orchestrationMigrationData('runtime_capability_missing')
      )
    }
  }

  async openQuirky(timeoutMs = 15_000): Promise<RuntimeRpcSuccess<CliStatusResult>> {
    const initial = await this.getCliStatus()
    if (this.remote) {
      return initial
    }

    // Why: a blocked runtime can't open a window, so spawning the app would
    // only hit the single-instance lock and exit — bail before launching.
    if (initial.result.app.desktopWindowStatus === 'blocked') {
      throwDesktopActivationBlocked()
    }
    launchQuirkyApp()
    if (initial.result.app.desktopWindowStatus === 'available') {
      return initial
    }

    const startedAt = Date.now()
    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.getCliStatus()
      if (status.result.app.desktopWindowStatus === 'blocked') {
        throwDesktopActivationBlocked()
      }
      if (status.result.app.desktopWindowStatus === 'available') {
        return status
      }
      await delay(250)
    }

    throw new RuntimeClientError(
      'runtime_open_timeout',
      'Timed out waiting for an Quirky desktop window. The runtime may still be running headlessly.'
    )
  }
}

function throwDesktopActivationBlocked(): never {
  throw new RuntimeClientError(
    'desktop_activation_blocked',
    'Quirky is running headlessly, but it cannot open a desktop window safely because the persistent terminal provider is unavailable. Quit Quirky normally and start the app again; do not use open -n.'
  )
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
