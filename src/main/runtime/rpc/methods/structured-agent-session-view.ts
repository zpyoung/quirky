// `agentSession.view.*`: what `quirky view` calls to show a visual in the caller's own chat. Each
// call writes or revises one `visual` journal item, so the desktop draws it as a chip in the turn.
// Additive: a host without these lacks the methods, and `quirky view` reads that as "this host
// doesn't support it" via `agent-session.v1-chat-methods.v1`.
//
// The caller is the session named by `QUIRKY_AGENT_SESSION_ID`, resolved at the dispatch entry
// (`orchestration-session-caller.ts`), so a request that names another session, comes from another
// host, or has no session at all is refused with `session-refused` before anything is written.
// Errors travel as `LedgerError`, the one error type the dispatcher forwards with an arbitrary
// code and details.

import {
  AgentSessionViewCloseParams,
  AgentSessionViewGetParams,
  AgentSessionViewOpenParams,
  AgentSessionViewPatchParams,
  AgentSessionViewUpdateParams,
  type AgentSessionViewCloseResult,
  type AgentSessionViewGetResult,
  type AgentSessionViewOpenResult,
  type AgentSessionViewPatchResult,
  type AgentSessionViewUpdateResult
} from '../../../../shared/rpc-contract/structured-agent-session-params'
import { AgentSessionViewError } from '../../../native-chat/agent-session-wire/agent-session-view-error'
import type { VisualRefusal } from '../../../native-chat/agent-session-wire/structured-agent-session-visuals'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { defineMethod, type RpcContext } from '../core'
import { requireInstalledStructuredHost } from './structured-agent-session-gate'

/** The caller's own session on a host that can write to it; anything else is `session-refused`. */
async function callerSessionHost(
  ctx: RpcContext,
  sessionId: string
): Promise<StructuredAgentSessionHost> {
  const host = await requireInstalledStructuredHost(ctx, sessionId)
  if (ctx.orchestrationCaller?.sessionId !== sessionId) {
    throw new AgentSessionViewError(
      'session-refused',
      'quirky view acts only on the chat it runs in. No view was changed.'
    )
  }
  if (host.sessionAgent(sessionId) === null) {
    throw new AgentSessionViewError('session-refused', `Chat ${sessionId} is not on this host.`)
  }
  return host
}

function refusal(failure: VisualRefusal, viewId = ''): AgentSessionViewError {
  switch (failure.reason) {
    case 'invalid-spec':
      return new AgentSessionViewError(
        'invalid-spec',
        `Invalid view: ${failure.errors.join('; ')}`,
        {
          errors: failure.errors
        }
      )
    case 'not-found':
      return new AgentSessionViewError('not-found', `No view ${viewId} in this chat.`)
    case 'closed':
      return new AgentSessionViewError('closed', `View ${viewId} is closed; open a new one.`)
    case 'unwritable':
      return new AgentSessionViewError(
        'session-refused',
        'This host cannot write to the chat right now.'
      )
  }
}

export const STRUCTURED_AGENT_SESSION_VIEW_METHODS = [
  defineMethod({
    name: 'agentSession.view.open',
    permission: 'workspace',
    params: AgentSessionViewOpenParams,
    handler: async (params, ctx): Promise<AgentSessionViewOpenResult> => {
      const { sessionId } = params.envelope
      const host = await callerSessionHost(ctx, sessionId)
      const result = await host.openView(sessionId, {
        spec: params.spec,
        ...(params.title ? { title: params.title } : {}),
        ...(params.placement ? { placement: params.placement } : {})
      })
      if (!result.ok) {
        throw refusal(result)
      }
      return { viewId: result.viewId, version: result.version }
    }
  }),
  defineMethod({
    name: 'agentSession.view.update',
    permission: 'workspace',
    params: AgentSessionViewUpdateParams,
    handler: async (params, ctx): Promise<AgentSessionViewUpdateResult> => {
      const { sessionId } = params.envelope
      const host = await callerSessionHost(ctx, sessionId)
      const result = await host.updateView(sessionId, {
        viewId: params.viewId,
        spec: params.spec
      })
      if (!result.ok) {
        throw refusal(result, params.viewId)
      }
      return { version: result.version }
    }
  }),
  defineMethod({
    name: 'agentSession.view.patch',
    permission: 'workspace',
    params: AgentSessionViewPatchParams,
    handler: async (params, ctx): Promise<AgentSessionViewPatchResult> => {
      const { sessionId } = params.envelope
      const host = await callerSessionHost(ctx, sessionId)
      const result = await host.patchView(sessionId, {
        viewId: params.viewId,
        patch: params.patch
      })
      if (!result.ok) {
        throw refusal(result, params.viewId)
      }
      return { version: result.version }
    }
  }),
  defineMethod({
    name: 'agentSession.view.close',
    permission: 'workspace',
    params: AgentSessionViewCloseParams,
    handler: async (params, ctx): Promise<AgentSessionViewCloseResult> => {
      const { sessionId } = params.envelope
      const host = await callerSessionHost(ctx, sessionId)
      const result = await host.closeView(sessionId, { viewId: params.viewId })
      if (!result.ok) {
        throw refusal(result, params.viewId)
      }
      return { ok: true }
    }
  }),
  defineMethod({
    name: 'agentSession.view.get',
    permission: 'workspace',
    params: AgentSessionViewGetParams,
    handler: async (params, ctx): Promise<AgentSessionViewGetResult> => {
      const host = await callerSessionHost(ctx, params.sessionId)
      const result = await host.readView(params.sessionId, { viewId: params.viewId })
      if (!result.ok) {
        throw refusal(result, params.viewId)
      }
      return { spec: result.spec, version: result.version, closed: result.closed }
    }
  })
]
