import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { dedupeInFlightRun } from '../in-flight-run-dedupe'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import { writeManagedScript } from '../agent-hooks/installer-utils'
import { getOrcaManagedCodexHomePath } from './codex-home-paths'
import { getManagedCommand, getManagedScriptPath } from './codex-hook-definition'
import { installCodexHooksExclusively } from './codex-hook-local-install'
import { getManagedCodexHookHome, readStopgapOrcaHashes } from './codex-hook-orca-approvals'
import {
  refreshCodexRuntimeUserHooksExclusively,
  removeCodexHooksExclusively
} from './codex-hook-local-maintenance'
import { installCodexHooksRemote } from './codex-hook-remote-install'
import { getManagedScript } from './codex-hook-script'
import { readCodexHookHomeStatus, readCurrentCodexHookStatus } from './codex-hook-status'
import {
  CODEX_ANSWER_AWAITED,
  CODEX_HOOK_LAUNCH_WAIT_MS,
  readEveryKnownCodexHookHashes,
  resolveCodexHookAnswerForLaunch
} from './codex-hook-hash-lookup'
import { reconcileCodexHooks } from './codex-hook-reconcile'
import { cleanupLegacyManagedHookRepresentations } from './codex-hook-legacy-cleanup'
import { runExclusivelyForRuntimeAndSystemTrustConfig } from './codex-hook-trust-queue'
/**
 * Lane-scoped so the hooks-on install never joins the hooks-off refresh, and a
 * Codex launch never joins a plain terminal's run that went ahead without Codex's answer.
 */
function launchPrepKey(
  lane: 'install' | 'codex-launch' | 'refresh',
  runtimeHomePath: string
): string {
  return `${lane}\0${normalizeRuntimePathForComparison(runtimeHomePath)}`
}

export class CodexHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  private readonly launchPrepInFlight = new Map<string, Promise<AgentHookInstallStatus>>()

  async prepareRuntimeHomeForLaunch(
    runtimeHomePath: string | null | undefined,
    isHooksEnabled: () => boolean,
    launchesCodex: boolean
  ): Promise<AgentHookInstallStatus> {
    if (isHooksEnabled()) {
      // Why: a managed account's launch home is its self-contained CODEX_HOME,
      // so hooks/trust must install there rather than the shared mirror.
      return this.installForLaunchPrep(runtimeHomePath ?? undefined, launchesCodex, isHooksEnabled)
    }
    return this.refreshRuntimeUserHooksForLaunchPrep(runtimeHomePath ?? undefined)
  }

  /**
   * Status read from a home's files: the home the next native pane gets when
   * none is named (~/.codex outside the app), else that home.
   */
  getStatus(runtimeHomePath?: string): AgentHookInstallStatus {
    return readCurrentCodexHookStatus(runtimeHomePath)
  }

  /**
   * App start and the setting turning on: reconciles Orca's entry in ~/.codex,
   * converting an older build's, then sweeps retired forms.
   */
  async reconcileHooks(): Promise<AgentHookInstallStatus> {
    try {
      // Why here too: like every managed agent's installer, it deploys its shared script.
      writeManagedScript(getManagedScriptPath(), getManagedScript())
    } catch (error) {
      console.warn('[codex-hook-service] could not write the Codex hook script:', error)
    }
    await reconcileCodexHooks({ convertOlderForms: true })
    await cleanupLegacyManagedHookRepresentations()
    return this.getStatus()
  }

  // Why: runtimeHomePath defaults to the shared managed mirror, but a managed
  // account launching against its own self-contained CODEX_HOME passes that
  // per-account home so hooks.json/config.toml/trust land where codex reads.
  // Only launch prep for a pane that does not run Codex skips waiting for Codex's answer.
  async install(
    runtimeHomePath: string = getOrcaManagedCodexHomePath(),
    launchesCodex = true,
    isHooksEnabled: () => boolean = () => true
  ): Promise<AgentHookInstallStatus> {
    const answer =
      (await resolveCodexHookAnswerForLaunch(launchesCodex ? CODEX_HOOK_LAUNCH_WAIT_MS : 0)) ??
      CODEX_ANSWER_AWAITED
    return runExclusivelyForRuntimeAndSystemTrustConfig(runtimeHomePath, () => {
      // Why decided in the queue: an Off that landed during the wait has already run, and must win.
      if (!isHooksEnabled() || answer.kind === 'refused') {
        // Why: without Codex's hash an entry would wait for review; the home keeps only the user's hooks.
        return refreshCodexRuntimeUserHooksExclusively(runtimeHomePath, (homePath) =>
          readCodexHookHomeStatus(homePath, answer)
        )
      }
      // Why a stopgap: an answer still on its way must never leave a managed home worse than main.
      const hashes =
        answer.kind === 'hashes'
          ? answer.hashes
          : readStopgapOrcaHashes(
              getManagedCodexHookHome(runtimeHomePath),
              getManagedCommand(getManagedScriptPath())
            )
      return installCodexHooksExclusively(runtimeHomePath, hashes, (homePath) =>
        readCodexHookHomeStatus(homePath, answer)
      )
    })
  }

  /**
   * Launch prep runs on every local PTY spawn, and both lanes below serialize
   * globally per Codex home, so activating a multi-pane worktree used to pay one
   * full hook install per pane back to back (measured ~790ms for 7 panes, and a
   * resumed Codex pane prepares twice). Spawns racing for the same home all want
   * the same on-disk outcome, so they share one run —
   *
   * Invalidation: `dedupeInFlightRun` drops the run the moment it settles, so the
   * next launch re-reads hooks.json and the user's trust state. Never widen this
   * into a time-based cache — the hooks setting, ~/.codex approvals and the
   * managed script can all change between spawns, and only a fresh run sees them.
   */
  installForLaunchPrep(
    runtimeHomePath: string | undefined,
    launchesCodex: boolean,
    isHooksEnabled: () => boolean
  ): Promise<AgentHookInstallStatus> {
    const homePath = runtimeHomePath ?? getOrcaManagedCodexHomePath()
    return dedupeInFlightRun(
      this.launchPrepInFlight,
      launchPrepKey(launchesCodex ? 'codex-launch' : 'install', homePath),
      () => this.install(homePath, launchesCodex, isHooksEnabled)
    )
  }

  refreshRuntimeUserHooksForLaunchPrep(runtimeHomePath?: string): Promise<AgentHookInstallStatus> {
    const homePath = runtimeHomePath ?? getOrcaManagedCodexHomePath()
    return dedupeInFlightRun(this.launchPrepInFlight, launchPrepKey('refresh', homePath), () =>
      this.refreshRuntimeUserHooks(homePath)
    )
  }

  installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    options?: { codexHomeDir?: string; deferTrustUntilConfigToml?: boolean }
  ): Promise<AgentHookInstallStatus> {
    return installCodexHooksRemote(sftp, remoteHome, options)
  }

  refreshRuntimeUserHooks(
    runtimeHomePath: string = getOrcaManagedCodexHomePath()
  ): Promise<AgentHookInstallStatus> {
    return runExclusivelyForRuntimeAndSystemTrustConfig(runtimeHomePath, () =>
      this.refreshRuntimeUserHooksExclusively(runtimeHomePath)
    )
  }

  private refreshRuntimeUserHooksExclusively(
    runtimeHomePath: string
  ): Promise<AgentHookInstallStatus> {
    return refreshCodexRuntimeUserHooksExclusively(runtimeHomePath, (homePath) =>
      this.getStatus(homePath)
    )
  }

  remove(): Promise<AgentHookInstallStatus> {
    return runExclusivelyForRuntimeAndSystemTrustConfig(getOrcaManagedCodexHomePath(), () =>
      this.removeExclusively()
    )
  }

  private removeExclusively(): Promise<AgentHookInstallStatus> {
    // Why every saved version: the mirror may still hold an approval from a Codex since updated.
    return removeCodexHooksExclusively(readEveryKnownCodexHookHashes(), () => this.getStatus())
  }
}
