// `agentSession.turnDiff`: one file's patch between the two trees a turn's `turn-changes` item
// names. Read on the host that holds the trees, so a remote workspace's diff is read where its
// object store is. Additive: a host without it lacks the method, and a client hides diff expansion
// when the host does not advertise `agent-session.v1-chat-methods.v1`.

import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../../../shared/agent-session-journal-types'
import {
  AgentSessionTurnDiffParams,
  type AgentSessionTurnDiffResult
} from '../../../../shared/rpc-contract/structured-agent-session-params'
import { gitExecFileAsync, gitStreamStdout } from '../../../git/runner'
import { turnChangesIdentity } from '../../../native-chat/agent-session-timeline/turn-changes-item'
import { resolveAgentSessionLaunchDirectory } from '../../agent-session-launch-directory'
import { isRecord } from '../../../../shared/agent-status-child-work-value-guards'
import { defineMethod } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'

export const TURN_DIFF_MAX_BYTES = 512 * 1024

const TREE_PROBE_FAILED_WITH_EXIT_CODE = (error: unknown): boolean =>
  isRecord(error) && typeof error.code === 'number'

export type TurnDiffSource = {
  itemBody: (itemId: string) => Promise<AgentJournalItemBody | null>
  /** The directory the session's agent runs in on this host; null when it has none. */
  directory: () => Promise<string | null>
}

function literalPathspecEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_LITERAL_PATHSPECS: '1' }
}

async function treesAreHeld(directory: string, trees: readonly string[]): Promise<boolean> {
  for (const tree of trees) {
    await gitExecFileAsync(['cat-file', '-e', `${tree}^{tree}`], { cwd: directory })
  }
  return true
}

function utf8Head(text: string, maxBytes: number): string {
  const head = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  return head.endsWith('�') ? head.slice(0, -1) : head
}

/** The patch for `path` between the trees of the turn's `turn-changes` item. */
export async function readTurnDiff(
  source: TurnDiffSource,
  turnId: string,
  path: string
): Promise<AgentSessionTurnDiffResult> {
  const body = await source.itemBody(agentJournalItemKey(turnChangesIdentity(turnId)))
  if (body?.kind !== 'turn-changes') {
    return { ok: false, reason: 'gone' }
  }
  if (body.source === 'edit-tools') {
    return { ok: false, reason: 'not-git' }
  }
  const { fromTree, toTree } = body
  if (fromTree === undefined || toTree === undefined) {
    return { ok: false, reason: 'gone' }
  }
  const directory = await source.directory().catch(() => null)
  if (directory === null) {
    return { ok: false, reason: 'failed' }
  }
  try {
    await treesAreHeld(directory, [fromTree, toTree])
  } catch (error) {
    // A git that ran and refused names an object that is not there; one that never ran is a failure.
    return { ok: false, reason: TREE_PROBE_FAILED_WITH_EXIT_CODE(error) ? 'gone' : 'failed' }
  }
  const renamedFrom = body.files.find((file) => file.path === path)?.oldPath
  const chunks: string[] = []
  let bytes = 0
  let truncated = false
  try {
    await gitStreamStdout(
      [
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '-M',
        fromTree,
        toTree,
        '--',
        ...(renamedFrom === undefined ? [] : [renamedFrom]),
        path
      ],
      {
        cwd: directory,
        env: literalPathspecEnv(),
        onStdout: (chunk) => {
          bytes += Buffer.byteLength(chunk, 'utf8')
          chunks.push(chunk)
          if (bytes > TURN_DIFF_MAX_BYTES) {
            truncated = true
            return true
          }
          return false
        }
      }
    )
  } catch {
    return { ok: false, reason: 'failed' }
  }
  const patch = chunks.join('')
  return { ok: true, patch: truncated ? utf8Head(patch, TURN_DIFF_MAX_BYTES) : patch, truncated }
}

export const STRUCTURED_AGENT_SESSION_TURN_DIFF_METHODS = [
  defineMethod({
    name: 'agentSession.turnDiff',
    permission: 'workspace',
    params: AgentSessionTurnDiffParams,
    handler: async (params, ctx): Promise<AgentSessionTurnDiffResult> => {
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      return readTurnDiff(
        {
          itemBody: (itemId) => host.readItemBody(params.sessionId, itemId),
          directory: async () => {
            const { store, resolveWorkspacePath } = host.deps
            const record = store.getRecord(params.sessionId)
            return record && resolveWorkspacePath
              ? resolveAgentSessionLaunchDirectory({ store, resolveWorkspacePath }, record)
              : null
          }
        },
        params.turnId,
        params.path
      )
    }
  })
]
