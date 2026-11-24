import {
  applySessionSearchSettingsChange,
  installChildSessionSearchService
} from '../ai-vault-search/session-search-enablement'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { sessionSearchScopeCatalogFromStore } from '../ai-vault-search/session-search-store-scope-catalog'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'
import { app, ipcMain } from 'electron'
import { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { getLocalPtyProvider } from '../ipc/pty/provider/registry'
import { clearProviderPtyState } from '../ipc/pty/provider/state-cleanup'
import { agentHookServer } from '../agent-hooks/server'
import { toAgentStatusIpcPayload } from '../agent-hooks/server/server-status-identity'
import { browserManager } from '../browser/browser-manager'
import { loadAgentSessionClaimSigner } from '../runtime/agent-session-claim-identity'
import { getProfileUserDataPath } from '../quirky-profiles/profile-storage-paths'
import { codexAiVaultSessionResumePreparation } from '../codex/codex-ai-vault-session-resume'
import { prepareCodexPinnedLaunchHome } from './codex-session-resume-launch'
import { resolveHostCodexSessionSourceHome } from '../codex/codex-session-source-home'
import { agentHookRuntimeDeps } from '../agent-hooks/agent-hook-runtime-deps'
import { getDaemonProvider } from '../daemon/daemon-provider-state'
import type { TerminalSideEffectBatch } from '../../shared/terminal-side-effect-facts'
import type { OrchestrationEnvironmentTransport } from '../runtime/orchestration/environment-transport'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import { getPreferredPairedRuntimeConnection } from '../../shared/runtime-environments'
import { fingerprintOrchestrationPeer } from '../runtime/orchestration/environment-transport'
import { callRuntimeEnvironment } from '../ipc/runtime-environments/runtime-environment-transport-routing'
import { mainProcessState as state } from './main-process-state'
import { forwardRuntimeAskEventsToRenderer } from '../fork-ask-question-tool/ask-ipc-forward'
import { startHeimdall } from '../fork-heimdall/registration'
import { wireHeimdallFleetWindows } from '../fork-heimdall/fleet-ipc-forward'
import { startLoops } from '../fork-loops/registration'
import { startClaudeSuppressionVerdictPublisher } from '../fork-ask-question-tool/claude-suppression-verdict-publisher'
import { getDashboardPopoutWindow } from '../window/dashboard-popout-window'
import {
  codexStructuredLaunchHomeResolvers,
  prepareCodexRuntimeHomeForLaunch
} from './codex-launch-preparation'
import { resolveHostAgentBaseEnvironment } from '../runtime/structured-agent-shell-environment'
import type { RuntimeDesktopWindowStatus } from '../../shared/runtime-types'
import {
  AgentStatusObservedPaneIdentities,
  recordObservedAgentStatusPaneIdentity
} from '../runtime/agent-status-observed-pane-identity'
import { startAgentStateRulesOverride } from '../runtime/agent-state-rules/agent-state-rules-override'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { QUIRKY_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'

export function getDesktopWindowStatus(): RuntimeDesktopWindowStatus {
  const activation = state.desktopActivationGate
  if (!activation) {
    return 'available'
  }
  const value = activation.getState()
  return value === 'ready' ? 'openable' : value
}

export function initializeMainProcessRuntime(): QuirkyRuntimeService {
  const store = state.store
  const stats = state.stats
  if (!store || !stats) {
    throw new Error('Store and stats must be initialized before runtime')
  }
  const orchestrationEnvironmentTransport: OrchestrationEnvironmentTransport = {
    resolve: (selector) => {
      const environment = resolveEnvironment(app.getPath('userData'), selector)
      const connection = getPreferredPairedRuntimeConnection(environment)
      return {
        environmentId: environment.id,
        name: environment.name,
        peerFingerprint: fingerprintOrchestrationPeer(connection.hostPublicKeyB64),
        pairingRevision: environment.pairingRevision ?? environment.createdAt
      }
    },
    call: (selector, method, params, timeoutMs, envelope, expectedPairingRevision) =>
      callRuntimeEnvironment(
        app.getPath('userData'),
        selector,
        method,
        params,
        timeoutMs,
        expectedPairingRevision,
        envelope
      )
  }
  // Why here and not in the window listener: `subscribeEnrichedStatus` also fires under headless
  // `quirky serve`, which never opens one, and the fleet path runs there too.
  const observedPaneIdentities = new AgentStatusObservedPaneIdentities()
  const runtime = new QuirkyRuntimeService(store, stats, {
    ...agentHookRuntimeDeps(agentHookServer, observedPaneIdentities, () =>
      state.store?.getSettings()
    ),
    prepareClaudeAuth: (target) => state.claudeRuntimeAuth!.prepareForClaudeLaunch(target),
    agentSessionClaimSigner: loadAgentSessionClaimSigner(
      getProfileUserDataPath(),
      getProfileUserDataPath()
    ),
    // Why: resolve the PTY provider lazily — a daemon swap happens later, so an eager reference would freeze the pre-daemon provider (design §4.3).
    getLocalProvider: () => getLocalPtyProvider(),
    onPtyStopped: clearProviderPtyState,
    // Why: serve can be promoted in place, so wire the listener from startup; runtime enables desktop-only scanners only for a ready renderer.
    onTerminalSideEffects: (batch: TerminalSideEffectBatch) => {
      if (state.mainWindow && !state.mainWindow.isDestroyed()) {
        state.mainWindow.webContents.send('pty:sideEffect', batch)
      }
    },
    getDesktopWindowStatus,
    attestAgentHookCompatibilityAuthority: (candidate) =>
      agentHookServer.attestCompatibilityAuthority(candidate),
    retireAgentHookCompatibilityAuthority: (paneKey) =>
      agentHookServer.retirePaneAuthority(paneKey),
    canRecoverPersistentLocalPtys: () => getDaemonProvider() !== null,
    // Why: evaluated per call, not captured — the RPC server that owns the device registry is
    // constructed with this runtime and does not exist yet at this point.
    getPairedDeviceName: (pairedDeviceId) =>
      state.runtimeRpc?.getDeviceRegistry()?.getDevice(pairedDeviceId)?.name ?? null,
    // Why: source codex-home here (runs in window AND serve) so aiVault.listSessions includes managed-Codex sessions; registerCoreHandlers is window-only.
    getAdditionalAiVaultCodexHomePaths: () =>
      state.codexRuntimeHome?.getHostCodexHomePathsForSessionDiscovery() ?? [],
    prepareAiVaultSessionResume: codexAiVaultSessionResumePreparation(() => ({
      runtimeHome: state.codexRuntimeHome,
      systemCodexHomePath: resolveHostCodexSessionSourceHome(store.getSettings()),
      preparePinnedLaunchHome: (home) => prepareCodexPinnedLaunchHome(home)
    })),
    ...codexStructuredLaunchHomeResolvers,
    prepareCodexCatalogProbeHome: (homePath) =>
      state.codexRuntimeHome?.prepareHostCodexHomeForReadOnlyAppServer(
        homePath,
        resolveTuiAgentLaunchEnv('codex', store.getSettings().agentDefaultEnv)
      ),
    orchestrationEnvironmentTransport,
    // Why the same function the settings IPC handler calls: a paired client's write and a
    // local one must reconcile the scanner child through one path, or they can disagree.
    applySessionSearchSettings: applySessionSearchSettingsChange
  })
  // Both desktop and headless serve own a host-local search service.
  const sessionSearch = installChildSessionSearchService({
    dataRoot: getCanonicalUserDataPath(),
    getSettings: () => store.getSettings(),
    // Why read per request rather than snapshot: a repo added or a workspace
    // renamed between two searches has to be in scope for the second one.
    // This process answers for its own host, so the catalog is bound to it here.
    getScopeCatalog: () => sessionSearchScopeCatalogFromStore(store, LOCAL_EXECUTION_HOST_ID)
  })
  app.once('will-quit', () => sessionSearch?.dispose())
  // Why here: this runs for the desktop and headless `quirky serve`, and each evaluates its own panes.
  startAgentStateRulesOverride(store, (rules) =>
    recordDurableCrashBreadcrumb('agent_state_rules_active', rules)
  )
  state.runtime = runtime
  runtime.attachAgentStatusStore(agentHookServer)
  agentHookServer.subscribeEnrichedStatus((enriched) =>
    recordObservedAgentStatusPaneIdentity(observedPaneIdentities, enriched, runtime)
  )
  agentHookServer.setCliWriterExecutionMatcher(observedPaneIdentities, runtime)
  // Switch point: main keeps the resume record of each pane it holds from the status it accepts.
  if (QUIRKY_LAYOUT_OWNER_IS_MAIN) {
    agentHookServer.subscribeEnrichedStatus((enriched) =>
      runtime.recordHookStatusResume(toAgentStatusIpcPayload(enriched))
    )
    agentHookServer.subscribePaneStatusClear((clear) => runtime.forgetHookStatusResume(clear))
    agentHookServer.subscribeStatusDrop((paneKey) => runtime.forgetHookStatusResume({ paneKey }))
  }
  forwardRuntimeAskEventsToRenderer(runtime, () => state.mainWindow, getDashboardPopoutWindow)
  state.heimdall = startHeimdall(runtime, store, state.isServeMode)
  wireHeimdallFleetWindows(runtime, () => state.mainWindow)
  state.loops = startLoops(runtime, store, state.isServeMode)
  startClaudeSuppressionVerdictPublisher({
    store,
    ipcMain,
    getWindows: () => [state.mainWindow, getDashboardPopoutWindow()]
  })
  // Why before anything can attach: a client host that reattaches to a restarted runtime is only
  // handed its pages back if the runtime found them first.
  runtime.rehydrateClientHostedBrowserPages()
  browserManager.setBrowserGuestStateChangedListener((worktreeId) => {
    runtime.notifyMobileSessionTabsChanged(worktreeId)
  })
  return runtime
}

export function configureRuntimeServices(runtime: QuirkyRuntimeService): void {
  const store = state.store
  const claudeAccounts = state.claudeAccounts
  const codexAccounts = state.codexAccounts
  const rateLimits = state.rateLimits
  if (!store || !claudeAccounts || !codexAccounts || !rateLimits) {
    throw new Error('Account services must be initialized before runtime wiring')
  }
  runtime.setAccountServices({ claudeAccounts, codexAccounts, rateLimits })
  runtime.setCommitMessageAgentEnvironmentResolvers({
    // Why: Codex hooks/auth live in Quirky's managed runtime home even for the default path, so every launch must resolve CODEX_HOME via runtime-home.
    prepareForCodexLaunch: prepareCodexRuntimeHomeForLaunch,
    prepareForClaudeLaunch: (target) => state.claudeRuntimeAuth!.prepareForClaudeLaunch(target),
    resolveBaseEnvironment: () => resolveHostAgentBaseEnvironment(store.getSettings())
  })
}
