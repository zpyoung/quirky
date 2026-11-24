import '../unused-default-rpc-methods.test-fixture'
// Why: git.diff, git.branchDiff and git.commitDiff all return a GitDiffResult, so capping only the
// first would leave the other two able to kill a remote socket.
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  REMOTE_RPC_MAX_CONTENT_BYTES,
  remoteRpcContentBudget
} from '../../../../shared/remote-rpc-content-budget'
import { assertGitDiffWithinTransportBudget } from '../../../../shared/git-diff-transport-budget'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { QuirkyRuntimeService } from '../../quirky-runtime'
import type { RpcRequest, RpcResponse } from '../core'
import { RpcDispatcher } from '../dispatcher'
import { GIT_METHODS } from './git'

const OVERSIZED_BASE64 = 'A'.repeat(REMOTE_RPC_MAX_CONTENT_BYTES + 1024)

const OVERSIZED_DIFF: GitDiffResult = {
  kind: 'binary',
  originalContent: '',
  modifiedContent: OVERSIZED_BASE64,
  isImage: true,
  mimeType: 'image/png',
  originalIsBinary: false,
  modifiedIsBinary: true
}

/** The three runtime readers the dispatcher hands a transport budget to. */
type BudgetedRuntimeMethod =
  | 'getRuntimeGitDiff'
  | 'getRuntimeGitBranchDiff'
  | 'getRuntimeGitCommitDiff'

const CASES: readonly {
  method: string
  runtimeMethod: BudgetedRuntimeMethod
  params: Record<string, unknown>
}[] = [
  {
    method: 'git.diff',
    runtimeMethod: 'getRuntimeGitDiff',
    params: { worktree: 'id:wt-1', filePath: 'assets/logo.png', staged: false }
  },
  {
    method: 'git.branchDiff',
    runtimeMethod: 'getRuntimeGitBranchDiff',
    params: {
      worktree: 'id:wt-1',
      compare: { mergeBase: 'a'.repeat(40), headOid: 'b'.repeat(40) },
      filePath: 'assets/logo.png'
    }
  },
  {
    method: 'git.commitDiff',
    runtimeMethod: 'getRuntimeGitCommitDiff',
    params: { worktree: 'id:wt-1', commitOid: 'c'.repeat(40), filePath: 'assets/logo.png' }
  }
]

function budgetedDiff(): Mock<(...args: unknown[]) => Promise<GitDiffResult>> {
  return vi.fn(async (...args: unknown[]) => {
    const maxContentBytes = args.findLast((arg) => typeof arg === 'number')
    return assertGitDiffWithinTransportBudget(
      OVERSIZED_DIFF,
      typeof maxContentBytes === 'number' ? maxContentBytes : undefined
    )
  })
}

/** Stands in for quirky-runtime-git.ts, which enforces the numeric transport budget it is handed. */
function stubRuntime(): QuirkyRuntimeService {
  const runtime: Pick<
    QuirkyRuntimeService,
    'getRuntimeId' | 'getRuntimeGitDiff' | 'getRuntimeGitBranchDiff' | 'getRuntimeGitCommitDiff'
  > = {
    getRuntimeId: () => 'test-runtime',
    getRuntimeGitDiff: budgetedDiff(),
    getRuntimeGitBranchDiff: budgetedDiff(),
    getRuntimeGitCommitDiff: budgetedDiff()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The dispatcher reads only the Git diff methods and the runtime id installed above.
  return runtime as QuirkyRuntimeService
}

function budgetArgument(
  runtime: QuirkyRuntimeService,
  runtimeMethod: BudgetedRuntimeMethod
): unknown {
  const spy = runtime[runtimeMethod]
  if (!vi.isMockFunction(spy)) {
    throw new TypeError(`Expected ${runtimeMethod} to be a mock function`)
  }
  return spy.mock.calls[0]!.findLast((arg) => typeof arg === 'number')
}

function makeRequest(method: string, params: Record<string, unknown>): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

async function dispatchRemote(
  runtime: QuirkyRuntimeService,
  method: string,
  params: Record<string, unknown>,
  clientKind: 'mobile' | 'runtime'
): Promise<RpcResponse> {
  const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })
  const replies: string[] = []
  await dispatcher.dispatchStreaming(makeRequest(method, params), (reply) => replies.push(reply), {
    clientKind
  })
  return JSON.parse(replies[0]!) as RpcResponse
}

describe('remote git diff transport budget', () => {
  it.each(CASES)('caps $method for a mobile client', async ({ method, runtimeMethod, params }) => {
    const runtime = stubRuntime()

    const response = await dispatchRemote(runtime, method, params, 'mobile')

    expect(budgetArgument(runtime, runtimeMethod)).toBe(remoteRpcContentBudget('req-1'))
    expect(response).toMatchObject({
      ok: false,
      error: { code: 'diff_too_large', data: { maxBytes: remoteRpcContentBudget('req-1') } }
    })
  })

  it.each(CASES)(
    'caps $method for a remote desktop client',
    async ({ method, runtimeMethod, params }) => {
      const runtime = stubRuntime()

      const response = await dispatchRemote(runtime, method, params, 'runtime')

      expect(budgetArgument(runtime, runtimeMethod)).toBe(remoteRpcContentBudget('req-1'))
      expect(response).toMatchObject({ ok: false, error: { code: 'diff_too_large' } })
    }
  )

  it('charges a long request id against the remote content budget', async () => {
    const runtime = stubRuntime()
    const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })
    const requestId = '\u0001'.repeat(8_192)
    const replies: string[] = []

    await dispatcher.dispatchStreaming(
      { ...makeRequest('git.diff', CASES[0]!.params), id: requestId },
      (reply) => replies.push(reply),
      { clientKind: 'mobile' }
    )

    expect(budgetArgument(runtime, 'getRuntimeGitDiff')).toBe(remoteRpcContentBudget(requestId))
    expect(Buffer.byteLength(replies[0]!, 'utf8')).toBeLessThanOrEqual(
      REMOTE_RPC_MAX_CONTENT_BYTES + 8 * 1024
    )
  })

  // Why: the in-process/Unix-socket context sets no clientKind, so desktop-local diffs keep full fidelity.
  it.each(CASES)(
    'leaves $method uncapped for a local caller',
    async ({ method, runtimeMethod, params }) => {
      const runtime = stubRuntime()
      const dispatcher = new RpcDispatcher({ runtime, methods: GIT_METHODS })

      const response = await dispatcher.dispatch(makeRequest(method, params))

      expect(budgetArgument(runtime, runtimeMethod)).toBeUndefined()
      expect(response).toMatchObject({
        ok: true,
        result: { kind: 'binary', modifiedContent: OVERSIZED_BASE64 }
      })
    }
  )
})
