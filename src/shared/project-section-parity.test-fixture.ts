// Host answers both the desktop sidebar's and the phone's Project grouping tests run on.
import type { MobileProjectSectionCatalog } from './mobile-project-sections-contract'
import type { ExecutionHostId } from './execution-host'
import {
  projectHostSetupProjectionFromRepos,
  type ProjectHostSetupProjection
} from './project-host-setup-projection'
import type { Repo } from './repo-types'
import type { RuntimeClientTarget } from './runtime-client-target'

const quirkyRemote = {
  canonicalKey: 'github.com/stablyai/orca',
  remoteName: 'origin',
  remoteUrl: 'git@github.com:stablyai/orca.git'
}

function hostRepo(id: string, path: string, displayName = 'quirky'): Repo {
  return {
    id,
    path,
    displayName,
    badgeColor: '#737373',
    addedAt: 1,
    ...(displayName === 'quirky' ? { gitRemoteIdentity: quirkyRemote } : {})
  }
}

export type ParityHostAnswer = {
  target: RuntimeClientTarget
  hostId: ExecutionHostId
  /** In the host's own repo.list order. */
  repos: Repo[]
  /** The host's project.list/projectHostSetup.list rows; null for a host that predates them. */
  lists: ProjectHostSetupProjection | null
}

const localRepos = [
  hostRepo('local-stably', '/Users/jinwoo/stably/quirky'),
  hostRepo('local-assets', '/Users/jinwoo/design-assets', 'design-assets'),
  hostRepo('local-workspace', '/Users/jinwoo/quirky/workspaces/quirky/quirky')
]
const windowsRepo = hostRepo('win-quirky', 'C:/Users/jinwo/quirky/quirky')

// Jinwoo's shape: several local checkouts of stablyai/orca, plus the project on two servers.
export const PROJECT_SECTION_PARITY_HOSTS: readonly ParityHostAnswer[] = [
  {
    target: { kind: 'local' },
    hostId: 'local',
    repos: localRepos,
    lists: projectHostSetupProjectionFromRepos(localRepos)
  },
  {
    target: { kind: 'environment', environmentId: 'windows2' },
    hostId: 'runtime:windows2',
    repos: [windowsRepo],
    // A server's own catalog rows: its project name and an imported setup on its local host.
    lists: {
      projects: [
        {
          id: 'github:stablyai/orca',
          displayName: 'Quirky',
          badgeColor: '#737373',
          providerIdentity: { provider: 'github', owner: 'stablyai', repo: 'quirky' },
          sourceRepoIds: [windowsRepo.id],
          createdAt: 5,
          updatedAt: 5
        }
      ],
      setups: [
        {
          id: 'win-setup',
          projectId: 'github:stablyai/orca',
          hostId: 'local',
          repoId: windowsRepo.id,
          path: windowsRepo.path,
          displayName: 'quirky',
          setupState: 'ready',
          setupMethod: 'imported-existing-folder',
          createdAt: 5,
          updatedAt: 5
        }
      ]
    }
  },
  {
    target: { kind: 'environment', environmentId: 'm4air' },
    hostId: 'runtime:m4air',
    repos: [
      hostRepo('m4-quirky', '/Users/m4air/quirky/quirky'),
      hostRepo('m4-quirky-two', '/Users/m4air/quirky-two/quirky')
    ],
    lists: null
  }
]

/** Workspace rows; activity order differs from catalog order, so Recent and Manual disagree. */
export const PROJECT_SECTION_PARITY_ROWS: readonly {
  id: string
  repoId: string
  lastActivityAt: number
}[] = [
  { id: 'wt-m4-two', repoId: 'm4-quirky-two', lastActivityAt: 90 },
  { id: 'wt-win', repoId: 'win-quirky', lastActivityAt: 70 },
  { id: 'wt-workspace', repoId: 'local-workspace', lastActivityAt: 50 },
  { id: 'wt-stably', repoId: 'local-stably', lastActivityAt: 30 },
  { id: 'wt-m4', repoId: 'm4-quirky', lastActivityAt: 10 }
]

// Same-host checkouts still need path prefixes; other machines do not.
const STABLY = {
  key: 'project:github:stablyai/orca::setup:local-stably',
  label: 'stably/quirky'
}
const WORKSPACE = {
  key: 'project:github:stablyai/orca::setup:local-workspace',
  label: 'quirky/quirky'
}
// Why 'quirky', not the server's 'Quirky': the later host's derived project name wins the merge.
const WINDOWS = { key: 'project:github:stablyai/orca', label: 'quirky' }
const M4 = { key: 'project:github:stablyai/orca::setup:m4-quirky', label: 'quirky/quirky' }
const M4_TWO = {
  key: 'project:github:stablyai/orca::setup:m4-quirky-two',
  label: 'quirky-two/quirky'
}
const ASSETS = { key: 'project:repo:local-assets', label: 'design-assets' }

export const PROJECT_SECTION_PARITY_HEADERS = {
  recent: [M4_TWO, WINDOWS, WORKSPACE, STABLY, M4, ASSETS],
  manual: [STABLY, ASSETS, WORKSPACE, WINDOWS, M4, M4_TWO]
} as const

/** What main serves the phone for these answers (the renderer's published catalog). */
export const PROJECT_SECTION_PARITY_SERVED: MobileProjectSectionCatalog = {
  repos: [
    {
      id: 'local-stably',
      displayName: 'quirky',
      path: '/Users/jinwoo/stably/quirky',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'local-assets',
      displayName: 'design-assets',
      path: '/Users/jinwoo/design-assets',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'local-workspace',
      displayName: 'quirky',
      path: '/Users/jinwoo/quirky/workspaces/quirky/quirky',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'local'
    },
    {
      id: 'win-quirky',
      displayName: 'quirky',
      path: 'C:/Users/jinwo/quirky/quirky',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'runtime:windows2'
    },
    {
      id: 'm4-quirky',
      displayName: 'quirky',
      path: '/Users/m4air/quirky/quirky',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'runtime:m4air'
    },
    {
      id: 'm4-quirky-two',
      displayName: 'quirky',
      path: '/Users/m4air/quirky-two/quirky',
      badgeColor: '#737373',
      addedAt: 1,
      executionHostId: 'runtime:m4air'
    }
  ],
  projects: [
    { id: 'repo:local-assets', displayName: 'design-assets' },
    { id: 'github:stablyai/orca', displayName: 'quirky' }
  ],
  setups: [
    {
      id: 'local-stably',
      projectId: 'github:stablyai/orca',
      hostId: 'local',
      repoId: 'local-stably',
      path: '/Users/jinwoo/stably/quirky',
      displayName: 'quirky',
      setupMethod: 'legacy-repo'
    },
    {
      id: 'local-assets',
      projectId: 'repo:local-assets',
      hostId: 'local',
      repoId: 'local-assets',
      path: '/Users/jinwoo/design-assets',
      displayName: 'design-assets',
      setupMethod: 'legacy-repo'
    },
    {
      id: 'local-workspace',
      projectId: 'github:stablyai/orca',
      hostId: 'local',
      repoId: 'local-workspace',
      path: '/Users/jinwoo/quirky/workspaces/quirky/quirky',
      displayName: 'quirky',
      setupMethod: 'legacy-repo'
    },
    {
      id: 'win-setup',
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:windows2',
      repoId: 'win-quirky',
      path: 'C:/Users/jinwo/quirky/quirky',
      displayName: 'quirky',
      setupMethod: 'imported-existing-folder',
      connectionId: null,
      executionHostId: 'runtime:windows2'
    },
    {
      id: 'm4-quirky',
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:m4air',
      repoId: 'm4-quirky',
      path: '/Users/m4air/quirky/quirky',
      displayName: 'quirky',
      setupMethod: 'legacy-repo',
      executionHostId: 'runtime:m4air'
    },
    {
      id: 'm4-quirky-two',
      projectId: 'github:stablyai/orca',
      hostId: 'runtime:m4air',
      repoId: 'm4-quirky-two',
      path: '/Users/m4air/quirky-two/quirky',
      displayName: 'quirky',
      setupMethod: 'legacy-repo',
      executionHostId: 'runtime:m4air'
    }
  ],
  projectOrderBy: 'manual'
}
