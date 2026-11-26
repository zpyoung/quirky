import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { resolveCurrentAgentWorkspaceSelector } from '../agent-workspace-selector'
import type { CommandHandler, HandlerContext } from '../dispatch'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { printResult } from '../format'
import { waitForEvent } from '../public-cli/wait-for-event'
import { RuntimeClientError, type RuntimeRpcSuccess } from '../runtime/types'
import { getRequiredWorktreeSelector } from '../selectors'
import { quoteCliCommandArgument } from '../shell-command-quote'
import { AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY } from '../../shared/agent-session-create-capabilities'
import { ChatHistoryResultSchema } from '../../shared/public-rpc/public-methods/chat'
import { StructuredAgent } from '../../shared/rpc-contract/structured-agent-session-params'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { createStructuredAgentSessionId } from '../../shared/structured-agent-session-create'
import { createStructuredAgentSessionOperationId } from '../../shared/structured-agent-session-mutation'
import { structuredAgentSessionSendBody } from '../../shared/structured-agent-session-send-mutation'
import {
  buildPromptResponse,
  invalid,
  mutateSession,
  publicCallOptions,
  readCheckpoint,
  readPendingRequests,
  readStatusSessions,
  type ChatClient,
  type PromptChoice
} from './chat-mutation-envelope'

const DEFAULT_WAIT_TIMEOUT_MS = 600_000

function localResponse<T>(result: T): RuntimeRpcSuccess<T> {
  return { id: 'chat', ok: true, result, _meta: { runtimeId: '' } }
}

function readField(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function stringField(value: unknown, key: string): string | undefined {
  const field = readField(value, key)
  return typeof field === 'string' ? field : undefined
}

function formatFields(result: Record<string, unknown>): string {
  const { lastAssistantMessage, ...rest } = result
  const lines = Object.entries(rest)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`
    )
  return typeof lastAssistantMessage === 'string'
    ? `${lines.join('\n')}\n\n${lastAssistantMessage}`
    : lines.join('\n')
}

function printFields(
  ctx: HandlerContext,
  result: Record<string, unknown>,
  from?: RuntimeRpcSuccess<unknown>
): void {
  printResult(from ? { ...from, result } : localResponse(result), ctx.json, formatFields)
}

/** A remote request cannot carry the server-side confirm gate, so the CLI holds the line itself. */
function requireRemoteConfirmation(ctx: HandlerContext, command: string): void {
  if (ctx.flags.has('yes') || !ctx.client.isRemote) {
    return
  }
  const rerun = [...(ctx.rawArgs ?? command.split(' ')), '--yes'].map(quoteCliCommandArgument)
  throw new RuntimeClientError(
    'needs_confirmation',
    `${command} changes state and needs confirmation.`,
    {
      reason: 'confirmation_required',
      next: [{ command: `quirky ${rerun.join(' ')}`, why: 'run again with --yes to confirm' }]
    }
  )
}

async function resolveWorkspaceSelector(ctx: HandlerContext): Promise<string> {
  const value = getRequiredStringFlag(ctx.flags, 'workspace')
  return value === 'current' || value === 'active'
    ? resolveCurrentAgentWorkspaceSelector(ctx.cwd, ctx.client)
    : getRequiredWorktreeSelector(ctx.flags, 'workspace', ctx.cwd, ctx.client)
}

function parseAgent(flags: Map<string, string | boolean>): string {
  const agent = getRequiredStringFlag(flags, 'agent')
  if (!StructuredAgent.safeParse(agent).success) {
    throw invalid(
      `--agent ${agent} is not a valid agent name; use codex, claude or another registered agent.`
    )
  }
  return agent
}

function messageBody(text: string) {
  if (text.trim().length === 0) {
    throw invalid('The message is empty.')
  }
  return structuredAgentSessionSendBody(text, [])
}

function sendMessage(client: ChatClient, sessionId: string, text: string) {
  return mutateSession(client, {
    method: 'agentSession.send',
    sessionId,
    fields: { body: messageBody(text) }
  })
}

async function createSession(
  ctx: HandlerContext,
  create: {
    worktree: string
    agent: string
    resumeFrom?: { providerSessionId: string }
    message?: string
    model?: string
  }
): Promise<void> {
  const { client } = ctx
  const sessionId = createStructuredAgentSessionId(create.agent, randomUUID)
  const hasExtras = create.message !== undefined || create.model !== undefined
  // an older host refuses a create that carries firstMessage or options, so those follow the create
  const inline =
    hasExtras &&
    (await client.call<RuntimeStatus>('status.get')).result.capabilities?.includes(
      AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY
    ) === true
  const fields = {
    worktree: create.worktree,
    agent: create.agent,
    ...(create.resumeFrom ? { resumeFrom: create.resumeFrom } : {}),
    ...(inline && create.message !== undefined
      ? {
          firstMessage: {
            clientMessageId: createStructuredAgentSessionOperationId(randomUUID),
            body: messageBody(create.message)
          }
        }
      : {}),
    ...(inline && create.model !== undefined ? { options: { model: create.model } } : {})
  }
  const created = await mutateSession(client, {
    method: 'agentSession.create',
    sessionId,
    fields,
    fence: null
  })
  if (hasExtras && !inline) {
    if (create.model !== undefined) {
      const fields = { key: 'model', value: create.model }
      await mutateSession(client, { method: 'agentSession.setOption', sessionId, fields })
    }
    if (create.message !== undefined) {
      await sendMessage(client, sessionId, create.message)
    }
  }
  printFields(
    ctx,
    {
      sessionId,
      agent: create.agent,
      workspace: create.worktree,
      tabId: stringField(created.value, 'tabId')
    },
    created.response
  )
}

const TURN_STATUS: ReadonlyMap<string, string> = new Map([
  ['turn.finished', 'finished'],
  ['turn.failed', 'failed'],
  ['turn.needs-input', 'needs-input']
])

function parseBeforeCursor(raw: string): { epoch: string; sequence: number } {
  const split = raw.lastIndexOf(':')
  const sequence = Number(raw.slice(split + 1))
  if (split <= 0 || !Number.isInteger(sequence) || sequence < 0) {
    throw invalid('--before takes the nextBefore value a previous `chat history` printed.')
  }
  return { epoch: raw.slice(0, split), sequence }
}

function readPromptChoice(flags: Map<string, string | boolean>): PromptChoice {
  const given = (['allow', 'deny', 'option', 'answer'] as const).filter((name) => flags.has(name))
  const [kind] = given
  if (given.length !== 1 || kind === undefined) {
    throw invalid('Pass exactly one of --allow, --deny, --option <id> or --answer <text>.')
  }
  if (kind === 'allow' || kind === 'deny') {
    if (typeof flags.get(kind) === 'string') {
      throw invalid(`--${kind} takes no value; put it after the positional arguments.`)
    }
    return { decision: kind }
  }
  const value = getRequiredStringFlag(flags, kind)
  return kind === 'option' ? { option: value } : { answer: value }
}

async function respondToRequest(ctx: HandlerContext): Promise<void> {
  const sessionId = getRequiredStringFlag(ctx.flags, 'session')
  const requestId = getRequiredStringFlag(ctx.flags, 'request')
  const choice = readPromptChoice(ctx.flags)
  requireRemoteConfirmation(ctx, 'chat respond')
  const request = (await readPendingRequests(ctx.client, sessionId)).find(
    (candidate) => candidate.itemId === requestId
  )
  if (!request) {
    throw new RuntimeClientError(
      'not_found',
      `No pending request ${requestId} in chat session ${sessionId}.`,
      {
        reason: 'request_not_found',
        next: [
          { command: 'quirky chat respond --help', why: 'see how to answer a request' },
          { command: `quirky chat requests ${sessionId}`, why: 'list the pending requests' }
        ]
      }
    )
  }
  const { method, fields } = buildPromptResponse(request, choice)
  const { response, value } = await mutateSession(ctx.client, {
    method,
    fingerprintMethod: `agentSession.respondTo:${request.body.kind}`,
    sessionId,
    fields,
    confirm: ctx.flags.has('yes')
  })
  const resolution = readField(value, 'resolution')
  printFields(
    ctx,
    {
      sessionId,
      requestId,
      status: stringField(resolution, 'state') ?? 'resolved',
      selectedOptionId: stringField(resolution, 'selectedOptionId')
    },
    response
  )
}

function describeHistoryItem(
  item: z.infer<typeof ChatHistoryResultSchema>['page']['items'][number]
) {
  const { body } = item
  const text =
    body.blocks
      ?.flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
      .join('\n') ||
    body.text ||
    body.title ||
    body.question
  return { itemId: item.itemId, kind: body.kind, role: body.role, text: text || undefined }
}

export const CHAT_HANDLERS: Record<string, CommandHandler> = {
  'chat list': async (ctx) => {
    const selector = ctx.flags.has('workspace') ? await resolveWorkspaceSelector(ctx) : undefined
    const workspaceId = selector?.startsWith('id:')
      ? selector.slice('id:'.length)
      : selector === undefined
        ? undefined
        : (
            await ctx.client.call<{ worktree: { id: string } }>('worktree.show', {
              worktree: selector
            })
          ).result.worktree.id
    const rows = (await readStatusSessions(ctx.client))
      .filter((session) => workspaceId === undefined || session.workspaceId === workspaceId)
      .map((session) => ({
        sessionId: session.sessionId,
        agent: session.agent,
        status: session.status ?? null,
        workspace: session.workspaceId,
        model: session.model ?? null,
        name: session.conversationName ?? null
      }))
    printResult(localResponse({ sessions: rows }), ctx.json, ({ sessions }) =>
      sessions.length === 0
        ? 'No chat sessions.'
        : sessions
            .map((row) =>
              [row.sessionId, row.agent, row.status ?? '-', row.workspace, row.model ?? '-'].join(
                '  '
              )
            )
            .join('\n')
    )
  },

  'chat create': async (ctx) => {
    const agent = parseAgent(ctx.flags)
    const message = getOptionalStringFlag(ctx.flags, 'message')
    if (message !== undefined) {
      messageBody(message)
    }
    const model = getOptionalStringFlag(ctx.flags, 'model')
    await createSession(ctx, {
      worktree: await resolveWorkspaceSelector(ctx),
      agent,
      message,
      model
    })
  },

  'chat resume': async (ctx) => {
    const session = getRequiredStringFlag(ctx.flags, 'session')
    const agentFlag = ctx.flags.has('agent') ? parseAgent(ctx.flags) : undefined
    const worktree = await resolveWorkspaceSelector(ctx)
    const known = (await readStatusSessions(ctx.client)).find((row) => row.sessionId === session)
    if (known && known.providerSession === undefined) {
      throw invalid(`Chat session ${session} has no agent conversation to resume yet.`)
    }
    const agent = agentFlag ?? known?.agent
    if (agent === undefined) {
      throw invalid(
        `${session} is not a known chat session; pass --agent to resume it as an agent conversation id.`,
        { next: [{ command: 'quirky chat list', why: 'find a chat session id' }] }
      )
    }
    const providerSessionId = known?.providerSession?.id ?? session
    await createSession(ctx, { worktree, agent, resumeFrom: { providerSessionId } })
  },

  'chat send': async (ctx) => {
    const sessionId = getRequiredStringFlag(ctx.flags, 'session')
    const text = getRequiredStringFlag(ctx.flags, 'text')
    const timeoutMs =
      getOptionalPositiveIntegerFlag(ctx.flags, 'timeout') ?? DEFAULT_WAIT_TIMEOUT_MS
    messageBody(text)
    const { client } = ctx
    const send = () => sendMessage(client, sessionId, text)
    if (!ctx.flags.has('wait')) {
      const { response, value } = await send()
      const clientMessageId = stringField(value, 'clientMessageId') ?? null
      printFields(ctx, { sessionId, clientMessageId, turnId: null }, response)
      return
    }
    const settled = await waitForEvent(
      client,
      {
        topics: ['chat'],
        timeoutMs,
        match: (event) => TURN_STATUS.has(event.type) && event.data.sessionId === sessionId
      },
      send
    )
    const summary = (await readStatusSessions(client)).find((row) => row.sessionId === sessionId)
    const { event } = settled
    printFields(
      ctx,
      {
        sessionId,
        clientMessageId: stringField(settled.result.value, 'clientMessageId') ?? null,
        turnId: stringField(event.data, 'turnId') ?? null,
        status: TURN_STATUS.get(event.type),
        requestId: stringField(event.data, 'requestId'),
        lastAssistantMessage: summary?.lastAssistantMessage ?? null
      },
      settled.result.response
    )
  },

  'chat cancel': async (ctx) => {
    const sessionId = getRequiredStringFlag(ctx.flags, 'session')
    const turnId = getOptionalStringFlag(ctx.flags, 'turn')
    const { response, value } = await mutateSession(ctx.client, {
      method: 'agentSession.cancel',
      sessionId,
      fields: turnId === undefined ? {} : { turnId }
    })
    const cancelled = readField(value, 'cancelled') === true
    printFields(
      ctx,
      { sessionId, cancelled, turnId: stringField(value, 'turnId') ?? turnId },
      response
    )
  },

  'chat rewind': async (ctx) => {
    const sessionId = getRequiredStringFlag(ctx.flags, 'session')
    const itemId = getRequiredStringFlag(ctx.flags, 'to')
    requireRemoteConfirmation(ctx, 'chat rewind')
    const { fence, epoch } = await readCheckpoint(ctx.client, sessionId)
    if (epoch === null) {
      throw new RuntimeClientError(
        'unavailable',
        `Could not read the journal epoch of ${sessionId}, so the rewind cannot be fenced.`,
        {
          next: [
            { command: `quirky chat history ${sessionId}`, why: 'check the session is readable' }
          ]
        }
      )
    }
    const { response, value } = await mutateSession(ctx.client, {
      method: 'agentSession.rewind',
      sessionId,
      fields: { itemId, expectedEpoch: epoch },
      fence,
      confirm: ctx.flags.has('yes')
    })
    printFields(ctx, { sessionId, itemId, epoch: stringField(value, 'epoch') }, response)
  },

  'chat clear': async (ctx) => {
    const sessionId = getRequiredStringFlag(ctx.flags, 'session')
    requireRemoteConfirmation(ctx, 'chat clear')
    const { response } = await mutateSession(ctx.client, {
      method: 'agentSession.conversationCommand',
      sessionId,
      fields: { command: 'clear' },
      confirm: ctx.flags.has('yes')
    })
    printFields(ctx, { sessionId, cleared: true }, response)
  },

  'chat history': async (ctx) => {
    const sessionId = getRequiredStringFlag(ctx.flags, 'session')
    const limit = getOptionalPositiveIntegerFlag(ctx.flags, 'limit')
    const beforeRaw = getOptionalStringFlag(ctx.flags, 'before')
    if (ctx.flags.has('before') && beforeRaw === undefined) {
      throw invalid('--before requires a value')
    }
    const before = beforeRaw === undefined ? undefined : parseBeforeCursor(beforeRaw)
    const response = await ctx.client.call<unknown>(
      'agentSession.history',
      {
        sessionId,
        direction: before ? 'before' : 'tail',
        ...(before ? { cursor: before } : {}),
        ...(limit === undefined ? {} : { limit })
      },
      publicCallOptions()
    )
    const { page } = ChatHistoryResultSchema.parse(response.result)
    const oldest = page.window?.oldest
    const result = {
      sessionId,
      items: page.items.map(describeHistoryItem),
      hasOlder: page.hasOlder,
      ...(page.hasOlder && oldest ? { nextBefore: `${oldest.epoch}:${oldest.sequence}` } : {})
    }
    printResult({ ...response, result }, ctx.json, ({ items, nextBefore }) =>
      [
        ...items.map((item) => `[${item.itemId}] ${item.role ?? item.kind}: ${item.text ?? ''}`),
        ...(nextBefore ? [`Older messages remain: --before ${nextBefore}`] : [])
      ].join('\n')
    )
  },

  'chat options get': async (ctx) => {
    const sessionId = getRequiredStringFlag(ctx.flags, 'session')
    const response = await ctx.client.call<unknown>(
      'agentSession.options',
      { sessionId },
      publicCallOptions()
    )
    printResult(response, ctx.json, (result) => JSON.stringify(result, null, 2))
  },

  'chat options set': async (ctx) => {
    const sessionId = getRequiredStringFlag(ctx.flags, 'session')
    const key = getRequiredStringFlag(ctx.flags, 'key')
    const value = getRequiredStringFlag(ctx.flags, 'value')
    const { response } = await mutateSession(ctx.client, {
      method: 'agentSession.setOption',
      sessionId,
      fields: { key, value }
    })
    printFields(ctx, { sessionId, key, value }, response)
  },

  'chat requests': async (ctx) => {
    const sessionId = getRequiredStringFlag(ctx.flags, 'session')
    const requests = (await readPendingRequests(ctx.client, sessionId)).map((request) => ({
      id: request.itemId,
      kind: request.body.kind,
      revision: request.revision,
      prompt:
        request.body.title ??
        request.body.question ??
        request.body.questions?.[0]?.question ??
        null,
      options: (request.body.questions?.[0]?.options ?? request.body.options).map(
        ({ id, label }) => ({ id, label: label ?? id })
      )
    }))
    printResult(
      localResponse({ sessionId, requests }),
      ctx.json,
      (result) =>
        result.requests
          .map(
            (request) =>
              `${request.id}  ${request.kind}  ${request.prompt ?? ''}  [${request.options.map((option) => option.id).join(', ')}]`
          )
          .join('\n') || 'No pending requests.'
    )
  },

  'chat respond': respondToRequest
}
