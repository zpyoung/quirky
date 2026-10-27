import { hasOption, removeConflicts, terminatorIndex } from './arg-occurrence'
import { COMPOSE_RULES } from './compose'
import { SelectionError } from './selection'
import { joinCommand } from './shell'
import type {
  AgentEntry,
  Conflict,
  LaunchCatalog,
  LaunchSettings,
  OptionDecl,
  ParsedExtras,
  Resolution,
  ValidSelection
} from './types'

export type ResolveInput = {
  entry: AgentEntry
  /** The command override's tokens; empty unless the user overrode the command. */
  commandTokens: string[]
  /** The agent's saved (or Yolo) arguments, already tokenized. */
  configuredArgs: string[]
  selection: ValidSelection | null
  extras: ParsedExtras | null
  /** True for a structured session, which takes options instead of argv. */
  structured: boolean
}

type Value = string | boolean
type Picked = { option: OptionDecl; value: Value }

const COMMAND_OVERRIDE_CONFLICT =
  'Agent command override conflicts with the requested launch preferences. Remove model or effort flags from the command override.'

const substitute = (template: string[], value: Value): string[] =>
  template.map((item) => item.replace('{value}', () => String(value)))

function insertBeforeTerminator(tokens: string[], inserted: string[], valueFlags: string[]): string[] {
  const at = terminatorIndex(tokens, valueFlags)
  return [...tokens.slice(0, at), ...inserted, ...tokens.slice(at)]
}

function unsupportedModel(entry: AgentEntry): SelectionError {
  return new SelectionError(`Agent ${entry.id} does not support launch-time model selection.`)
}

/** The picked options in the catalog's declared order. */
function pickedOptions(entry: AgentEntry, catalog: LaunchCatalog, selection: ValidSelection): Picked[] {
  for (const [id, value] of Object.entries(selection.values)) {
    if (!catalog.options.some((option) => option.id === id)) {
      throw new SelectionError(`Agent ${entry.id} model ${selection.model} does not support ${id} ${value}.`)
    }
  }
  return catalog.options.flatMap((option) =>
    Object.hasOwn(selection.values, option.id) ? [{ option, value: selection.values[option.id]! }] : []
  )
}

/** The one-line description of a launch: agent, model, then each explicit option. */
export function formatSummary(entry: AgentEntry, options: LaunchSettings['options']): string {
  const parts = [entry.label]
  const catalog = entry.launchOptions
  const model = options.model
  if (model?.source === 'explicit' && typeof model.value === 'string') {
    parts.push(catalog?.models.find((listed) => listed.id === model.value)?.label ?? model.value)
  }
  for (const option of catalog?.options ?? []) {
    const picked = options[option.id]
    if (picked?.source !== 'explicit' || picked.value === undefined) continue
    if (picked.value === true) parts.push(option.label)
    else parts.push(`${option.label}: ${picked.value === false ? 'Off' : picked.value}`)
  }
  return parts.join(' · ')
}

function snapshot(entry: AgentEntry, options: LaunchSettings['options'], args?: LaunchSettings['args']): LaunchSettings | null {
  if (Object.keys(options).length === 0 && !args) return null
  return { agent: entry.id, options, ...(args ? { args } : {}), summary: formatSummary(entry, options) }
}

function resolveStructured(input: ResolveInput, catalog: LaunchCatalog | null, picks: Picked[]): Resolution {
  const { entry, selection, extras } = input
  if (extras) throw new SelectionError("Extra arguments can't be applied to a structured session.")
  const options: LaunchSettings['options'] = Object.create(null)
  const structured: Record<string, Value> = Object.create(null)
  if (selection && catalog) {
    if (!catalog.model.structured) throw unsupportedModel(entry)
    for (const { option } of picks) {
      if (!option.structured) throw new SelectionError(`Agent ${entry.id} option ${option.id} can't be applied to a structured launch.`)
    }
    structured[catalog.model.structured] = selection.model
    options.model = { value: selection.model, source: 'explicit' }
    for (const { option, value } of picks) {
      structured[option.structured!] = value
      options[option.id] = { value, source: 'explicit' }
    }
  }
  return { added: [], args: [], structured, shadowed: [], launchSettings: snapshot(entry, options) }
}

/**
 * Turns the agent's configured arguments, extra arguments and a validated pick into the argv a
 * launch uses, the structured-session options, and the snapshot a session stores, in one pass so
 * the three always agree. Extras beat the pick, the pick beats configured arguments, and a beaten
 * flag is removed rather than repeated. Pure; throws `SelectionError` for a pick the transport
 * can't carry or one a command override already contradicts.
 */
export function resolveLaunch(input: ResolveInput): Resolution {
  const { entry, commandTokens, configuredArgs, selection, extras, structured } = input
  const catalog = entry.launchOptions
  if (selection && !catalog) throw unsupportedModel(entry)
  const picks = selection && catalog ? pickedOptions(entry, catalog, selection) : []
  if (structured) return resolveStructured(input, catalog, picks)

  for (const { option } of picks) {
    if (!option.flag && !option.composed) {
      throw new SelectionError(`Agent ${entry.id} option ${option.id} can't be applied to a terminal launch.`)
    }
  }

  const valueFlags = catalog?.valueFlags ?? []
  const modelConflicts = catalog?.model.conflicts ?? []
  const effortConflicts = catalog?.options.find((option) => option.id === 'effort')?.conflicts ?? []
  const extrasSet = (conflicts: Conflict[]) => extras !== null && conflicts.some((conflict) => hasOption(extras.tokens, conflict, valueFlags))

  let args = [...configuredArgs]
  if (extras) {
    if (extras.kinds.has('model')) args = removeConflicts(args, modelConflicts, valueFlags)
    if (extras.kinds.has('effort')) args = removeConflicts(args, effortConflicts, valueFlags)
    args = insertBeforeTerminator(args, extras.tokens, valueFlags)
  }

  const modelShadowed = selection !== null && (extras?.kinds.has('model') ?? false)
  const shadowedOption = (option: OptionDecl) => modelShadowed || (!option.composed && extrasSet(option.conflicts))
  const emitted = picks.filter(({ option }) => !shadowedOption(option))
  const flagged = emitted.filter(({ option }) => !option.composed)

  if (selection && catalog && !modelShadowed) args = removeConflicts(args, modelConflicts, valueFlags)
  for (const { option } of flagged) args = removeConflicts(args, option.conflicts, valueFlags)

  const added: string[] = []
  if (selection && catalog && !modelShadowed) {
    const model = catalog.composeModel && selection.listed ? COMPOSE_RULES[catalog.composeModel](selection.model, selection.values) : selection.model
    added.push(...substitute(catalog.model.flag, model))
  }
  for (const { option, value } of flagged) added.push(...substitute(option.flag!, value))

  if (commandTokens.length > 1) {
    const own = commandTokens.slice(1)
    const setsModel = (selection !== null && !modelShadowed) || (extras?.kinds.has('model') ?? false) || extrasSet(modelConflicts)
    const setsEffort = flagged.some(({ option }) => option.id === 'effort') || (extras?.kinds.has('effort') ?? false) || extrasSet(effortConflicts)
    const contradicts = (conflicts: Conflict[]) => conflicts.some((conflict) => hasOption(own, conflict, valueFlags))
    if ((setsModel && contradicts(modelConflicts)) || (setsEffort && contradicts(effortConflicts))) {
      throw new SelectionError(COMMAND_OVERRIDE_CONFLICT)
    }
  }

  const options: LaunchSettings['options'] = Object.create(null)
  const structuredOptions: Record<string, Value> = Object.create(null)
  if (selection && catalog) {
    if (modelShadowed) {
      options.model = { source: 'extra-args' }
    } else {
      options.model = { value: selection.model, source: 'explicit' }
      if (catalog.model.structured) structuredOptions[catalog.model.structured] = selection.model
    }
    for (const { option, value } of picks) {
      if (shadowedOption(option)) {
        options[option.id] = { source: 'extra-args' }
      } else {
        options[option.id] = { value, source: 'explicit' }
        if (option.structured) structuredOptions[option.structured] = value
      }
    }
  }

  const launchSettings = snapshot(
    entry,
    options,
    args.length > 0 ? { value: joinCommand(args), source: extras ? 'explicit' : 'inherited' } : undefined
  )
  return {
    added,
    args: insertBeforeTerminator(args, added, valueFlags),
    structured: structuredOptions,
    shadowed: Object.keys(options).filter((id) => options[id]!.source === 'extra-args'),
    launchSettings
  }
}
