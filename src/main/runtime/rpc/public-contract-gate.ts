import {
  CallerHintSchema,
  type AttributedCaller,
  type CallerHint
} from '../../../shared/public-rpc/caller-hint'
import { classifyMethod } from '../../../shared/public-rpc/method-classification'
import type { DestructiveSpec } from '../../../shared/public-rpc/public-method-spec'
import { publicSpecForMethod } from '../../../shared/public-rpc/public-methods'
import type { OrchestrationSessionCaller } from '../orchestration/orchestration-caller-identity'
import type { QuirkyRuntimeService } from '../quirky-runtime'
import type { RpcContext, RpcMethod, RpcRequest, RpcStreamingMethod } from './core'
import { isStreamingMethod } from './core'
import {
  rpcContextFromTransport,
  type RpcDispatchStreamingOptions
} from './dispatcher-stream-options'
import { getDestructivePreviewer } from './destructive-previewers'
import { PublicRpcError } from './public-rpc-error'
import type { RpcCallerScope } from './rpc-caller-scope'

const MAX_HINT_FIELD_CHARS = 200
const SESSION_ID_LABEL_CHARS = 8

type PublicContractInput<M extends RpcMethod | RpcStreamingMethod> = {
  runtime: QuirkyRuntimeService
  method: M
  request: RpcRequest
  params: unknown
  callerScope: RpcCallerScope
  options: RpcDispatchStreamingOptions | undefined
  orchestrationCaller: OrchestrationSessionCaller | undefined
}

function clip(value: string): string {
  return value.slice(0, MAX_HINT_FIELD_CHARS)
}

/** A malformed hint reads as no hint, since it only ever labels the caller. */
export function readCallerHint(raw: unknown): CallerHint {
  const parsed = CallerHintSchema.safeParse(raw)
  return parsed.success ? parsed.data : {}
}

function attributedFromHint(hint: CallerHint): AttributedCaller {
  const worktreeId = hint.worktreeId ? { worktreeId: clip(hint.worktreeId) } : {}
  const agentSessionId = hint.agentSessionId ? { agentSessionId: clip(hint.agentSessionId) } : {}
  if (hint.role === 'brain') {
    return { kind: 'brain', label: 'Brain', ...agentSessionId, ...worktreeId }
  }
  if (hint.agentSessionId) {
    const shortId = clip(hint.agentSessionId).slice(0, SESSION_ID_LABEL_CHARS)
    return { kind: 'agent-session', label: `Agent ${shortId}`, ...agentSessionId, ...worktreeId }
  }
  if (hint.terminalHandle) {
    return { kind: 'terminal', label: `Terminal ${clip(hint.terminalHandle)}`, ...worktreeId }
  }
  return { kind: 'script', label: 'Script', ...worktreeId }
}

/**
 * Names who a public call is attributed to. The transport scope decides the kind for phones and
 * paired desktops; only an owner-scope call reads the self-declared hint, and that hint labels the
 * caller without granting it anything.
 */
export function resolvePublicCaller(
  scope: RpcCallerScope,
  pairedDeviceId: string | undefined,
  hint: CallerHint
): AttributedCaller {
  const deviceId = pairedDeviceId ? { deviceId: pairedDeviceId } : {}
  switch (scope.kind) {
    case 'mobile':
      return { kind: 'mobile', label: 'Phone', ...deviceId }
    case 'runtime-paired':
      return { kind: 'remote', label: 'Remote desktop', ...deviceId }
    case 'owner':
      return attributedFromHint(hint)
  }
}

function destructiveSpecFor(method: string): DestructiveSpec | undefined {
  const classification = classifyMethod(method)
  if (classification?.kind === 'public') {
    return classification.spec.destructive
  }
  return classification?.kind === 'unstable' ? classification.destructive : undefined
}

async function previewEffects(method: string, params: unknown, ctx: RpcContext): Promise<string[]> {
  const previewer = getDestructivePreviewer(method)
  return previewer ? previewer(params, ctx) : [`${method} is destructive`]
}

function worktreeIdOf(params: unknown, caller: AttributedCaller): string | undefined {
  if (typeof params === 'object' && params !== null && 'worktreeId' in params) {
    const { worktreeId } = params
    if (typeof worktreeId === 'string' && worktreeId.length > 0) {
      return worktreeId
    }
  }
  return caller.worktreeId
}

function bindPublicCall(
  method: RpcMethod | RpcStreamingMethod,
  publicCaller: AttributedCaller,
  onSuccess: (() => void) | null
): RpcMethod | RpcStreamingMethod {
  const settle = (): void => {
    try {
      onSuccess?.()
    } catch (error) {
      console.error('[public-contract] recording the call failed', error)
    }
  }
  if (isStreamingMethod(method)) {
    return {
      ...method,
      handler: async (params, ctx, emit) => {
        await method.handler(params, { ...ctx, publicCaller }, emit)
        settle()
      }
    }
  }
  return {
    ...method,
    handler: async (params, ctx) => {
      const result = await method.handler(params, { ...ctx, publicCaller })
      settle()
      return result
    }
  }
}

/**
 * The server half of the public CLI/API contract. A request that opts in with `publicContract`
 * gets a destructive-call preview, then the user's approval when its category asks for one; a
 * call to a public mutating method is also attributed and recorded once it succeeds. Anything
 * else returns null untouched, so legacy clients keep exactly their current behavior.
 *
 * Resolves to the method to dispatch (bound to the resolved caller) or rejects with
 * PublicRpcError.
 */
export function gatePublicContract<M extends RpcMethod | RpcStreamingMethod>(
  input: PublicContractInput<M>
): Promise<M> | null {
  const { request } = input
  const optedIn = request.publicContract === 1
  const recordsMutation = publicSpecForMethod(request.method)?.effect === 'mutate'
  if (!optedIn && !recordsMutation) {
    return null
  }
  return admitPublicCall(input, optedIn)
}

async function admitPublicCall<M extends RpcMethod | RpcStreamingMethod>(
  {
    runtime,
    method,
    request,
    params,
    callerScope,
    options,
    orchestrationCaller
  }: PublicContractInput<M>,
  optedIn: boolean
): Promise<M> {
  const hint = readCallerHint(request.caller)
  const publicCaller = resolvePublicCaller(callerScope, options?.pairedDeviceId, hint)
  const spec = publicSpecForMethod(request.method)
  const destructive = optedIn ? destructiveSpecFor(request.method) : undefined
  const confirmed = request.confirm === true
  const context = (): RpcContext => ({
    ...rpcContextFromTransport(runtime, request, options, orchestrationCaller),
    publicCaller
  })

  if (destructive && !confirmed) {
    const effects = await previewEffects(request.method, params, context())
    throw new PublicRpcError(
      'needs_confirmation',
      'preview',
      [{ command: 're-run with --yes', why: 'confirms the effects listed' }],
      { effects },
      `${request.method} is destructive; review the effects, then re-run with --yes`
    )
  }

  const summary = spec?.summary ?? request.method
  const worktreeId = worktreeIdOf(params, publicCaller)
  const category = optedIn ? (spec?.approvalCategory ?? destructive?.category) : undefined
  if (category && runtime.approvalGate.policyFor(category) === 'ask') {
    const effects = destructive ? await previewEffects(request.method, params, context()) : []
    const terminalHandle = hint.terminalHandle
    await runtime.approvalGate.require(category, publicCaller, summary, effects, {
      worktreeId: worktreeId ?? null,
      paneKey: terminalHandle ? runtime.getTerminalPaneKey(terminalHandle) : null,
      signal: options?.signal
    })
  }

  const recordsActivity = spec?.effect === 'mutate' || (destructive !== undefined && confirmed)
  const onSuccess = recordsActivity
    ? (): void =>
        runtime.activityTrail.record({
          caller: publicCaller,
          method: request.method,
          summary,
          ...(worktreeId ? { workspaceId: worktreeId } : {}),
          at: Date.now()
        })
    : null
  // SAFETY: bindPublicCall keeps the unary or streaming shape of the method it is given.
  return bindPublicCall(method, publicCaller, onSuccess) as M
}
