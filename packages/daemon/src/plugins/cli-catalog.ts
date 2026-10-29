import { resolve } from 'node:path'
import {
  flagNameOf,
  KERNEL_METHOD_SCHEMAS,
  RESERVED_FLAG_NAMES,
  type ApiCliCommandEntry,
  type ApiCliFlag,
  type ApiCliGroup,
  type ApiCliPositional,
  type ApiDescription,
  type ContributionInfo,
  type PluginInfo,
  type Schema,
} from '@quirky/protocol'
import type { PluginHost } from './host'
import { cliGroupWord, effectiveCliWords } from './kinds'

/** CLI group words the kernel owns; a plugin alias equal to one is dropped. */
export const KERNEL_CLI_GROUPS = [
  'api',
  'daemon',
  'distro',
  'help',
  'job',
  'open',
  'plugin',
  'setting',
  'skill',
  'status',
  'theme',
  'ui',
] as const

type Entry = Record<string, unknown>
type Scalar = 'string' | 'integer' | 'number' | 'boolean'

const SCALARS: readonly unknown[] = ['string', 'integer', 'number', 'boolean']
const isScalar = (type: unknown): type is Scalar => SCALARS.includes(type)
const isReserved = (flag: string) => (RESERVED_FLAG_NAMES as readonly string[]).includes(flag)

function isRecord(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function derivedFlag(property: string, schema: Schema, required: boolean): ApiCliFlag | null {
  const name = flagNameOf(property)
  if (isReserved(name)) return null
  const base = { name, description: schema.description ?? '', required, param: property }
  if (isScalar(schema.type)) {
    return { ...base, type: schema.type, repeatable: false, ...(schema.enum ? { enum: schema.enum } : {}) }
  }
  if (schema.type === 'array' && isScalar(schema.items?.type)) {
    return {
      ...base,
      type: schema.items.type,
      repeatable: true,
      ...(schema.items.enum ? { enum: schema.items.enum } : {}),
    }
  }
  return { ...base, type: 'json', repeatable: false }
}

function flagsFromParams(params: Schema | undefined, taken: ReadonlySet<string>): ApiCliFlag[] {
  const required = params?.required ?? []
  const flags: ApiCliFlag[] = []
  for (const [property, schema] of Object.entries(params?.properties ?? {})) {
    if (taken.has(property)) continue
    const flag = derivedFlag(property, schema, required.includes(property))
    if (flag) flags.push(flag)
  }
  return flags
}

/** Inverse of `flagNameOf`: `max-rows` becomes `maxRows`. */
const paramOf = (flag: string) => flag.replace(/-([a-z0-9])/g, (_, letter: string) => letter.toUpperCase())

function declaredFlags(flags: Entry): ApiCliFlag[] {
  return Object.entries(flags).map(([name, raw]) => {
    const spec = raw as Entry
    return {
      name,
      type: spec.type as ApiCliFlag['type'],
      description: spec.description as string,
      required: spec.required === true,
      repeatable: spec.repeatable === true,
      ...(Array.isArray(spec.enum) ? { enum: spec.enum as (string | number)[] } : {}),
      param: typeof spec.param === 'string' ? spec.param : paramOf(name),
    }
  })
}

function declaredPositionals(positionals: unknown): ApiCliPositional[] {
  if (!Array.isArray(positionals)) return []
  return positionals.map((raw) => {
    const item = raw as Entry
    const name = item.name as string
    return {
      name,
      description: item.description as string,
      required: item.required === true,
      param: typeof item.param === 'string' ? item.param : name,
    }
  })
}

/** A plugin with a CLI group and the alias words its manifest asks for. */
export type CliAliasClaimant = { id: string; source: 'builtin' | 'installed'; aliases: string[] }

/** The outcome of alias collision checks across every plugin with a CLI group. */
export type CliAliasResolution = {
  /** Plugin ID to the aliases it kept, in the order it wrote them. */
  accepted: Map<string, string[]>
  /** Plugin ID to the aliases it lost, each with the reason shown in the warning. */
  dropped: Map<string, { alias: string; reason: string }[]>
}

/**
 * Settles which plugin keeps each alias word. Built-ins come before installed plugins, then by
 * plugin ID. A word is dropped when it is a kernel group, another plugin's group word, or already
 * taken by an earlier plugin.
 */
export function resolveCliAliases(claimants: readonly CliAliasClaimant[]): CliAliasResolution {
  const ordered = [...claimants].sort((a, b) =>
    a.source === b.source ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.source === 'builtin' ? -1 : 1
  )
  const groupWords = new Map(ordered.map((claimant) => [cliGroupWord(claimant.id), claimant.id]))
  const holders = new Map<string, string>()
  const accepted = new Map<string, string[]>()
  const dropped = new Map<string, { alias: string; reason: string }[]>()
  for (const claimant of ordered) {
    const kept: string[] = []
    const lost: { alias: string; reason: string }[] = []
    for (const alias of claimant.aliases) {
      const groupOwner = groupWords.get(alias)
      const holder = holders.get(alias)
      if ((KERNEL_CLI_GROUPS as readonly string[]).includes(alias)) lost.push({ alias, reason: 'it is a built-in CLI group' })
      else if (groupOwner !== undefined && groupOwner !== claimant.id) {
        lost.push({ alias, reason: `it is the CLI group word of plugin ${groupOwner}` })
      } else if (holder !== undefined) lost.push({ alias, reason: `plugin ${holder} already uses it` })
      else {
        holders.set(alias, claimant.id)
        kept.push(alias)
      }
    }
    accepted.set(claimant.id, kept)
    if (lost.length > 0) dropped.set(claimant.id, lost)
  }
  return { accepted, dropped }
}

type Group = { info: PluginInfo; words: string; aliases: string[]; cli?: string }

/** Plugins with a CLI presence, built-ins first and then by ID, each with the aliases it won. */
function resolveGroups(plugins: PluginHost, owners: ReadonlySet<string>): Group[] {
  const infos = plugins.list()
  const primary = (id: string) => infos.find((info) => info.id === id && info.state !== 'invalid')
  const claimed = [...owners]
    .map(primary)
    .filter((info): info is PluginInfo => info !== undefined)
    .sort((a, b) => (a.source === b.source ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.source === 'builtin' ? -1 : 1))

  return claimed.map((info) => {
    for (const { alias, reason } of plugins.droppedCliAliases(info.id)) {
      const message = `cliAliases: '${alias}' is dropped because ${reason}`
      if (!info.diagnostics.some((item) => item.message === message)) plugins.addWarning(info.id, message)
    }
    return { info, words: cliGroupWord(info.id), aliases: info.cliAliases ?? [], cli: plugins.cliOf(info.id).cli }
  })
}

function commandEntry(
  contribution: ContributionInfo,
  group: Group,
  methodSchemas: ReadonlyMap<string, Schema>,
): ApiCliCommandEntry {
  const data = contribution.data
  const short = typeof data.method === 'string' ? data.method : null
  const method = short === null ? null : short.includes('/') ? short : `${contribution.plugin}/${short}`
  const positionals = declaredPositionals(data.positionals)
  const flags = isRecord(data.flags)
    ? declaredFlags(data.flags)
    : method === null
      ? []
      : flagsFromParams(methodSchemas.get(method), new Set(positionals.map((item) => item.param)))
  const suffix = effectiveCliWords(contribution.name, data.words)
  const withGroup = (word: string) => (suffix === '' ? word : `${word} ${suffix}`)
  const apiVersion = group.info.apiVersion
  if (apiVersion === undefined) throw new Error(`plugin ${group.info.id} has no validated apiVersion`)
  return {
    id: contribution.id,
    plugin: contribution.plugin,
    apiVersion,
    words: withGroup(group.words),
    aliasWords: group.aliases.map(withGroup),
    summary: data.summary as string,
    positionals,
    flags,
    method,
    methods: Array.isArray(data.methods) ? (data.methods as string[]) : method === null ? [] : [method],
    module: group.cli === undefined ? null : resolve(group.info.dir, group.cli),
  }
}

/**
 * The `cli` section of `api.describe`: plugin CLI groups, aliases and commands in effect. Aliases
 * that collide are dropped here and reported as a warning on the plugin that declared them.
 */
export function describeCli(plugins: PluginHost): ApiDescription['cli'] {
  const commands = plugins.contributions({ kind: 'cli-command' })
  const methods = plugins.contributions({ kind: 'method' })
  const groups = resolveGroups(plugins, new Set([...commands, ...methods].map((contribution) => contribution.plugin)))
  const byPlugin = new Map(groups.map((group) => [group.info.id, group]))

  const methodSchemas = new Map<string, Schema>()
  for (const [name, entry] of Object.entries(KERNEL_METHOD_SCHEMAS as Record<string, { params: Schema }>)) {
    methodSchemas.set(name, entry.params)
  }
  for (const contribution of methods) {
    const params = contribution.data.params
    methodSchemas.set(contribution.id.slice(contribution.kind.length + 1), isRecord(params) ? (params as Schema) : { type: 'object' })
  }

  const catalog: ApiCliGroup[] = groups
    .map(({ info, words, aliases }) => ({ plugin: info.id, words, aliases }))
    .sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0))
  return {
    groups: catalog,
    commands: commands
      .filter((contribution) => byPlugin.has(contribution.plugin))
      .map((contribution) => commandEntry(contribution, byPlugin.get(contribution.plugin)!, methodSchemas)),
  }
}
