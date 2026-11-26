import { z } from 'zod'
import { GLOBAL_FLAGS } from '../args'
import { markPublicContractError } from '../cli-error'
import type { CommandSpec } from '../command-spec'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalJsonFlag, rejectValuelessFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'
import { readCallerHintFromEnv } from '../../shared/public-rpc/caller-hint'
import type { PublicMethodSpec } from '../../shared/public-rpc/public-method-spec'

export type GeneratedCommands = {
  specs: CommandSpec[]
  handlers: Record<string, CommandHandler>
}

type ParamSchema = z.core.$ZodType

type ParamKind = 'string' | 'number' | 'boolean' | 'union' | 'json'

type ParamPlan = {
  key: string
  flag: string
  kind: ParamKind
  schema: ParamSchema
  required: boolean
}

const RESERVED_FLAGS: ReadonlySet<string> = new Set([...GLOBAL_FLAGS, 'yes', 'full', 'params-json'])

function toKebabCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

function unwrapSchema(schema: ParamSchema): ParamSchema {
  let current = schema
  for (let depth = 0; depth < 8; depth += 1) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodNonOptional ||
      current instanceof z.ZodReadonly
    ) {
      current = current.unwrap()
    } else if (
      current instanceof z.ZodDefault ||
      current instanceof z.ZodPrefault ||
      current instanceof z.ZodCatch
    ) {
      current = current.def.innerType
    } else if (current instanceof z.ZodPipe) {
      // a trailing transform has no type of its own, so the input side names the flag's kind
      current = current.out instanceof z.ZodTransform ? current.in : current.out
    } else {
      break
    }
  }
  return current
}

function kindOf(schema: ParamSchema): ParamKind {
  const inner = unwrapSchema(schema)
  if (inner instanceof z.ZodString || inner instanceof z.ZodEnum) {
    return 'string'
  }
  if (inner instanceof z.ZodNumber) {
    return 'number'
  }
  if (inner instanceof z.ZodBoolean) {
    return 'boolean'
  }
  if (inner instanceof z.ZodUnion || inner instanceof z.ZodLiteral) {
    return 'union'
  }
  return 'json'
}

function topLevelShape(params: ParamSchema | null): Readonly<Record<string, ParamSchema>> {
  if (!params) {
    return {}
  }
  const inner = unwrapSchema(params)
  return inner instanceof z.ZodObject ? inner.shape : {}
}

function planParams(spec: PublicMethodSpec): { params: ParamPlan[]; positionals: ParamPlan[] } {
  const shape = topLevelShape(spec.params)
  const positionalKeys = new Set(spec.positionals ?? [])
  const plans = new Map<string, ParamPlan>()
  for (const [key, schema] of Object.entries(shape)) {
    plans.set(key, {
      key,
      flag: toKebabCase(key),
      kind: kindOf(schema),
      schema,
      required: !z.safeParse(schema, undefined).success
    })
  }
  const positionals = (spec.positionals ?? []).flatMap((key) => {
    const plan = plans.get(key)
    return plan ? [plan] : []
  })
  // nested values and names that would shadow a built-in flag stay reachable through --params-json
  const params = [...plans.values()].filter(
    (plan) =>
      !positionalKeys.has(plan.key) && plan.kind !== 'json' && !RESERVED_FLAGS.has(plan.flag)
  )
  return { params, positionals }
}

function coerceScalar(plan: ParamPlan, raw: string): unknown {
  switch (plan.kind) {
    case 'number': {
      const value = Number(raw)
      if (raw.trim().length === 0 || !Number.isFinite(value)) {
        throw new RuntimeClientError('invalid_argument', `--${plan.flag} must be a number`)
      }
      return value
    }
    case 'boolean':
      if (raw === 'true' || raw === 'false') {
        return raw === 'true'
      }
      throw new RuntimeClientError('invalid_argument', `--${plan.flag} must be true or false`)
    case 'union': {
      const candidates: unknown[] = [raw]
      if (raw.trim().length > 0 && Number.isFinite(Number(raw))) {
        candidates.push(Number(raw))
      }
      if (raw === 'true' || raw === 'false') {
        candidates.push(raw === 'true')
      }
      return candidates.find((candidate) => z.safeParse(plan.schema, candidate).success) ?? raw
    }
    case 'json':
      try {
        return JSON.parse(raw)
      } catch {
        throw new RuntimeClientError('invalid_argument', `<${plan.flag}> must be valid JSON`)
      }
    default:
      return raw
  }
}

function readParamsJson(flags: Map<string, string | boolean>): Record<string, unknown> {
  const raw = getOptionalJsonFlag(flags, 'params-json')
  if (raw === undefined) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RuntimeClientError('invalid_argument', '--params-json must be valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RuntimeClientError('invalid_argument', '--params-json must be a JSON object')
  }
  return { ...parsed }
}

function readFlagValue(
  plan: ParamPlan,
  flags: Map<string, string | boolean>
): { present: false } | { present: true; value: unknown } {
  const value = flags.get(plan.flag)
  if (value === undefined) {
    return { present: false }
  }
  if (plan.kind === 'boolean' && value === true) {
    return { present: true, value: true }
  }
  rejectValuelessFlag(value, plan.flag)
  return { present: true, value: coerceScalar(plan, String(value)) }
}

/** Positional values are set into `flags` under the positional's name before dispatch. */
function buildParams(
  plans: { params: ParamPlan[]; positionals: ParamPlan[] },
  flags: Map<string, string | boolean>
): Record<string, unknown> {
  const built = readParamsJson(flags)
  for (const plan of [...plans.positionals, ...plans.params]) {
    const read = readFlagValue(plan, flags)
    if (read.present) {
      built[plan.key] = read.value
    }
  }
  return built
}

function flagNameForIssue(
  plans: { params: ParamPlan[]; positionals: ParamPlan[] },
  key: PropertyKey | undefined
): string | undefined {
  const plan = [...plans.positionals, ...plans.params].find((candidate) => candidate.key === key)
  if (!plan) {
    return typeof key === 'string' ? key : undefined
  }
  return plans.positionals.includes(plan) ? `<${plan.flag}>` : `--${plan.flag}`
}

function validateParams(
  spec: PublicMethodSpec,
  plans: { params: ParamPlan[]; positionals: ParamPlan[] },
  params: Record<string, unknown>
): void {
  if (!spec.params) {
    return
  }
  const result = spec.params.safeParse(params)
  if (result.success) {
    return
  }
  const detail = result.error.issues
    .map((issue) => {
      const name = flagNameForIssue(plans, issue.path[0])
      return name ? `${name}: ${issue.message}` : issue.message
    })
    .join('; ')
  throw new RuntimeClientError(
    'invalid_argument',
    `Invalid params for ${spec.cliPath.join(' ')}: ${detail}`
  )
}

function pickFields(value: unknown, fields: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => pickFields(entry, fields))
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.includes(key)))
}

function formatResultText(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2)
}

async function runGeneratedCommand(
  spec: PublicMethodSpec,
  plans: { params: ParamPlan[]; positionals: ParamPlan[] },
  ctx: HandlerContext
): Promise<void> {
  const params = buildParams(plans, ctx.flags)
  validateParams(spec, plans, params)
  const yes = ctx.flags.has('yes')
  const requestParams = spec.params ? params : undefined
  const hint = readCallerHintFromEnv(process.env)
  const caller = Object.keys(hint).length > 0 ? hint : undefined

  if (spec.streaming) {
    await ctx.client.stream(
      spec.method,
      requestParams,
      (frame) => console.log(JSON.stringify(frame)),
      { publicContract: true, caller }
    )
    return
  }
  const response = await ctx.client.call(spec.method, requestParams, {
    publicContract: true,
    confirm: yes,
    caller
  })
  const terse = ctx.flags.has('full') ? undefined : spec.terse
  const shaped = terse ? { ...response, result: pickFields(response.result, terse) } : response
  const { printResult } = await import('../format.js')
  printResult(shaped, ctx.json, formatResultText)
}

function buildHandler(spec: PublicMethodSpec): CommandHandler {
  const plans = planParams(spec)
  return async (ctx) => {
    try {
      await runGeneratedCommand(spec, plans, ctx)
    } catch (error) {
      throw markPublicContractError(error)
    }
  }
}

function buildSpec(spec: PublicMethodSpec): CommandSpec {
  const plans = planParams(spec)
  const mutates = spec.effect === 'mutate' || spec.destructive !== undefined
  const flags = [
    ...plans.positionals.map((plan) => plan.flag),
    ...plans.params.map((plan) => plan.flag),
    'params-json',
    ...(mutates ? ['yes'] : []),
    ...(spec.streaming ? [] : ['full'])
  ]
  const positionalUsage = plans.positionals.map((plan) => `<${plan.flag}>`)
  const flagUsage = plans.params.map((plan) => {
    const text = plan.kind === 'boolean' ? `--${plan.flag}` : `--${plan.flag} <value>`
    return plan.required ? text : `[${text}]`
  })
  return {
    path: spec.cliPath,
    summary: spec.summary,
    usage: [
      `quirky ${spec.cliPath.join(' ')}`,
      ...positionalUsage,
      ...flagUsage,
      `[--params-json '<json>']`,
      ...(mutates ? ['[--yes]'] : []),
      '[--json]'
    ].join(' '),
    allowedFlags: [...new Set(flags)],
    booleanFlags: plans.params.filter((plan) => plan.kind === 'boolean').map((plan) => plan.flag),
    positionalArgs: plans.positionals.map((plan) => plan.flag),
    ...(spec.destructive || spec.approvalCategory ? { destructive: true } : {}),
    notes: [
      `Calls ${spec.method} (${spec.stability}). Run \`quirky schema ${spec.cliPath.join(' ')}\` for the params and result JSON Schema.`,
      ...(spec.streaming ? ['Prints one JSON line per streamed frame until the stream ends.'] : []),
      'Nested params go in --params-json; named flags override matching keys in it.'
    ]
  }
}

/**
 * Derives a CLI command and handler from each public method spec. A spec whose `cliPath` is already
 * hand-written is skipped, so a hand-written command always wins. `handWrittenPaths` holds the
 * space-joined command paths.
 */
export function buildGeneratedCommands(
  publicSpecs: readonly PublicMethodSpec[],
  handWrittenPaths: ReadonlySet<string>
): GeneratedCommands {
  const specs: CommandSpec[] = []
  const handlers: Record<string, CommandHandler> = {}
  for (const publicSpec of publicSpecs) {
    const key = publicSpec.cliPath.join(' ')
    if (handWrittenPaths.has(key)) {
      continue
    }
    specs.push(buildSpec(publicSpec))
    handlers[key] = buildHandler(publicSpec)
  }
  return { specs, handlers }
}
