import { createHash } from 'node:crypto'

const MAX_IDENTITY_LENGTH = 512
const PARTITION_IDENTITY_VERSION = 1
const BROWSER_ROUTE_PARTITION_RE = /^persist:quirky-browser-v1-[a-f0-9]{64}$/

export type BrowserRoutePartitionIdentity = Readonly<{
  quirkyProfileId: string
  browserProfileId: string
  authorityConnectionIdentity: string
  executionHostIdentity: string
}>

export type DerivedBrowserRoutePartition = Readonly<{
  partition: string
  bindingFingerprint: string
}>

export function deriveBrowserRoutePartition(
  identity: BrowserRoutePartitionIdentity
): DerivedBrowserRoutePartition {
  const components = [
    ['quirky-profile', identity.quirkyProfileId],
    ['browser-profile', identity.browserProfileId],
    ['authority-connection', identity.authorityConnectionIdentity],
    ['execution-host', identity.executionHostIdentity]
  ] as const
  for (const [, value] of components) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      Buffer.byteLength(value, 'utf8') > MAX_IDENTITY_LENGTH
    ) {
      throw new Error('browser_route_partition_identity_invalid')
    }
  }

  return {
    partition: `persist:quirky-browser-v${PARTITION_IDENTITY_VERSION}-${digest([
      'quirky-browser-route-partition',
      PARTITION_IDENTITY_VERSION,
      ...components
    ])}`,
    bindingFingerprint: digest([
      'quirky-browser-route-partition-binding',
      PARTITION_IDENTITY_VERSION,
      ...components
    ])
  }
}

/**
 * Opaque owner of a partition's storage lifecycle: the local environment record
 * whose explicit removal clears it. Derived without a live connection so
 * lifecycle events can find partitions the client cannot currently re-derive.
 */
export function deriveBrowserRoutePartitionStorageScope(scope: {
  quirkyProfileId: string
  environmentId: string
}): string {
  return digest([
    'quirky-browser-route-partition-scope',
    PARTITION_IDENTITY_VERSION,
    ['quirky-profile', scope.quirkyProfileId],
    ['environment', scope.environmentId]
  ])
}

/**
 * Storage scope for a partition owned by a directly-connected SSH target (no
 * paired environment). Distinct digest domain from environment scopes, so the
 * two owner kinds can never collide; removing the SSH target clears it.
 */
export function deriveLocalSshBrowserRoutePartitionStorageScope(scope: {
  quirkyProfileId: string
  targetId: string
}): string {
  return digest([
    'quirky-browser-route-partition-scope',
    PARTITION_IDENTITY_VERSION,
    ['quirky-profile', scope.quirkyProfileId],
    ['local-ssh-target', scope.targetId]
  ])
}

export function isBrowserRoutePartition(value: string): boolean {
  return BROWSER_ROUTE_PARTITION_RE.test(value)
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}
