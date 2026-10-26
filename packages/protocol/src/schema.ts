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

const SCHEMA_KEYWORDS = [
  'type',
  'description',
  'enum',
  'items',
  'properties',
  'required',
  'additionalProperties',
  'minimum',
  'maximum',
  'default'
]
const SCHEMA_TYPES: readonly string[] = ['string', 'integer', 'number', 'boolean', 'array', 'object', 'null']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function ownValue(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined
}

function checkSchemaNode(node: Record<string, unknown>, at: string, problems: string[]): void {
  const problem = (text: string) => problems.push(`${at}: ${text}`)
  const type = node.type
  const typeIsKnown = typeof type === 'string' && SCHEMA_TYPES.includes(type)
  const typeIs = (...types: string[]) => type === undefined || (typeof type === 'string' && types.includes(type))

  for (const key of Object.keys(node)) {
    if (!SCHEMA_KEYWORDS.includes(key)) problem(`unsupported keyword ${key}`)
  }

  if ('type' in node) {
    if (typeof type !== 'string') problem('type must be a string')
    else if (!typeIsKnown) problem(`unknown type ${type}`)
  }

  if ('description' in node && typeof node.description !== 'string') problem('description must be a string')

  if ('enum' in node) {
    const values = node.enum
    if (!Array.isArray(values) || values.length === 0) {
      problem('enum must be a non-empty list')
    } else if (type === undefined || (typeIsKnown && !['string', 'integer', 'number'].includes(type))) {
      problem('enum needs type string, integer or number')
    } else if (typeIsKnown) {
      if (type === 'string' && !values.every((v) => typeof v === 'string')) problem('enum values must be strings')
      if (type === 'integer' && !values.every((v) => Number.isInteger(v))) problem('enum values must be integers')
      if (type === 'number' && !values.every(isFiniteNumber)) problem('enum values must be numbers')
    }
  }

  if ('items' in node) {
    if (type !== undefined && type !== 'array') problem('items is only allowed for an array')
    else collectSchemaProblems(node.items, `${at}.items`, problems)
  }

  const properties = node.properties
  let declared: string[] = []
  if ('properties' in node) {
    if (!isPlainObject(properties)) problem('properties must be an object')
    else if (!typeIs('object')) problem('properties is only allowed for an object')
    else {
      declared = Object.keys(properties)
      for (const name of declared) collectSchemaProblems(properties[name], `${at}.properties.${name}`, problems)
    }
  }

  if ('required' in node) {
    const required = node.required
    if (!Array.isArray(required) || !required.every((n) => typeof n === 'string')) {
      problem('required must be a list of property names')
    } else if (!typeIs('object')) {
      problem('required is only allowed for an object')
    } else {
      for (const name of required) {
        if (!declared.includes(name)) problem(`required names undeclared property ${name}`)
      }
    }
  }

  if ('additionalProperties' in node) {
    if (typeof node.additionalProperties !== 'boolean') problem('additionalProperties must be true or false')
    else if (!typeIs('object')) problem('additionalProperties is only allowed for an object')
  }

  for (const bound of ['minimum', 'maximum'] as const) {
    if (!(bound in node)) continue
    if (!isFiniteNumber(node[bound])) problem(`${bound} must be a number`)
    else if (!typeIs('integer', 'number')) problem(`${bound} is only allowed for a number`)
  }
  if (isFiniteNumber(node.minimum) && isFiniteNumber(node.maximum) && node.minimum > node.maximum) {
    problem('minimum must not be greater than maximum')
  }
}

function collectSchemaProblems(value: unknown, at: string, problems: string[]): void {
  if (!isPlainObject(value)) problems.push(`${at} must be a schema object`)
  else checkSchemaNode(value, at, problems)
}

/**
 * Checks that `value` is a schema in the supported subset and returns one message per problem,
 * each prefixed with `at`. With `options.object`, the top level must be `type: 'object'`.
 */
export function checkSchemaDeclaration(value: unknown, at: string, options: { object?: boolean } = {}): string[] {
  const problems: string[] = []
  if (!isPlainObject(value)) return [`${at} must be a schema object`]
  if (options.object && value.type !== 'object') problems.push(`${at} must be an object schema`)
  checkSchemaNode(value, at, problems)
  return problems
}

const TYPE_MESSAGES: Record<SchemaType, string> = {
  string: 'a string',
  integer: 'an integer',
  number: 'a number',
  boolean: 'a boolean',
  array: 'an array',
  object: 'an object',
  null: 'null'
}

function matchesType(type: SchemaType, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return Number.isInteger(value)
    case 'number':
      return isFiniteNumber(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
    case 'null':
      return value === null
  }
}

function validateObject(schema: Schema, value: Record<string, unknown>, at: string): string | null {
  for (const name of schema.required ?? []) {
    if (ownValue(value, name) === undefined) return `${at}.${name} is required`
  }
  const properties = schema.properties ?? {}
  for (const [name, propertySchema] of Object.entries(properties)) {
    const present = ownValue(value, name)
    if (present === undefined) continue
    const failure = validateValue(propertySchema, present, `${at}.${name}`)
    if (failure) return failure
  }
  if (schema.additionalProperties !== true) {
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key) && value[key] !== undefined) return `${at}.${key} is not allowed`
    }
  }
  return null
}

function constrainsObject(schema: Schema): boolean {
  return (
    schema.type === 'object' ||
    (schema.type === undefined &&
      (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined))
  )
}

/**
 * The first way `value` fails `schema`, as a message naming its path under `at`, or null. Never coerces.
 * An untyped schema constrains object properties only when it declares `properties`, `required` or
 * `additionalProperties`, so `{}` accepts any value.
 */
export function validateValue(schema: Schema, value: unknown, at = 'params'): string | null {
  if (schema.type !== undefined && !matchesType(schema.type, value)) return `${at} must be ${TYPE_MESSAGES[schema.type]}`
  if (schema.enum && !schema.enum.includes(value as string | number)) {
    return `${at} must be one of ${schema.enum.join(', ')}`
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be at least ${schema.minimum}`
    if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be at most ${schema.maximum}`
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const failure = validateValue(schema.items, value[i], `${at}[${i}]`)
      if (failure) return failure
    }
  }
  if (isPlainObject(value) && constrainsObject(schema)) return validateObject(schema, value, at)
  return null
}

/** The CLI flag name for a params property: `worktreeId` becomes `worktree-id`. */
export function flagNameOf(property: string): string {
  return property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
}
