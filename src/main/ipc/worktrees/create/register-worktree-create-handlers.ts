import { ipcMain, app } from 'electron'
import { getLocalWorktreeCatalogVersion } from '../../../local-worktree-scan-generation'
import type {
  CreateWorktreeArgs,
  CreateWorktreeResult,
  AdoptProvisionedRootArgs
} from '../../../../shared/worktree/create-types'
import {
  addWorktreeCreatePhaseAttributes,
  withWorktreeSpan
} from '../../../observability/instrumentation'
import {
  resolveAutomationWorkspaceProvenance,
  releaseAutomationWorkspaceProvenanceRequest,
  finishAutomationWorkspaceProvenanceRequest
} from '../../../automations/workspace-provenance'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { createLocalWorktree, notifyWorktreesChanged } from '../../worktree-remote'
import { SshHostNotServedError } from '../../../providers/ssh-host-not-served-error'
import { adoptProvisionedRootSshCheckout } from '../../../provisioned-root-ssh-adoption'
import { normalizeLinkedWorkItemFields } from '../ipc-context-schemas'
import type { CreateWorktreeArgsWithSystemProvenance } from '../ipc-context-schemas'
import { createFolderWorkspace } from './folder-workspace-creation'
import { findExactRepoOwner, isCapturedRepoCurrent } from '../listing/worktree-host-ownership'
import { requireWorktreeCreateRoute } from '../../../worktree-create-execution-host-route'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { assertWslMoveRepoWritable } from '../../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import {
  beginWorkspaceCreateSession,
  type WorkspaceCreateSession
} from '../../../workspace-create-session'

export function registerWorktreeCreateHandlers(context: WorktreeIpcContext): void {
  const { mainWindow, store, runtime, options } = context

  ipcMain.handle(
    'worktrees:create',
    async (_event, rawArgs: CreateWorktreeArgs): Promise<CreateWorktreeResult> => {
      const args = normalizeLinkedWorkItemFields(rawArgs)
      // Why span here: parent the child git spans for the trace tree; don't attach branch name/remote URL (user content) — repo ID is the safer correlator.
      return withWorktreeSpan({ stage: 'create' }, async (span) => {
        const repo = store.getRepo(args.repoId)
        if (!repo) {
          throw new Error(`Repo not found: ${args.repoId}`)
        }
        assertWslMoveRepoWritable(store, repo)

        const automationProvenance = resolveAutomationWorkspaceProvenance({
          authority: runtime,
          repoSelector: args.repoId,
          repo,
          request: args.automationProvenanceRequest
        })
        const createArgs: CreateWorktreeArgsWithSystemProvenance = {
          ...args,
          automationProvenance
        }

        let result: CreateWorktreeResult
        let session: WorkspaceCreateSession | null = null
        const creation = runtime.workspaceCreations?.open({
          creationId: args.creationId,
          repoId: repo.id
        })
        try {
          // Why: wrap only the helpers; the pre-validation throws above are IPC-shape bugs, not the git/filesystem failures the funnel tracks.
          if (isFolderRepo(repo)) {
            // A folder workspace is a registration, not a filesystem create, so it is host-agnostic.
            result = createFolderWorkspace(createArgs, repo, store)
          } else {
            // Resolve the host rather than reading the raw field: an `executionHostId: 'ssh:*'`-only
            // row read as local here and ran `git worktree add` on the client against a remote path,
            // while the runtime sibling on the same repo already resolved.
            session = beginWorkspaceCreateSession()
            const createRoute = requireWorktreeCreateRoute(repo)
            if (createRoute.kind === 'ssh') {
              session.timing.recordExecutionHost('ssh')
              throw new SshHostNotServedError(createRoute.connectionId)
            }
            result = await createLocalWorktree(
              createArgs,
              repo,
              store,
              mainWindow,
              runtime,
              session.timing,
              creation?.named
            )
          }
        } catch (error) {
          releaseAutomationWorkspaceProvenanceRequest(args.automationProvenanceRequest)
          throw error
        } finally {
          session?.end()
          creation?.close()
        }
        finishAutomationWorkspaceProvenanceRequest(args.automationProvenanceRequest)
        if (result.timing) {
          addWorktreeCreatePhaseAttributes(span, result.timing)
        }

        if (isFolderRepo(repo)) {
          notifyWorktreesChanged(mainWindow, repo.id)
        }

        options?.onWorktreeLifecycle?.({
          kind: 'created',
          worktreeId: result.worktree.id,
          path: result.worktree.path,
          branch: result.worktree.branch
        })

        // Why stamped last: the create's own change notification bumped the generation, so this
        // names the catalog that contains the new worktree.
        return { ...result, catalogVersion: getLocalWorktreeCatalogVersion(repo.id) }
      })
    }
  )

  ipcMain.handle(
    'worktrees:adoptProvisionedRoot',
    async (_event, rawArgs: AdoptProvisionedRootArgs): Promise<CreateWorktreeResult> => {
      const args = normalizeLinkedWorkItemFields(rawArgs)
      return withWorktreeSpan({ stage: 'create' }, async () => {
        const repo = findExactRepoOwner(store, args.repoId, args.executionHostId)
        if (!repo || isFolderRepo(repo)) {
          throw new Error('Provisioned-root repository ownership is missing or ambiguous.')
        }
        assertWslMoveRepoWritable(store, repo)
        const automationProvenance = resolveAutomationWorkspaceProvenance({
          authority: runtime,
          repoSelector: args.repoId,
          repo,
          request: args.automationProvenanceRequest
        })
        let result: CreateWorktreeResult
        try {
          result = await adoptProvisionedRootSshCheckout({
            userDataPath: app.getPath('userData'),
            request: { ...args, automationProvenance },
            repo,
            store,
            isRepoCurrent: () => isCapturedRepoCurrent(store, repo, args.executionHostId)
          })
        } catch (error) {
          releaseAutomationWorkspaceProvenanceRequest(args.automationProvenanceRequest)
          throw error
        }
        finishAutomationWorkspaceProvenanceRequest(args.automationProvenanceRequest)
        notifyWorktreesChanged(mainWindow, repo.id)
        options?.onWorktreeLifecycle?.({
          kind: 'created',
          worktreeId: result.worktree.id,
          path: result.worktree.path,
          branch: result.worktree.branch
        })
        return { ...result, catalogVersion: getLocalWorktreeCatalogVersion(repo.id) }
      })
    }
  )
}
