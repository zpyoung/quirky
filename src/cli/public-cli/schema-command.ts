import { z, type ZodType } from 'zod'
import type { CommandSpec } from '../command-spec'
import { findCommandSpec, GLOBAL_FLAGS } from '../args'
import type { CommandHandler } from '../dispatch'
import { getRepeatedStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime/types'
import type { PublicMethodSpec } from '../../shared/public-rpc/public-method-spec'
import { publicSpecForCliPath } from '../../shared/public-rpc/public-methods'

export type SchemaIndexEntry = { command: string; summary: string }

export type CommandSchema = {
  command: string
  method?: string
  summary: string
  params: unknown
  result: unknown
  stability: 'stable' | 'unstable' | null
  destructive: boolean
  approvalCategory: string | null
  errors: string[]
  streaming?: true
  flags: string[]
  positionalArgs: string[]
}

function toJsonSchema(schema: ZodType | null, io: 'input' | 'output'): unknown {
  return schema ? z.toJSONSchema(schema, { io, unrepresentable: 'any' }) : null
}

/** One entry per command that is not hidden, sorted by path. */
export function buildSchemaIndex(specs: readonly CommandSpec[]): SchemaIndexEntry[] {
  return specs
    .filter((spec) => spec.hidden !== true)
    .map((spec) => ({ command: spec.path.join(' '), summary: spec.summary }))
    .toSorted((a, b) => a.command.localeCompare(b.command))
}

function userFacingFlags(spec: CommandSpec): string[] {
  return spec.allowedFlags.filter((flag) => !GLOBAL_FLAGS.includes(flag))
}

/**
 * The machine-readable contract for one command. A command with a public spec reports that spec's
 * params, result, stability and errors; a hand-written command with none reports its flags and
 * leaves the contract fields empty.
 */
export function buildCommandSchema(
  commandSpec: CommandSpec,
  publicSpec: PublicMethodSpec | undefined
): CommandSchema {
  return {
    command: commandSpec.path.join(' '),
    ...(publicSpec ? { method: publicSpec.method } : {}),
    summary: commandSpec.summary,
    params: publicSpec ? toJsonSchema(publicSpec.params, 'input') : null,
    result: publicSpec ? toJsonSchema(publicSpec.result, 'output') : null,
    stability: publicSpec ? publicSpec.stability : null,
    destructive: publicSpec
      ? publicSpec.destructive !== undefined
      : commandSpec.destructive === true,
    approvalCategory: publicSpec?.approvalCategory ?? publicSpec?.destructive?.category ?? null,
    errors: publicSpec ? [...publicSpec.errors] : [],
    ...(publicSpec?.streaming ? { streaming: true as const } : {}),
    flags: userFacingFlags(commandSpec),
    positionalArgs: commandSpec.positionalArgs ?? []
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

/**
 * Builds the `schema` handler over a spec table, so tests can run it against a small one. It reads
 * only the static table, so it works with no runtime and over SSH.
 */
export function createSchemaHandler(
  getSpecs: () => readonly CommandSpec[],
  lookupPublicSpec: (path: readonly string[]) => PublicMethodSpec | undefined = publicSpecForCliPath
): CommandHandler {
  return async ({ flags, json }) => {
    const specs = getSpecs()
    const path = getRepeatedStringFlag(flags, 'path')
    if (path.length === 0) {
      const index = buildSchemaIndex(specs)
      if (json) {
        printJson(index)
      } else {
        console.log(index.map((entry) => `${entry.command}  ${entry.summary}`).join('\n'))
      }
      return
    }
    const commandSpec = findCommandSpec([...specs], path)
    if (commandSpec) {
      printJson(buildCommandSchema(commandSpec, lookupPublicSpec(commandSpec.path)))
      return
    }
    const prefix = path.join(' ')
    const group = buildSchemaIndex(specs).filter((entry) => entry.command.startsWith(`${prefix} `))
    if (group.length > 0) {
      console.log(group.map((entry) => `${entry.command}  ${entry.summary}`).join('\n'))
      return
    }
    throw new RuntimeClientError('not_found', `Unknown command: ${prefix}`, {
      next: [{ command: 'quirky schema', why: 'list every command' }]
    })
  }
}

export const SCHEMA_HANDLERS: Record<string, CommandHandler> = {
  schema: async (ctx) => {
    const { COMMAND_SPECS } = await import('../specs/index.js')
    await createSchemaHandler(() => COMMAND_SPECS)(ctx)
  }
}
