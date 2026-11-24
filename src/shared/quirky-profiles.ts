import { QUIRKY_BROWSER_PARTITION } from './constants'
import type { ExecutionHostId } from './execution-host'

export const QUIRKY_PROFILE_INDEX_SCHEMA_VERSION = 1
export const DEFAULT_LOCAL_QUIRKY_PROFILE_ID = 'local-default'
export const DEFAULT_LOCAL_QUIRKY_PROFILE_NAME = 'Personal'
const LEGACY_QUIRKY_BROWSER_SESSION_PARTITION_PREFIX = 'persist:quirky-browser-session-'

export type QuirkyProfileAvatar = {
  kind: 'initials'
  initials: string
  color: 'neutral'
}

export type QuirkyProfileKind = 'local' | 'cloud-linked'

export type QuirkyProfileSummary = {
  id: string
  name: string
  avatar: QuirkyProfileAvatar
  kind: QuirkyProfileKind
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
}

export type QuirkyProfileIndex = {
  schemaVersion: number
  activeProfileId: string
  profiles: QuirkyProfileSummary[]
}

export type QuirkyProfileListState = {
  activeProfileId: string
  profiles: QuirkyProfileSummary[]
}

export type QuirkyProfileListResult = QuirkyProfileListState & {
  // Why: gates the full multi-profile switcher UI; default builds show a
  // single-profile account menu instead.
  multiProfileUi: boolean
}

export type CreateLocalQuirkyProfileArgs = {
  name?: string
}

export type CreateLocalQuirkyProfileResult = QuirkyProfileListState & {
  profile: QuirkyProfileSummary
}

export type SwitchQuirkyProfileArgs = {
  profileId: string
}

export type SwitchQuirkyProfileResult = {
  status: 'already-active' | 'relaunching'
}

export type TransferQuirkyProfileProjectMode = 'move' | 'copy'

export type TransferQuirkyProfileProjectArgs = {
  sourceProfileId: string
  targetProfileId: string
  repoId: string
  mode: TransferQuirkyProfileProjectMode
}

export type FindQuirkyProfileProjectsByPathArgs = {
  path: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
  excludeProfileId?: string | null
}

export type QuirkyProfileProjectPresence = {
  profileId: string
  profileName: string
  profileKind: QuirkyProfileKind
  repoId: string
  repoName: string
}

export type FindQuirkyProfileProjectsByPathResult = {
  projects: QuirkyProfileProjectPresence[]
}

export type TransferQuirkyProfileProjectResult =
  | {
      status: 'transferred'
      mode: TransferQuirkyProfileProjectMode
      sourceProfileId: string
      targetProfileId: string
      sourceRepoId: string
      targetRepoId: string
      targetProjectId: string | null
      willRelaunch?: boolean
    }
  | {
      status: 'duplicate-target'
      sourceProfileId: string
      targetProfileId: string
      sourceRepoId: string
      duplicateRepoId: string
    }

export function createDefaultLocalQuirkyProfile(now: number): QuirkyProfileSummary {
  return {
    id: DEFAULT_LOCAL_QUIRKY_PROFILE_ID,
    name: DEFAULT_LOCAL_QUIRKY_PROFILE_NAME,
    avatar: { kind: 'initials', initials: 'P', color: 'neutral' },
    kind: 'local',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now
  }
}

function profilePartitionHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function getQuirkyProfileBrowserPartitionSegment(profileId: string): string {
  const safe = profileId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 48) || 'profile'
  return `${safe}-${profilePartitionHash(profileId)}`
}

export function getQuirkyProfileBrowserDefaultPartition(profileId: string): string {
  if (profileId === DEFAULT_LOCAL_QUIRKY_PROFILE_ID) {
    return QUIRKY_BROWSER_PARTITION
  }
  return `persist:quirky-profile-${getQuirkyProfileBrowserPartitionSegment(profileId)}-browser-default`
}

export function getQuirkyProfileBrowserSessionPartition(
  profileId: string,
  browserSessionProfileId: string
): string {
  if (profileId === DEFAULT_LOCAL_QUIRKY_PROFILE_ID) {
    return `${LEGACY_QUIRKY_BROWSER_SESSION_PARTITION_PREFIX}${browserSessionProfileId}`
  }
  return `persist:quirky-profile-${getQuirkyProfileBrowserPartitionSegment(
    profileId
  )}-browser-session-${browserSessionProfileId}`
}
