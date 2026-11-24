import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../../shared/worktree/types'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = []
let settings: Partial<GlobalSettings> | null = null
const WORKTREE_CARD_IMPORT_TIMEOUT_MS = 15_000

vi.mock('@/store', () => {
  const getState = () => ({
    deleteStateByWorktreeId: {},
    fetchHostedReviewForBranch,
    fetchIssue,
    fetchLinearIssue,
    gitConflictOperationByWorktree: {},
    hostedReviewCache: {},
    issueCache: {},
    linearIssueCache: {},
    openModal,
    projectGroups: [],
    remoteBranchConflictByWorktreeId: {},
    settings,
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    updateWorktreeMeta,
    workspacePortScan: null,
    worktreeCardProperties
  })
  return {
    useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState,
      subscribe: () => () => {}
    })
  }
})

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('../use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'idle'
}))

vi.mock('../use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))

vi.mock('../CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('../WorktreeCardAgents', () => ({
  default: () => null
}))

vi.mock('../SshDisconnectedDialog', () => ({
  SshDisconnectedDialog: () => null
}))

vi.mock('../WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'quirky:test-close-context-menus',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-quirky-context-menu-scope'
}))

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'quirky',
    badgeColor: '#999999',
    repoIcon: { type: 'emoji', emoji: '🦊' },
    addedAt: 1,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/grouped',
    repoId: 'repo-1',
    path: '/repo/worktrees/grouped',
    displayName: 'Grouped tree',
    branch: 'feature/grouped',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

describe('WorktreeCard origin repo chip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = []
    settings = null
  })

  it(
    'shows the origin chip for a worktree rendered loose in a project group',
    async () => {
      const { default: WorktreeCard } = await import('../WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={makeRepo()}
          isActive={false}
          inProjectGroupLooseSection
          // grouping by repo hides the normal badge; a group-detached row still needs its origin
          hideRepoBadge
        />
      )

      expect(markup).toContain('🦊')
      expect(markup).toContain('Project quirky')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'renders no origin chip for a row that still sits under its own repo header',
    async () => {
      const { default: WorktreeCard } = await import('../WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} hideRepoBadge />
      )

      expect(markup).not.toContain('🦊')
      expect(markup).not.toContain('Project quirky')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'keeps the origin chip in the title row for the new card style',
    async () => {
      settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: true }
      worktreeCardProperties = ['status']
      const { default: WorktreeCard } = await import('../WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={makeRepo()}
          isActive={false}
          inProjectGroupLooseSection
          hideRepoBadge
        />
      )

      expect(markup).toContain('🦊')
      expect(markup).toContain('Project quirky')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'keeps the origin chip in the title row for legacy detailed cards',
    async () => {
      settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: false }
      const { default: WorktreeCard } = await import('../WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={makeRepo()}
          isActive={false}
          inProjectGroupLooseSection
          hideRepoBadge
        />
      )

      expect(markup).toContain('🦊')
      expect(markup).toContain('Project quirky')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )

  it(
    'renders no origin chip when the row has no repo to name',
    async () => {
      const { default: WorktreeCard } = await import('../WorktreeCard')

      const markup = renderToStaticMarkup(
        <WorktreeCard
          worktree={makeWorktree()}
          repo={undefined}
          isActive={false}
          inProjectGroupLooseSection
          hideRepoBadge
        />
      )

      expect(markup).not.toContain('Project quirky')
    },
    WORKTREE_CARD_IMPORT_TIMEOUT_MS
  )
})
