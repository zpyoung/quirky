import {
  getRegisteredSshState,
  listRegisteredSshTargets
} from '../../ssh/targets/ssh-target-registry'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import type { DesktopSidebarFacts } from '../../../shared/sidebar-list/desktop-sidebar-facts'
import type { RuntimeStore } from '../runtime-store-contract'
import type { OrcaRuntimeWithSidebarTemporal } from './orca-runtime-sidebar-temporal'
import type { WorkspaceCreationRegistry } from './workspace-creation-registry'
import type { WorkspaceRowsProducer } from './workspace-rows-producer'
import type { RepoIconDataUrls } from './repo-icon-data-urls'
import type { SidebarInputsFeedDomain } from './sidebar-inputs-feed'
import { readDesktopSidebarFacts } from './desktop-sidebar-facts'
import { readSidebarProjectCatalog } from './sidebar-project-catalog'

/** This host's store and connection registries, read the way sidebarInputs.desktopFacts reads them. */
export function readRuntimeDesktopSidebarFacts(store: RuntimeStore): DesktopSidebarFacts {
  return readDesktopSidebarFacts({
    store,
    sshTargets: listRegisteredSshTargets(),
    sshStateOf: getRegisteredSshState,
    wslStatuses: []
  })
}

// The bus every catalog, view and SSH change reaches clients through.
const CATALOG_EVENTS = new Set<RuntimeClientEvent['type']>([
  'worktreesChanged',
  'reposChanged',
  'workspaceViewChanged',
  'sshStateChanged'
])

export type SidebarInputsFeedSources = {
  facts: OrcaRuntimeWithSidebarTemporal
  workspaceCreations: WorkspaceCreationRegistry
  workspaceRows: WorkspaceRowsProducer
  repoIcons: Pick<RepoIconDataUrls, 'idsByRepo'>
  store: () => RuntimeStore | null
  onClientEvent: (
    listener: (event: RuntimeClientEvent) => void,
    options: { consumesTerminalSideEffects: false }
  ) => () => void
}

/** Every merged producer's snapshot, keyed per entity: a change re-sends only what it touched. */
export function sidebarInputsFeedDomains(
  sources: SidebarInputsFeedSources
): SidebarInputsFeedDomain[] {
  const { facts, workspaceCreations, workspaceRows } = sources
  const watchCatalog = (changed: () => void): (() => void) =>
    sources.onClientEvent(
      (event) => {
        if (CATALOG_EVENTS.has(event.type)) {
          changed()
        }
      },
      { consumesTerminalSideEffects: false }
    )
  const requireStore = (): RuntimeStore => {
    const store = sources.store()
    if (!store) {
      throw new Error('no store')
    }
    return store
  }
  return [
    {
      name: 'activity',
      read: () => facts.getWorkspaceActivityFacts().facts,
      watch: (changed) => facts.workspaceActivityFacts.revision.onChange(changed)
    },
    {
      name: 'temporal',
      read: () => {
        const { sessionId, retention } = facts.getSidebarTemporalSnapshot()
        return { sessionId, retention }
      },
      watch: (changed) => facts.onSidebarTemporalChange(changed)
    },
    {
      name: 'creations',
      read: () => workspaceCreations.snapshot().creations,
      watch: (changed) => workspaceCreations.revision.onChange(changed)
    },
    {
      name: 'workspaces',
      read: async () => (await workspaceRows.snapshot()).rows,
      watch: (changed) => workspaceRows.revision.onChange(changed)
    },
    {
      name: 'pairedServerHosts',
      read: () => ({}),
      watch: () => () => {}
    },
    {
      name: 'pairedServerRows',
      read: () => ({}),
      watch: () => () => {}
    },
    {
      name: 'desktop',
      // Each field its own entity; the WSL registry announces no change.
      read: () => readRuntimeDesktopSidebarFacts(requireStore()),
      watch: (changed) => {
        const store = sources.store()
        const detaches = [
          watchCatalog(changed),
          store?.onUIChanged?.(changed),
          store?.onWorkspaceSessionWritten?.(changed),
          store?.onSettingsChanged?.(changed)
        ]
        return () => detaches.forEach((detach) => detach?.())
      },
      rereadOnRead: true
    },
    {
      // Each field its own entity, so a reader holds the catalog only once it is whole.
      name: 'projectCatalog',
      read: () => readSidebarProjectCatalog(requireStore(), []),
      watch: (changed) => {
        const detaches = [
          watchCatalog(changed),
          // Manual repo order and project order live in the UI state.
          sources.store()?.onUIChanged?.(changed),
          // Catalog writes are full saves, and some (a project rename) announce no event.
          sources.store()?.onStateWritten?.((domains) => {
            if (domains === undefined) {
              changed()
            }
          })
        ]
        return () => detaches.forEach((detach) => detach?.())
      }
    },
    {
      // Ids only: a reader fetches the images through sidebarInputs.repoIcons.
      name: 'repoIcons',
      read: () => sources.repoIcons.idsByRepo(),
      watch: watchCatalog
    },
    {
      name: 'review',
      read: async () => (await facts.getWorkspaceReviewFacts()).facts,
      // The window's PR cache saves announce no change.
      watch: watchCatalog,
      rereadOnRead: true
    }
  ]
}
