/** Arbitrary URLs are references, not trusted provider data or launch commands. */
export type WorktreeReference = { id: string; url: string; label: string; createdAt: number }
export type ExternalVisibility = 'show' | 'hide' | 'inherit'
export type WorktreeStatusDefinition = { id: string; label: string; color: string }
export type WorktreeProjectIdentity = {
  displayName: string | null
  icon: string | null
  color: string | null
  trackerProject: string | null
}

/** Unknown remote/liveness evidence blocks destructive cleanup rather than proving inactivity. */
export type WorktreeCleanupContext = {
  archivedAt: number | null
  volatile: boolean | null
  remoteConnected: boolean | null
}
