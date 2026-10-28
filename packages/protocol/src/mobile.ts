/** Safe desktop identity readable by paired phones without exposing pairing administration. */
export type MobileHostInfo = {
  machineName: string
  platform: string
  deviceScope: 'mobile'
}

/** Public, non-secret projection of a durably paired phone. Pending offers are not listed. */
export type MobileDevice = {
  deviceId: string
  name: string
  pairedAt: number
  lastSeenAt: number
}

export type MobileNetworkInterface = {
  name: string
  address: string
  family: 'IPv4' | 'IPv6'
  kind: 'tailscale' | 'lan' | 'virtual'
}

/** Quirky pairing is direct-only; the mobile app uses Quirky JSON-RPC, not Orca RPC. */
export type MobilePairingOffer = {
  v: 2
  endpoint: string
  deviceToken: string
  publicKeyB64: string
  pairedDeviceId: string
  scope: 'mobile'
}

export type MobilePairingResult =
  | {
      available: true
      pairingUrl: string
      endpoint: string
      deviceId: string
      connectionMode: 'local-only'
      qrDataUrl: string | null
      qrSize: number | null
      qrError?: 'encoding_failed'
    }
  | {
      available: false
      reason: 'invalid_advertised_endpoint' | 'network_exposure_failed' | 'device_registry_unavailable' | 'e2ee_key_unavailable' | 'websocket_unavailable'
      guidance: string
    }

export type MobileState = {
  machineName: string
  showMobileButton: boolean
  onboardingSeen: boolean
  autoRestoreFitMs: number | null
  customAddresses: string[]
  interfaces: MobileNetworkInterface[]
  devices: MobileDevice[]
  listener: { available: boolean; host: string | null; port: number | null }
  relay: 'unavailable'
}

/** Daemon-owned terminal ownership. Viewport dimensions are PTY cells, not pixels. */
export type MobileTerminalState = {
  session: string
  driver: { deviceId: string; connectionId: number; name: string } | null
  phoneFit: boolean
  cols: number
  rows: number
  desktopCols: number | null
  desktopRows: number | null
}

/** Page-delivery DTOs shared by the mobile plugin and the Expo companion. */
export type MobilePageGrant = 'rpc' | 'terminal' | 'storage' | 'navigate' | 'clipboard.read' | 'clipboard.write' | 'externalLink' | 'haptics'
export type MobileBundleAsset = { path: string; bytes: number; sha256: string; contentType: string }
export type MobileBundleRoute = { kind: 'workspaces' | 'session' | 'source-control' | 'review' | 'files' | 'file-preview' | 'terminal-artifacts' | 'terminal-artifact' | 'tasks' | 'accounts' | 'agent-history' | 'notifications'; path: string; grants: MobilePageGrant[] }
export type MobileBundleManifest = {
  v: 1
  shellVersion: 1
  buildId: string
  assets: MobileBundleAsset[]
  totalBytes: number
  routes: MobileBundleRoute[]
}
export type MobileBundleManifestResult = { manifest: MobileBundleManifest; chunkBytes: number; rangeBytes: number }
export type MobileBundleReadResult = { buildId: string; path: string; offset: number; data: string; encoding: 'identity' | 'gzip'; eof: boolean; sha256: string }

/** Panel additions to the single mobile admission policy; native pages never grant arbitrary RPC. */
export const PANEL_METHOD_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'quirky.terminal/artifacts': ['action', 'worktree', 'session', 'artifactId', 'grant', 'expectedRevision', 'content'],
  'quirky.git/status': ['worktree'],
  'quirky.git/diff': ['worktree', 'path', 'staged', 'source', 'oldPath', 'mergeBase', 'head', 'commit', 'parent'],
  'quirky.git/stage': ['worktree', 'paths', 'scope'],
  'quirky.git/unstage': ['worktree', 'paths'],
  'quirky.git/discard': ['worktree', 'paths', 'area', 'yes', 'confirmation'],
  'quirky.git/describeDiscard': ['worktree', 'paths', 'area'],
  'quirky.git/commit': ['worktree', 'message'],
  'quirky.git/generateCommitMessage': ['worktree'],
  'quirky.git/cancelGenerate': ['worktree'],
  'quirky.git/push': ['worktree'],
  'quirky.git/pull': ['worktree'],
  'quirky.git/sync': ['worktree'],
  'quirky.git/fetch': ['worktree'],
  'quirky.git/fastForward': ['worktree'],
  'quirky.git/forcePush': ['worktree', 'expected', 'yes', 'confirmation'],
  'quirky.git/describeForcePush': ['worktree', 'expected'],
  'quirky.git/branches': ['worktree', 'query'],
  'quirky.git/switchBranch': ['worktree', 'branch', 'expectedBranch', 'expectedHead', 'yes', 'confirmation'],
  'quirky.git/describeSwitchBranch': ['worktree', 'branch', 'expectedBranch', 'expectedHead'],
  'quirky.git/continue': ['worktree'],
  'quirky.git/abort': ['worktree', 'yes', 'confirmation'],
  'quirky.git/describeAbort': ['worktree'],
  'quirky.git/compare': ['worktree', 'base'],
  'quirky.git/history': ['worktree', 'limit'],
  'quirky.git/commitFiles': ['worktree', 'commit'],
  'quirky.git/conflictFile': ['worktree', 'path', 'peek'],
  'quirky.git/notes': ['worktree', 'path'],
  'quirky.git/addNote': ['worktree', 'path', 'line', 'startLine', 'body'],
  'quirky.git/editNote': ['worktree', 'id', 'body'],
  'quirky.git/deleteNote': ['worktree', 'id'],
  'quirky.git/formatNotes': ['worktree', 'ids', 'path'],
  'quirky.git/noteTargets': ['worktree'],
  'quirky.git/sendNotes': ['worktree', 'scope', 'id', 'path', 'session', 'agent'],
  'quirky.hosting/forBranch': ['worktree', 'branch', 'headOid', 'number', 'fallbackPRNumber', 'prRepo'],
  'quirky.hosting/review': ['worktree', 'number', 'prRepo'],
  'quirky.hosting/creationEligibility': ['worktree', 'base', 'head', 'title'],
  'quirky.hosting/create': ['worktree', 'base', 'head', 'title', 'body', 'draft', 'useTemplate'],
  'quirky.hosting/workItemDetails': ['worktree', 'number', 'kind', 'reference', 'noCache'],
  'quirky.hosting/updateReview': ['worktree', 'number', 'prRepo', 'action', 'title', 'body'],
  'quirky.hosting/reviewers': ['worktree', 'number', 'prRepo', 'action', 'logins'],
  'quirky.hosting/reviewAssignees': ['worktree', 'number', 'prRepo', 'action', 'logins'],
  'quirky.hosting/reviewConversation': ['worktree', 'number', 'prRepo', 'action', 'body'],
  'quirky.reviews/checksLink': ['worktree', 'number'],
  'quirky.editor/explorer': ['worktree', 'action', 'path'],
  'quirky.editor/open': ['worktree', 'path', 'preview', 'pinned', 'focus', 'mode'],
  'quirky.editor/read': ['bufferId', 'action', 'kind', 'offset', 'length', 'contentRevision'],
  'quirky.editor/viewer': ['bufferId', 'action'],
  'quirky.editor/draft': ['bufferId', 'content', 'expectedRevision'],
  'quirky.editor/transfer': ['action', 'kind', 'bufferId', 'expectedRevision', 'totalBytes', 'transferId', 'offset', 'data'],
  'quirky.editor/save': ['bufferId', 'trigger'],
  'quirky.tasks/state': ['worktree'],
  'quirky.tasks/repositories': ['worktree'],
  'quirky.tasks/list': ['worktree', 'mode', 'repoIds', 'query', 'page', 'refresh'],
  'quirky.tasks/navigate': ['worktree', 'source', 'mode', 'detail'],
  'quirky.tasks/issue': ['worktree', 'number', 'url', 'projectId', 'itemId', 'host', 'owner', 'repo', 'refresh'],
  'quirky.tasks/issueEdit': ['worktree', 'number', 'url', 'projectId', 'itemId', 'host', 'owner', 'repo', 'title', 'body', 'state', 'stateReason', 'duplicateOf', 'labels', 'assignees'],
  'quirky.tasks/issueComment': ['worktree', 'number', 'url', 'projectId', 'itemId', 'host', 'owner', 'repo', 'body'],
  'quirky.tasks/workspace': ['target', 'action', 'newWorkspace', 'name', 'prompt', 'setup', 'agent', 'composerRequestId', 'trustSetup'],
  'quirky.tasks/workspaceComposerCancel': ['requestId'],
  'quirky.accounts/list': ['provider'],
  'quirky.accounts/usage': [],
  'quirky.accounts/inactiveUsage': ['provider'],
  'quirky.accounts/refresh': ['provider', 'force'],
  'quirky.accounts/select': ['provider', 'accountId'],
  'quirky.vault/list': ['host', 'limit', 'sort', 'force', 'within'],
  'quirky.vault/search': ['host', 'query', 'scope', 'freshness', 'limit', 'filters', 'cursor', 'within'],
  'quirky.vault/resume': ['id']
}
