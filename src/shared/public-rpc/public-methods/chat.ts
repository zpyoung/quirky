import { z, type ZodType } from 'zod'
import { CurrentRequestsParams } from '../../rpc-contract/agent-session-current-requests-params'
import {
  CancelParams,
  ConversationCommandParams,
  CreateParams,
  HistoryParams,
  OptionsParams,
  RespondParams,
  RespondToQuestionParams,
  RewindParams,
  SendParams,
  SetOptionParams
} from '../../rpc-contract/structured-agent-session-params'
import { definePublicMethod, type PublicMethodSpec } from '../public-method-spec'

const MutationRefusal = z.looseObject({
  code: z.string(),
  message: z.string().optional(),
  details: z.looseObject({ reason: z.string().optional() }).optional()
})

/** What a mutating `agentSession.*` method returns: the settled value, or the host's refusal. */
function mutationResult<T extends ZodType>(value: T) {
  return z.union([
    z.looseObject({ ok: z.literal(true), value }),
    z.looseObject({ ok: z.literal(false), refusal: MutationRefusal })
  ])
}

export const ChatMutationResultSchema = mutationResult(z.unknown())

/** One row of the host's status snapshot, which `chat list` reads. */
export const ChatStatusSessionSchema = z.looseObject({
  sessionId: z.string(),
  workspaceId: z.string(),
  agent: z.string(),
  status: z.string().nullable().optional(),
  model: z.string().optional(),
  conversationName: z.string().optional(),
  lastAssistantMessage: z.string().optional(),
  providerSession: z.looseObject({ id: z.string() }).optional()
})
export type ChatStatusSession = z.infer<typeof ChatStatusSessionSchema>

export const ChatStatusSnapshotSchema = z.looseObject({
  type: z.literal('snapshot'),
  sessions: z.array(ChatStatusSessionSchema)
})

const TurnRecordFields = {
  turnId: z.string().optional(),
  userItemId: z.string().optional()
}

export const ChatHistoryResultSchema = z.looseObject({
  ok: z.boolean().optional(),
  fence: z.number().optional(),
  page: z.looseObject({
    epoch: z.string(),
    fence: z.number().optional(),
    items: z
      .array(
        z.looseObject({
          itemId: z.string(),
          sequence: z.number().optional(),
          turnScope: z
            .looseObject({ kind: z.string(), turnItemId: z.string().optional() })
            .optional(),
          body: z.looseObject({
            kind: z.string(),
            ...TurnRecordFields,
            turnLifecycle: z.looseObject(TurnRecordFields).optional(),
            role: z.string().optional(),
            text: z.string().optional(),
            title: z.string().optional(),
            question: z.string().optional(),
            blocks: z
              .array(z.looseObject({ type: z.string(), text: z.string().optional() }))
              .optional()
          })
        })
      )
      .default([]),
    hasOlder: z.boolean().default(false),
    window: z
      .looseObject({
        oldest: z.looseObject({ epoch: z.string(), sequence: z.number() }).nullable().optional()
      })
      .optional()
  })
})

const PromptOption = z.looseObject({ id: z.string(), label: z.string().optional() })

/** A pending approval or question, as `agentSession.currentRequests` lists it. */
export const ChatPendingRequestSchema = z.looseObject({
  itemId: z.string(),
  revision: z.number(),
  body: z.looseObject({
    kind: z.string(),
    title: z.string().optional(),
    question: z.string().optional(),
    options: z.array(PromptOption).default([]),
    freeTextQuestionId: z.string().optional(),
    questions: z
      .array(
        z.looseObject({
          id: z.string(),
          question: z.string().optional(),
          options: z.array(PromptOption).default([]),
          freeTextQuestionId: z.string().optional()
        })
      )
      .optional()
  })
})
export type ChatPendingRequest = z.infer<typeof ChatPendingRequestSchema>

export const ChatRequestsPieceSchema = z.looseObject({
  marker: z.looseObject({ version: z.string() }),
  json: z.string(),
  nextCursor: z.number().nullable(),
  restart: z.literal(true).optional()
})

const PromptResult = z.looseObject({
  itemId: z.string(),
  revision: z.number(),
  resolution: z.looseObject({ state: z.enum(['pending', 'resolved', 'cancelled']) })
})

export const CHAT_PUBLIC_METHODS: readonly PublicMethodSpec[] = [
  definePublicMethod({
    method: 'agentSession.subscribeStatus',
    cliPath: ['chat', 'list'],
    summary: 'List chat sessions with their agent, status, workspace and model',
    stability: 'stable',
    effect: 'read',
    params: null,
    result: ChatStatusSnapshotSchema,
    errors: ['unavailable', 'unauthorized'],
    streaming: true
  }),
  definePublicMethod({
    method: 'agentSession.create',
    cliPath: ['chat', 'create'],
    summary: 'Start a chat session with an agent in a workspace',
    stability: 'stable',
    effect: 'mutate',
    params: CreateParams,
    result: mutationResult(
      z.looseObject({ sessionId: z.string(), fence: z.number(), tabId: z.string().optional() })
    ),
    errors: ['invalid_argument', 'not_found', 'conflict', 'unavailable', 'unauthorized']
  }),
  definePublicMethod({
    method: 'agentSession.send',
    cliPath: ['chat', 'send'],
    summary: 'Send a message to a chat session',
    stability: 'stable',
    effect: 'mutate',
    params: SendParams,
    result: mutationResult(z.looseObject({ clientMessageId: z.string() })),
    errors: ['invalid_argument', 'not_found', 'conflict', 'unavailable', 'timeout', 'unauthorized']
  }),
  definePublicMethod({
    method: 'agentSession.cancel',
    cliPath: ['chat', 'cancel'],
    summary: 'Stop the turn a chat session is running',
    stability: 'stable',
    effect: 'mutate',
    params: CancelParams,
    result: mutationResult(
      z.looseObject({ cancelled: z.boolean(), turnId: z.string().optional() })
    ),
    errors: ['invalid_argument', 'not_found', 'conflict', 'unavailable', 'unauthorized']
  }),
  definePublicMethod({
    method: 'agentSession.rewind',
    cliPath: ['chat', 'rewind'],
    summary: 'Rewind a chat session to an earlier message, discarding what came after',
    stability: 'stable',
    effect: 'mutate',
    params: RewindParams,
    result: mutationResult(z.looseObject({ itemId: z.string(), epoch: z.string() })),
    destructive: { category: 'chat-discard-rewind' },
    errors: [
      'invalid_argument',
      'not_found',
      'needs_confirmation',
      'conflict',
      'unavailable',
      'unauthorized'
    ]
  }),
  definePublicMethod({
    method: 'agentSession.conversationCommand',
    cliPath: ['chat', 'clear'],
    summary: 'Clear a chat session conversation',
    stability: 'stable',
    effect: 'mutate',
    params: ConversationCommandParams,
    result: mutationResult(z.looseObject({})),
    destructive: { category: 'chat-discard-rewind' },
    errors: [
      'invalid_argument',
      'not_found',
      'needs_confirmation',
      'conflict',
      'unavailable',
      'unauthorized'
    ]
  }),
  definePublicMethod({
    method: 'agentSession.history',
    cliPath: ['chat', 'history'],
    summary: 'Read a chat session transcript, newest page first',
    stability: 'stable',
    effect: 'read',
    params: HistoryParams,
    positionals: ['sessionId'],
    result: ChatHistoryResultSchema,
    errors: ['invalid_argument', 'not_found', 'unavailable', 'unauthorized']
  }),
  definePublicMethod({
    method: 'agentSession.options',
    cliPath: ['chat', 'options', 'get'],
    summary: 'Show the model and other options a chat session offers and currently uses',
    stability: 'stable',
    effect: 'read',
    params: OptionsParams,
    positionals: ['sessionId'],
    result: z.looseObject({
      current: z.looseObject({}),
      models: z.array(z.looseObject({ id: z.string() }))
    }),
    errors: ['invalid_argument', 'not_found', 'unavailable', 'unauthorized']
  }),
  definePublicMethod({
    method: 'agentSession.setOption',
    cliPath: ['chat', 'options', 'set'],
    summary: 'Set a chat session option, such as its model, for the next turn',
    stability: 'stable',
    effect: 'mutate',
    params: SetOptionParams,
    result: mutationResult(z.looseObject({ key: z.string(), value: z.string() })),
    errors: ['invalid_argument', 'not_found', 'conflict', 'unavailable', 'unauthorized']
  }),
  definePublicMethod({
    method: 'agentSession.currentRequests',
    cliPath: ['chat', 'requests'],
    summary: 'List the approvals and questions a chat session is waiting on',
    stability: 'stable',
    effect: 'read',
    params: CurrentRequestsParams,
    positionals: ['sessionId'],
    result: ChatRequestsPieceSchema,
    errors: ['invalid_argument', 'not_found', 'unavailable', 'unauthorized']
  }),
  definePublicMethod({
    method: 'agentSession.respondToApproval',
    cliPath: ['chat', 'respond'],
    summary: 'Allow or deny a permission request, or answer a question, in a chat session',
    stability: 'stable',
    effect: 'mutate',
    params: RespondParams,
    result: mutationResult(PromptResult),
    approvalCategory: 'permission-answers',
    errors: [
      'invalid_argument',
      'not_found',
      'needs_confirmation',
      'conflict',
      'unavailable',
      'unauthorized'
    ]
  }),
  definePublicMethod({
    method: 'agentSession.respondToQuestion',
    cliPath: ['chat', 'answer'],
    summary: 'Answer a question a chat session is waiting on',
    stability: 'stable',
    effect: 'mutate',
    params: RespondToQuestionParams,
    result: mutationResult(PromptResult),
    approvalCategory: 'permission-answers',
    errors: [
      'invalid_argument',
      'not_found',
      'needs_confirmation',
      'conflict',
      'unavailable',
      'unauthorized'
    ]
  })
]
