import {
  LOCAL_EXECUTION_HOST_ID,
  getRepoRoutingConnectionId,
  parseExecutionHostId
} from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { agentHookServer } from '../agent-hooks/server'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import type { Store } from '../persistence'
import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { bindLoopService } from '../runtime/rpc/methods/fork-loops/service-binding'
import { parseWslPath } from '../wsl'
import { resolveWorktreeHostRouting } from '../runtime/worktree-launch-host-repo'
import { mainProcessState } from '../startup/main-process-state'
import { createInputAttribution } from './input-attribution'
import { createIterationObserver } from './iteration-observer'
import { runLoopCheck } from './loop-check'
import { LoopDatabase, LoopStoreError } from './loop-database'
import { diffSnapshots, snapshotWorkingTree } from './loop-diff'
import type { LoopEvidenceTools, LoopTargets } from './loop-driver'
import { evaluateIteration } from './loop-evaluator'
import { forwardLoopChangesToRenderer } from './loop-ipc-forward'
import { createLocalLoopFilesystem } from './loop-notes-file'
import { notifyLoop } from './loop-notify'
import { LoopService } from './loop-service'
import { LoopStore } from './loop-store'
import {
  createLoopSessionTotalsReader,
  readUsageLimit,
  readUsageTotals,
  type LoopUsageDeps
} from './loop-usage'

type LoopTargetRuntime = {
  showManagedWorktree(
    selector: string
  ): Promise<{ repoId: string; path: string; hostId?: string | null }>
}

export async function resolveLoopTargets(
  runtime: LoopTargetRuntime,
  store: Pick<Store, 'getRepo' | 'getRepos'>,
  worktreeId: string
): Promise<LoopTargets> {
  const worktree = await runtime.showManagedWorktree(`id:${worktreeId}`)
  const repo = store.getRepo(worktree.repoId)
  const kind = repo && isFolderRepo(repo) ? 'folder' : 'git'
  const routing = resolveWorktreeHostRouting(store.getRepos(), worktree)
  const executionHostId = routing.kind === 'resolved' ? routing.hostId : LOCAL_EXECUTION_HOST_ID
  const host = parseExecutionHostId(executionHostId)
  const path: string = worktree.path
  if (!host || host.kind === 'runtime') {
    throw new LoopStoreError(
      'loop_check_unsupported_host',
      'Loops cannot run on a paired Quirky runtime host.'
    )
  }
  if (host.kind === 'local') {
    const wslDistro = parseWslPath(path)?.distro
    return {
      executionHostId,
      check: { type: 'local', cwd: path },
      workspace: {
        kind,
        workspacePath: path,
        pathFlavor: process.platform === 'win32' ? 'win32' : 'posix',
        fs: createLocalLoopFilesystem(),
        runGit:
          kind === 'git'
            ? (args, options) =>
                gitExecFileAsync(args, {
                  cwd: path,
                  ...(wslDistro ? { wslDistro } : {}),
                  ...(options?.env ? { env: { ...process.env, ...options.env } } : {})
                })
            : null
      }
    }
  }
  throw new SshHostNotServedError(host.targetId)
}

function createEvidenceTools(store: Store): LoopEvidenceTools {
  const usage: LoopUsageDeps = {
    isSshWorktree: (worktreeId) => {
      const repo = store.getRepo(getRepoIdFromWorktreeId(worktreeId))
      return repo ? getRepoRoutingConnectionId(repo) !== null : false
    },
    getProviderSessionIdentities: () => agentHookServer.getProviderSessionIdentities(),
    readSessionTotals: (args) =>
      createLoopSessionTotalsReader({
        claudeUsage: mainProcessState.claudeUsage,
        codexUsage: mainProcessState.codexUsage
      })(args)
  }
  return {
    snapshotTree: snapshotWorkingTree,
    diffTrees: diffSnapshots,
    runCheck: (config, target, signal) => runLoopCheck({ config }, target, undefined, signal),
    evaluate: evaluateIteration,
    readUsage: (paneKey, worktreeId, agent) => readUsageTotals(paneKey, worktreeId, agent, usage),
    readUsageLimit: (agent) =>
      readUsageLimit(agent, {
        getRateLimitState: () => {
          if (!mainProcessState.rateLimits) {
            throw new Error('Rate limits are not initialized')
          }
          return mainProcessState.rateLimits.getState()
        }
      })
  }
}

/** Builds the loop service for this runtime; the database opens on first use. */
export function startLoops(
  runtime: QuirkyRuntimeService,
  store: Store,
  isServeMode: boolean
): LoopService {
  const database = new LoopDatabase(() => store.getProfileStorageDirectory())
  const inputAttribution = createInputAttribution(runtime)
  const service = new LoopService({
    store: new LoopStore(database),
    runtime,
    driverDeps: {
      observer: createIterationObserver({ runtime, hookSource: agentHookServer, inputAttribution }),
      inputAttribution,
      tools: createEvidenceTools(store),
      targets: (worktreeId) => resolveLoopTargets(runtime, store, worktreeId)
    },
    notify: (loop, event, detail) => notifyLoop(store, loop, event, detail),
    closeDatabase: () => database.close()
  })
  bindLoopService(runtime, service)
  if (!isServeMode) {
    forwardLoopChangesToRenderer(service)
  }
  return service
}
