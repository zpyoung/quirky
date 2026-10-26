export type SchemaType = 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object' | 'null'

/** A flat subset of JSON Schema; `{}` accepts any value and `default` is documentation only. */
export type Schema = {
  type?: SchemaType
  description?: string
  enum?: (string | number)[]
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
  additionalProperties?: boolean
  minimum?: number
  maximum?: number
  default?: unknown
}

/** Params properties whose flag name is one of these get no flag on a generated command. */
export const RESERVED_FLAG_NAMES = ['help', 'json', 'params'] as const

/**
 * Checks that `value` is a schema in the supported subset and returns one message per problem,
 * each prefixed with `at`. With `options.object`, the top level must be `type: 'object'`.
 */
export function checkSchemaDeclaration(value: unknown, at: string, options: { object?: boolean } = {}): string[] {
  void value
  void at
  void options
  throw new Error('not implemented')
}

/** The first way `value` fails `schema`, as a message naming its path under `at`, or null. Never coerces. */
export function validateValue(schema: Schema, value: unknown, at = 'params'): string | null {
  void schema
  void value
  void at
  throw new Error('not implemented')
}

/** The CLI flag name for a params property: `worktreeId` becomes `worktree-id`. */
export function flagNameOf(property: string): string {
  void property
  throw new Error('not implemented')
}
