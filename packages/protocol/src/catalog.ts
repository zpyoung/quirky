import type { Schema } from './schema'

/** Bumped only on a breaking change to the shape of `ApiDescription` or `ApiCatalog`. */
export const CATALOG_SCHEMA_VERSION = 2

/** `plugin` is null for the kernel's own methods. */
export type ApiMethodEntry = {
  name: string
  plugin: string | null
  description?: string
  params: Schema
  result: Schema
  /** Set on methods that only make sense on a live connection. */
  connection?: true
  /** Set on methods that change nothing; never recorded under a request ID. */
  readOnly?: true
  /** Set on methods that run only with `yes` or an answered confirmation. */
  destructive?: true
  /** The confirmation text of a destructive method; `{name}` placeholders take the params. */
  confirm?: string
}

export type ApiEventEntry = { name: string; plugin: string | null; description?: string; data: Schema | null }

export type ApiUiCommandEntry = { id: string; plugin: string; title: string; description?: string; args: Schema }

/** A plugin's CLI group word and the extra words that reach it, after collision checks. */
export type ApiCliGroup = { plugin: string; words: string; aliases: string[] }

/** A positional of a plugin CLI command; `param` is the method param it fills. */
export type ApiCliPositional = { name: string; description: string; required: boolean; param: string }

/** A flag of a plugin CLI command; `param` is the method param it fills. */
export type ApiCliFlag = ApiFlagEntry & { param: string }

/** A plugin CLI command: run against `method` generically, or by the plugin's CLI `module`. */
export type ApiCliCommandEntry = {
  id: string
  plugin: string
  words: string
  aliasWords: string[]
  summary: string
  positionals: ApiCliPositional[]
  flags: ApiCliFlag[]
  method: string | null
  methods: string[]
  /** Absolute path of the plugin's CLI module, or null for a generic command. */
  module: string | null
}

/** What `api.describe` returns: every in-effect method, event and UI command, each list sorted by name. */
export type ApiDescription = {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION
  daemonVersion: string
  protocolVersion: number
  methods: ApiMethodEntry[]
  events: ApiEventEntry[]
  uiCommands: ApiUiCommandEntry[]
  cli: { groups: ApiCliGroup[]; commands: ApiCliCommandEntry[] }
}

export type ApiFlagEntry = {
  name: string
  type: 'string' | 'integer' | 'number' | 'boolean' | 'json'
  description: string
  required: boolean
  repeatable: boolean
  enum?: (string | number)[]
}

export type ApiCommandEntry = {
  command: string
  plugin: string | null
  methods: string[]
  summary: string
  usage: string
  positionals: { name: string; description: string; required: boolean }[]
  flags: ApiFlagEntry[]
  shadowedBy?: string
}

/** What `quirky api --json` prints: the daemon's description plus every CLI command. */
export type ApiCatalog = ApiDescription & { commands: ApiCommandEntry[] }
