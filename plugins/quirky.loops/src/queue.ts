import type { IterationEnd, QueueItem, QueueOperation } from './types'

export class QueueItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Queue item not found: ${id}`)
    this.name = 'QueueItemNotFoundError'
  }
}

export class QueueConflictError extends Error {
  constructor(id: string, action = 'change') {
    super(`Cannot ${action} in-flight queue item: ${id}`)
    this.name = 'QueueConflictError'
  }
}

export type QueueClaim = { id: string; body: string }
export type QueueClaimResult = { items: readonly QueueItem[]; claim: QueueClaim | null }

function reindex(items: QueueItem[]): QueueItem[] {
  for (let position = 0; position < items.length; position += 1) {
    const item = items[position]!
    if (item.position !== position) items[position] = { ...item, position }
  }
  return items
}

function assertBody(body: unknown): asserts body is string {
  if (typeof body !== 'string' || body.trim().length === 0) {
    throw new TypeError('Queue item body must be a nonblank string')
  }
}

function assertPosition(position: unknown, length: number, allowEnd: boolean): asserts position is number {
  if (
    typeof position !== 'number' ||
    !Number.isInteger(position) ||
    position < 0 ||
    (allowEnd ? position > length : position >= length)
  ) {
    throw new TypeError('Queue position is outside the valid range')
  }
}

function assertId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('Queue item id must be a nonblank string')
  }
}

function findTarget(items: readonly QueueItem[], id: string): { item: QueueItem; index: number } {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!
    if (item.id === id) return { item, index }
  }
  throw new QueueItemNotFoundError(id)
}

function assertNotInFlight(item: QueueItem): void {
  if (item.state === 'in-flight') throw new QueueConflictError(item.id)
}

export function applyQueueOperation(
  items: readonly QueueItem[],
  operation: QueueOperation,
  newItemId?: string
): readonly QueueItem[] {
  if (typeof operation !== 'object' || operation === null) {
    throw new TypeError('Invalid queue operation')
  }

  switch (operation.kind) {
    case 'add': {
      assertBody(operation.body)
      const position = operation.position === undefined ? items.length : operation.position
      assertPosition(position, items.length, true)
      assertId(newItemId)
      if (items.some((item) => item.id === newItemId)) {
        throw new TypeError(`Queue item id already exists: ${newItemId}`)
      }
      const result = items.slice()
      result.splice(position, 0, { id: newItemId, position, body: operation.body, state: 'pending' })
      return reindex(result)
    }
    case 'edit': {
      assertId(operation.id)
      assertBody(operation.body)
      const { item: target, index } = findTarget(items, operation.id)
      assertNotInFlight(target)
      if (target.body === operation.body) return items
      const result = items.slice()
      result[index] = { ...target, body: operation.body }
      return result
    }
    case 'move': {
      assertId(operation.id)
      const { item: target, index } = findTarget(items, operation.id)
      assertPosition(operation.position, items.length, false)
      assertNotInFlight(target)
      if (index === operation.position) return items
      const result = items.slice()
      result.splice(index, 1)
      result.splice(operation.position, 0, target)
      return reindex(result)
    }
    case 'remove': {
      assertId(operation.id)
      const { index, item: target } = findTarget(items, operation.id)
      assertNotInFlight(target)
      const result = items.slice()
      result.splice(index, 1)
      return reindex(result)
    }
    default:
      throw new TypeError('Invalid queue operation kind')
  }
}

export function claimNextQueueItem(items: readonly QueueItem[], repeatQueue: boolean): QueueClaimResult {
  let index = items.findIndex((item) => item.state === 'in-flight')
  if (index >= 0) {
    const claimed = items[index]!
    return { items, claim: { id: claimed.id, body: claimed.body } }
  }

  index = items.findIndex((item) => item.state === 'pending')
  if (index >= 0) {
    const result = items.slice()
    const claimed = items[index]!
    result[index] = { ...claimed, state: 'in-flight' }
    return { items: result, claim: { id: claimed.id, body: claimed.body } }
  }

  if (!repeatQueue || items.length === 0) return { items, claim: null }

  const result = items.slice()
  for (let position = 0; position < result.length; position += 1) {
    const item = result[position]!
    if (item.state === 'done') {
      result[position] = { ...item, state: position === 0 ? 'in-flight' : 'pending' }
    }
  }
  const claimed = result[0]!
  return { items: result, claim: { id: claimed.id, body: claimed.body } }
}

export function settleQueueClaim(
  items: readonly QueueItem[],
  id: string,
  end: IterationEnd
): readonly QueueItem[] {
  assertId(id)
  switch (end) {
    case 'settled':
    case 'crashed':
    case 'interrupted':
    case 'stopped':
    case 'unverifiable':
      break
    default:
      throw new TypeError('Invalid queue claim outcome')
  }

  const { item: target, index } = findTarget(items, id)
  if (end !== 'settled') return items
  if (target.state !== 'in-flight') throw new QueueConflictError(id, 'settle')

  const result = items.slice()
  result[index] = { ...target, state: 'done' }
  return result
}

