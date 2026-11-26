import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { readInjectedAgentSessionId } from '../../shared/agent-session-caller-env'
import { AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY } from '../../shared/agent-session-runtime-capabilities'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../shared/structured-agent-session-mutation'
import { MAX_TITLE_LENGTH } from '../../shared/view-spec/view-spec-types'
import { parseViewPatch, validateViewSpec } from '../../shared/view-spec/view-spec-validation'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { printResult } from '../format'
import { getOptionalJsonFlag, getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'

const NOT_IN_CHAT = 'quirky view runs inside a Quirky chat'
const HOST_TOO_OLD = "This Quirky host doesn't support quirky view yet."
const PLACEMENTS = ['inline', 'pane'] as const

function requireChatSessionId(): string {
  const sessionId = readInjectedAgentSessionId()
  if (!sessionId) {
    throw new RuntimeClientError('invalid_environment', NOT_IN_CHAT)
  }
  return sessionId
}

async function readTextFile(ctx: HandlerContext, flag: string, path: string): Promise<string> {
  try {
    return await readFile(resolve(ctx.cwd, path), 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new RuntimeClientError('invalid_argument', `--${flag}: cannot read ${path}: ${reason}`)
  }
}

/** Inline JSON, or `@path` naming a JSON file. */
async function readJsonFlag(ctx: HandlerContext, flag: string): Promise<unknown> {
  const value = getOptionalJsonFlag(ctx.flags, flag)
  if (value === undefined) {
    throw new RuntimeClientError('invalid_argument', `Missing required --${flag}`)
  }
  const text = value.startsWith('@') ? await readTextFile(ctx, flag, value.slice(1)) : value
  try {
    return JSON.parse(text)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new RuntimeClientError('invalid_argument', `--${flag} is not valid JSON: ${reason}`)
  }
}

function wrappedTitle(ctx: HandlerContext, path: string): string {
  const title = getOptionalStringFlag(ctx.flags, 'title') ?? basename(path, extname(path))
  return (title || 'View').slice(0, MAX_TITLE_LENGTH)
}

/** The spec the caller gave, from exactly one of `--spec`, `--html` or `--mermaid`. */
async function readSpecInput(ctx: HandlerContext): Promise<unknown> {
  const html = getOptionalStringFlag(ctx.flags, 'html')
  const mermaid = getOptionalStringFlag(ctx.flags, 'mermaid')
  const hasSpec = ctx.flags.has('spec')
  if (
    [html, mermaid, hasSpec ? 'spec' : undefined].filter((each) => each !== undefined).length !== 1
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Give exactly one of --spec, --html or --mermaid.'
    )
  }
  if (html !== undefined) {
    return {
      title: wrappedTitle(ctx, html),
      root: {
        type: 'html',
        props: { html: await readTextFile(ctx, 'html', html), interactive: true }
      }
    }
  }
  if (mermaid !== undefined) {
    return {
      title: wrappedTitle(ctx, mermaid),
      root: {
        type: 'diagram',
        props: { source: await readTextFile(ctx, 'mermaid', mermaid) }
      }
    }
  }
  return readJsonFlag(ctx, 'spec')
}

async function readCheckedSpec(ctx: HandlerContext): Promise<unknown> {
  const checked = validateViewSpec(await readSpecInput(ctx))
  if (!checked.ok) {
    throw new RuntimeClientError(
      'invalid_spec',
      `The view spec is invalid:\n${checked.errors.map((error) => `  ${error}`).join('\n')}`
    )
  }
  return checked.spec
}

async function readCheckedPatch(ctx: HandlerContext): Promise<unknown> {
  const raw = await readJsonFlag(ctx, 'patch')
  const parsed = parseViewPatch(Array.isArray(raw) ? { ops: raw } : raw)
  if (!parsed.ok) {
    throw new RuntimeClientError(
      'invalid_patch',
      `The view patch is invalid:\n${parsed.errors.map((error) => `  ${error}`).join('\n')}`
    )
  }
  return parsed.patch
}

function readPlacement(ctx: HandlerContext): 'inline' | 'pane' | undefined {
  const placement = getOptionalStringFlag(ctx.flags, 'placement')
  if (placement === undefined) {
    return undefined
  }
  const known = PLACEMENTS.find((each) => each === placement)
  if (!known) {
    throw new RuntimeClientError('invalid_argument', '--placement must be inline or pane')
  }
  return known
}

async function requireHostSupport(ctx: HandlerContext): Promise<void> {
  const status = await ctx.client.call<{ capabilities?: string[] }>('status.get')
  if (!status.result.capabilities?.includes(AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError('incompatible_runtime', HOST_TOO_OLD)
  }
}

function mutationEnvelope(sessionId: string, method: string, fields: Record<string, unknown>) {
  return {
    sessionId,
    clientOperationId: createStructuredAgentSessionOperationId(randomUUID),
    // the host admits view writes by caller session, not by fence, so no real fence is read
    expectedRuntimeFence: 1,
    payloadFingerprint: structuredAgentSessionPayloadFingerprint({ method, sessionId, fields })
  }
}

async function callView<TResult>(
  ctx: HandlerContext,
  method: string,
  params: Record<string, unknown>
) {
  await requireHostSupport(ctx)
  try {
    return await ctx.client.call<TResult>(method, params)
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      throw new RuntimeClientError('incompatible_runtime', HOST_TOO_OLD)
    }
    throw error
  }
}

function mutate<TResult>(
  ctx: HandlerContext,
  method: string,
  sessionId: string,
  fields: Record<string, unknown>
) {
  return callView<TResult>(ctx, method, {
    envelope: mutationEnvelope(sessionId, method, fields),
    ...fields
  })
}

export const VIEW_HANDLERS: Record<string, CommandHandler> = {
  'view open': async (ctx) => {
    const sessionId = requireChatSessionId()
    const spec = await readCheckedSpec(ctx)
    const placement = readPlacement(ctx)
    const title = getOptionalStringFlag(ctx.flags, 'title')
    const response = await mutate<{ viewId: string; version: number }>(
      ctx,
      'agentSession.view.open',
      sessionId,
      { spec, ...(title ? { title } : {}), ...(placement ? { placement } : {}) }
    )
    printResult(response, ctx.json, (r) => `Opened view ${r.viewId} (v${r.version})`)
  },
  'view update': async (ctx) => {
    const sessionId = requireChatSessionId()
    const viewId = getRequiredStringFlag(ctx.flags, 'id')
    const spec = await readCheckedSpec(ctx)
    const response = await mutate<{ version: number }>(ctx, 'agentSession.view.update', sessionId, {
      viewId,
      spec
    })
    printResult(response, ctx.json, (r) => `Updated view ${viewId} (v${r.version})`)
  },
  'view patch': async (ctx) => {
    const sessionId = requireChatSessionId()
    const viewId = getRequiredStringFlag(ctx.flags, 'id')
    const patch = await readCheckedPatch(ctx)
    const response = await mutate<{ version: number }>(ctx, 'agentSession.view.patch', sessionId, {
      viewId,
      patch
    })
    printResult(response, ctx.json, (r) => `Patched view ${viewId} (v${r.version})`)
  },
  'view get': async (ctx) => {
    const sessionId = requireChatSessionId()
    const viewId = getRequiredStringFlag(ctx.flags, 'id')
    const response = await callView<{ spec: unknown; version: number; closed: boolean }>(
      ctx,
      'agentSession.view.get',
      { sessionId, viewId }
    )
    printResult(
      response,
      ctx.json,
      (r) =>
        `View ${viewId} (v${r.version}${r.closed ? ', closed' : ''})\n${JSON.stringify(r.spec, null, 2)}`
    )
  },
  'view close': async (ctx) => {
    const sessionId = requireChatSessionId()
    const viewId = getRequiredStringFlag(ctx.flags, 'id')
    const response = await mutate<{ ok: true }>(ctx, 'agentSession.view.close', sessionId, {
      viewId
    })
    printResult(response, ctx.json, () => `Closed view ${viewId}`)
  }
}
