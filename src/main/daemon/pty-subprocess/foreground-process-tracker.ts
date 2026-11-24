import type * as pty from 'node-pty'
import { getAgentForegroundContextPaths } from '../../providers/agent-foreground-context-paths'
import { confirmPtyShellForeground } from './pty-shell-foreground-confirmation'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess,
  type RecognizedAgentProcess
} from '../../../shared/agent-process-recognition'
import { shouldInspectOuterWrapperForegroundProcess } from '../../../shared/foreground-wrapper-agent'
import { isShellProcess } from '../../../shared/shell-process-detection'
import { resolveFallbackForegroundProcess } from './foreground-fallback-process'
import { parsePtySessionId } from '../../../shared/pty-session-id-format'
import {
  ptyProcessNameIsSpawnFile,
  createPtyForegroundResolver,
  shouldCachePtyForeground
} from './spawn-file-foreground-process'

const FOREGROUND_AGENT_CACHE_TTL_MS = 1000
const SHELL_FOREGROUND_REFRESH_RETRY_MS = 5_000
const STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS = 5_000

type CachedAgentForeground = { processName: string; pid: number | null; refreshedAt: number }

export type PtyForegroundProcessTracker = {
  markDead(): void
  /** `rawFallback`: node-pty's own name only, with no identity cache and no background
   *  process-table refresh -- the cheap-tier tick must not fork a full `ps` as a side effect. */
  getForegroundProcess(options?: { rawFallback?: boolean }): string | null
  confirmForegroundProcess(): Promise<string | null>
  confirmShellForeground(): Promise<boolean>
}

export function createPtyForegroundProcessTracker(args: {
  process: pty.IPty
  shellPath: string
  cwd?: string
  sessionId: string
  startupAgentRecognition: RecognizedAgentProcess | null
  isDead: () => boolean
}): PtyForegroundProcessTracker {
  const proc = args.process
  const staticName = ptyProcessNameIsSpawnFile(proc)
  const resolveForeground = createPtyForegroundResolver(proc)
  // `pid` anchors the identity to the row that proved it (null when ambiguous).
  let cachedAgentForeground: CachedAgentForeground | null = null
  const contextPaths = getAgentForegroundContextPaths({
    cwd: args.cwd,
    worktreeId: parsePtySessionId(args.sessionId).worktreeId
  })
  let startupAgentForeground: { processName: string; expiresAt: number } | null =
    args.startupAgentRecognition
      ? {
          processName: args.startupAgentRecognition.processName,
          expiresAt: Date.now() + STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS
        }
      : null
  let foregroundRefreshInFlight = false
  let lastForegroundRefreshStartedAt = 0
  const getFallbackProcess = (): string | null =>
    resolveFallbackForegroundProcess(staticName ? args.shellPath : proc.process, args.shellPath)
  const getActiveStartupAgent = (
    now = Date.now()
  ): { processName: string; expiresAt: number } | null => {
    if (startupAgentForeground && now > startupAgentForeground.expiresAt) {
      startupAgentForeground = null
    }
    return startupAgentForeground
  }
  const shouldInspectFallback = (fallbackProcess: string | null): boolean =>
    fallbackProcess !== null

  const scheduleRefresh = (fallbackProcess: string | null): void => {
    if (args.isDead() || !proc.pid) {
      return
    }
    const fallbackIsShell = fallbackProcess !== null && isShellProcess(fallbackProcess)
    const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
    if (
      !fallbackProcess ||
      (fallbackRecognition !== null &&
        !shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) ||
      !shouldInspectFallback(fallbackProcess)
    ) {
      return
    }
    const now = Date.now()
    const idleNoEvidenceShell =
      fallbackIsShell && !getActiveStartupAgent(now) && !cachedAgentForeground
    const retryMs = idleNoEvidenceShell
      ? SHELL_FOREGROUND_REFRESH_RETRY_MS
      : FOREGROUND_AGENT_CACHE_TTL_MS
    if (foregroundRefreshInFlight || now - lastForegroundRefreshStartedAt < retryMs) {
      return
    }
    foregroundRefreshInFlight = true
    lastForegroundRefreshStartedAt = now
    const identityOlderThan = (ms: number): boolean =>
      cachedAgentForeground !== null && Date.now() - cachedAgentForeground.refreshedAt > ms
    const retireStaleForegroundIdentity = (): void => {
      const currentFallbackProcess = getFallbackProcess()
      if (
        fallbackIsShell &&
        !getActiveStartupAgent() &&
        currentFallbackProcess !== null &&
        isShellProcess(currentFallbackProcess)
      ) {
        cachedAgentForeground = null
        startupAgentForeground = null
      } else if (
        identityOlderThan(FOREGROUND_AGENT_CACHE_TTL_MS) &&
        currentFallbackProcess !== null &&
        isAgentForegroundWrapperProcess(currentFallbackProcess)
      ) {
        cachedAgentForeground = null
      }
    }
    void resolveForeground(proc.pid, fallbackProcess, { contextPaths })
      .then<string | void>(({ processName, processId, available }) => {
        if (args.isDead() || !available) {
          return
        }
        if (!shouldCachePtyForeground(processName, staticName)) {
          retireStaleForegroundIdentity()
          return
        }
        cachedAgentForeground = { processName, pid: processId ?? null, refreshedAt: Date.now() }
        startupAgentForeground = null
        return processName
      })
      .catch(() => {
        // Best-effort only: foreground enrichment must never affect PTY health.
      })
      .finally(() => {
        foregroundRefreshInFlight = false
      })
  }

  return {
    markDead: () => {
      cachedAgentForeground = null
      startupAgentForeground = null
    },
    getForegroundProcess: (options) => {
      if (args.isDead()) {
        return null
      }
      if (options?.rawFallback === true) {
        return getFallbackProcess()
      }
      try {
        const fallbackProcess = getFallbackProcess()
        const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
        const inspectOuterWrapper =
          fallbackRecognition !== null &&
          shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)
        if (fallbackProcess && fallbackRecognition && !inspectOuterWrapper) {
          cachedAgentForeground = {
            processName: fallbackProcess,
            pid: null,
            refreshedAt: Date.now()
          }
          startupAgentForeground = null
          return fallbackProcess
        }
        scheduleRefresh(fallbackProcess)
        const now = Date.now()
        if (
          cachedAgentForeground &&
          now - cachedAgentForeground.refreshedAt <= FOREGROUND_AGENT_CACHE_TTL_MS
        ) {
          return cachedAgentForeground.processName
        }
        if (
          cachedAgentForeground &&
          fallbackProcess !== null &&
          (staticName || isAgentForegroundWrapperProcess(fallbackProcess) || inspectOuterWrapper)
        ) {
          return cachedAgentForeground.processName
        }
        const activeStartupAgentForeground = getActiveStartupAgent(now)
        if (fallbackProcess && isShellProcess(fallbackProcess) && activeStartupAgentForeground) {
          return activeStartupAgentForeground.processName
        }
        return fallbackProcess
      } catch {
        return null
      }
    },
    confirmForegroundProcess: async () => {
      if (args.isDead() || !proc.pid) {
        return null
      }
      try {
        const fallbackProcess = getFallbackProcess()
        const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
        if (
          !fallbackProcess ||
          (fallbackRecognition !== null &&
            !shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) ||
          !shouldInspectFallback(fallbackProcess)
        ) {
          return fallbackProcess
        }
        const resolution = await resolveForeground(proc.pid, fallbackProcess, {
          contextPaths,
          fresh: true
        })
        if (args.isDead() || !resolution.available) {
          return null
        }
        const processName =
          recognizeAgentProcess(resolution.processName)?.processName ?? resolution.processName
        if (shouldCachePtyForeground(processName, staticName)) {
          cachedAgentForeground = {
            processName,
            pid: resolution.processId ?? null,
            refreshedAt: Date.now()
          }
          startupAgentForeground = null
          return cachedAgentForeground.processName
        }
        cachedAgentForeground = null
        startupAgentForeground = null
        return resolution.processName
      } catch {
        return null
      }
    },
    confirmShellForeground: () =>
      confirmPtyShellForeground({ process: proc, shellPath: args.shellPath, isDead: args.isDead })
  }
}
