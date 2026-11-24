import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { bestEffortFsyncDirectorySync, fsyncFileSync } from '../../shared/secure-file'
import {
  createDefaultLocalQuirkyProfile,
  DEFAULT_LOCAL_QUIRKY_PROFILE_ID,
  DEFAULT_LOCAL_QUIRKY_PROFILE_NAME,
  QUIRKY_PROFILE_INDEX_SCHEMA_VERSION,
  type CreateLocalQuirkyProfileArgs,
  type CreateLocalQuirkyProfileResult,
  type QuirkyProfileIndex,
  type QuirkyProfileListState,
  type QuirkyProfileSummary
} from '../../shared/quirky-profiles'
import {
  getQuirkyProfileDataFile,
  getQuirkyProfileDirectory,
  getQuirkyProfileIndexPath,
  getQuirkyProfileStateDatabaseFile,
  hasQuirkyProfileStateDatabase,
  getProfileUserDataPath
} from './profile-storage-paths'
import { copyLegacyStateToProfile } from './profile-legacy-state-import'
import { profileStateJsonExportPaths } from '../persistence/profile-state/legacy-json/profile-state-export-path'
import { hasProfileStateAuthorityMarker } from '../persistence/profile-state/profile-state-authority-marker'
import { profileStateDatabaseBackups } from '../persistence/profile-state/profile-state-backup-path'

export {
  getQuirkyProfileBrowserSessionMetaFile,
  getQuirkyProfileDataFile,
  getQuirkyProfileDirectory,
  getQuirkyProfileIndexPath,
  getQuirkyProfileStateDatabaseFile,
  hasQuirkyProfileStateDatabase,
  getQuirkyProfilesDirectory,
  initQuirkyProfilePaths
} from './profile-storage-paths'

export type ActiveQuirkyProfileState = {
  index: QuirkyProfileIndex
  profile: QuirkyProfileSummary
  dataFile: string
  stateDatabaseFile: string
  profileDirectory: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProfileSummary(value: unknown): value is QuirkyProfileSummary {
  if (!isObject(value)) {
    return false
  }
  const avatar = value.avatar
  const cloud = value.cloud
  return (
    typeof value.id === 'string' &&
    // Why: IDs from the on-disk index become filesystem path segments; a
    // tampered index must not be able to escape the profiles directory.
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.id) &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    (value.kind === 'local' || value.kind === 'cloud-linked') &&
    typeof value.createdAt === 'number' &&
    typeof value.updatedAt === 'number' &&
    typeof value.lastOpenedAt === 'number' &&
    isObject(avatar) &&
    avatar.kind === 'initials' &&
    typeof avatar.initials === 'string' &&
    avatar.color === 'neutral' &&
    (cloud === undefined || isObject(cloud))
  )
}

function normalizeProfileIndex(raw: unknown): QuirkyProfileIndex | null {
  if (!isObject(raw) || !Array.isArray(raw.profiles)) {
    return null
  }
  const profiles = raw.profiles.filter(isProfileSummary)
  const activeProfileId =
    typeof raw.activeProfileId === 'string' &&
    profiles.some((profile) => profile.id === raw.activeProfileId)
      ? raw.activeProfileId
      : profiles[0]?.id
  if (!activeProfileId) {
    return null
  }
  return {
    schemaVersion: QUIRKY_PROFILE_INDEX_SCHEMA_VERSION,
    activeProfileId,
    profiles
  }
}

function sanitizeProfileName(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed.slice(0, 80) : 'New Profile'
}

function readProfileIndexFile(indexPath: string): QuirkyProfileIndex | null {
  try {
    return normalizeProfileIndex(JSON.parse(readFileSync(indexPath, 'utf-8')))
  } catch {
    return null
  }
}

export function readProfileIndex(indexPath: string): QuirkyProfileIndex | null {
  // Why: a torn/corrupt index must not silently reset the app to a single
  // default profile — that would orphan every other profile's data directory.
  return readProfileIndexFile(indexPath) ?? readProfileIndexFile(`${indexPath}.bak`)
}

function readExistingProfileIndex(indexPath: string): QuirkyProfileIndex | null {
  const index = readProfileIndex(indexPath)
  if (!index && (existsSync(indexPath) || existsSync(`${indexPath}.bak`))) {
    throw new Error(`Could not read active profile index ${indexPath}`)
  }
  return index
}

export function writeProfileIndex(indexPath: string, index: QuirkyProfileIndex): void {
  mkdirSync(dirname(indexPath), { recursive: true })
  // Why: only a still-parseable current index may refresh the backup;
  // copying a corrupt file over the backup would destroy the recovery copy.
  if (existsSync(indexPath) && readProfileIndexFile(indexPath)) {
    try {
      copyFileSync(indexPath, `${indexPath}.bak`)
    } catch {
      // Best-effort backup; the primary write below still proceeds.
    }
  }
  const tmpPath = `${indexPath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf-8')
  fsyncFileSync(tmpPath)
  renameSync(tmpPath, indexPath)
  bestEffortFsyncDirectorySync(dirname(indexPath))
}

function createInitialProfileIndex(now = Date.now()): QuirkyProfileIndex {
  const profile = createDefaultLocalQuirkyProfile(now)
  return {
    schemaVersion: QUIRKY_PROFILE_INDEX_SCHEMA_VERSION,
    activeProfileId: profile.id,
    profiles: [profile]
  }
}

export function loadOrCreateProfileIndex(userDataPath: string): QuirkyProfileIndex {
  const indexPath = getQuirkyProfileIndexPath(userDataPath)
  const index = readExistingProfileIndex(indexPath)
  if (index) {
    return index
  }
  const nextIndex = createInitialProfileIndex()
  writeProfileIndex(indexPath, nextIndex)
  return nextIndex
}

function getActiveProfile(index: QuirkyProfileIndex): QuirkyProfileSummary {
  return (
    index.profiles.find((profile) => profile.id === index.activeProfileId) ??
    index.profiles[0] ??
    createDefaultLocalQuirkyProfile(Date.now())
  )
}

export function ensureActiveQuirkyProfile(
  userDataPath = getProfileUserDataPath()
): ActiveQuirkyProfileState {
  const indexPath = getQuirkyProfileIndexPath(userDataPath)
  let index = readExistingProfileIndex(indexPath)
  let shouldWriteIndex = !existsSync(indexPath)

  if (!index) {
    index = createInitialProfileIndex()
    shouldWriteIndex = true
  }

  const activeProfile = getActiveProfile(index)
  if (activeProfile.id !== index.activeProfileId) {
    index = { ...index, activeProfileId: activeProfile.id }
    shouldWriteIndex = true
  }

  const profileDirectory = getQuirkyProfileDirectory(activeProfile.id, userDataPath)
  mkdirSync(profileDirectory, { recursive: true })
  const profileDatabaseFile = getQuirkyProfileStateDatabaseFile(activeProfile.id, userDataPath)
  const profileDataFile = getQuirkyProfileDataFile(activeProfile.id, userDataPath)
  let hasRetainedProfileStateAuthority = false
  try {
    hasRetainedProfileStateAuthority =
      hasProfileStateAuthorityMarker(profileDatabaseFile) ||
      profileStateJsonExportPaths(profileDataFile).length > 0 ||
      profileStateDatabaseBackups(profileDatabaseFile).length > 0
  } catch {
    // An unreadable profile directory must never trigger a fallback copy of legacy state.
    hasRetainedProfileStateAuthority = true
  }
  if (
    activeProfile.id === DEFAULT_LOCAL_QUIRKY_PROFILE_ID &&
    !hasQuirkyProfileStateDatabase(activeProfile.id, userDataPath) &&
    !hasRetainedProfileStateAuthority
  ) {
    copyLegacyStateToProfile(userDataPath, activeProfile.id)
  }

  if (shouldWriteIndex) {
    writeProfileIndex(indexPath, index)
  }

  return {
    index,
    profile: activeProfile,
    dataFile: profileDataFile,
    stateDatabaseFile: profileDatabaseFile,
    profileDirectory
  }
}

export function isDefaultLocalQuirkyProfileId(profileId: string): boolean {
  return profileId === DEFAULT_LOCAL_QUIRKY_PROFILE_ID
}

export function getQuirkyProfileListState(
  userDataPath = getProfileUserDataPath()
): QuirkyProfileListState {
  const { index } = ensureActiveQuirkyProfile(userDataPath)
  return {
    activeProfileId: index.activeProfileId,
    profiles: index.profiles
  }
}

export function createLocalQuirkyProfile(
  args: CreateLocalQuirkyProfileArgs = {},
  userDataPath = getProfileUserDataPath()
): CreateLocalQuirkyProfileResult {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  const name = sanitizeProfileName(args.name)
  const profile: QuirkyProfileSummary = {
    id: `local-${randomUUID()}`,
    name,
    avatar: {
      kind: 'initials',
      initials: (
        name.match(/[A-Za-z0-9]/)?.[0] ?? DEFAULT_LOCAL_QUIRKY_PROFILE_NAME[0]
      ).toUpperCase(),
      color: 'neutral'
    },
    kind: 'local',
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now
  }
  const nextIndex: QuirkyProfileIndex = {
    ...index,
    profiles: [...index.profiles, profile]
  }
  mkdirSync(getQuirkyProfileDirectory(profile.id, userDataPath), { recursive: true })
  writeProfileIndex(getQuirkyProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles,
    profile
  }
}

export function setActiveQuirkyProfile(
  profileId: string,
  userDataPath = getProfileUserDataPath()
): QuirkyProfileListState {
  const index = loadOrCreateProfileIndex(userDataPath)
  const now = Date.now()
  let found = false
  const profiles = index.profiles.map((profile) => {
    if (profile.id !== profileId) {
      return profile
    }
    found = true
    return {
      ...profile,
      updatedAt: now,
      lastOpenedAt: now
    }
  })
  if (!found) {
    throw new Error('unknown_quirky_profile')
  }
  const nextIndex: QuirkyProfileIndex = {
    ...index,
    activeProfileId: profileId,
    profiles
  }
  mkdirSync(getQuirkyProfileDirectory(profileId, userDataPath), { recursive: true })
  writeProfileIndex(getQuirkyProfileIndexPath(userDataPath), nextIndex)
  return {
    activeProfileId: nextIndex.activeProfileId,
    profiles: nextIndex.profiles
  }
}
