import type { Schema } from './schema'

/** Bumped only on a breaking change to the shape of `ApiDescription` or `ApiCatalog`. */
export const CATALOG_SCHEMA_VERSION = 1

/** `plugin` is null for the kernel's own methods. */
export type ApiMethodEntry = {
  name: string
  plugin: string | null
  description?: string
  params: Schema
  result: Schema
  /** Set on methods that only make sense on a live connection. */
  connection?: true
}

export type ApiEventEntry = { name: string; plugin: string | null; description?: string; data: Schema | null }

export type ApiUiCommandEntry = { id: string; plugin: string; title: string; description?: string; args: Schema }

/** What `api.describe` returns: every in-effect method, event and UI command, each list sorted by name. */
export type ApiDescription = {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION
  daemonVersion: string
  protocolVersion: number
  methods: ApiMethodEntry[]
  events: ApiEventEntry[]
  uiCommands: ApiUiCommandEntry[]
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
