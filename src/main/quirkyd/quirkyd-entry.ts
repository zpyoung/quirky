/**
 * `quirkyd` — the Quirky runtime served without Electron.
 *
 * Installs the Node host adapters, constructs the same `QuirkyRuntimeService` the
 * desktop uses, installs a PTY controller via `registerHeadlessPtyRuntime`, and
 * serves runtime RPC. See docs/design/node-only-runtime-backend.html.
 *
 * Desktop UI surfaces stay uninstalled: no native notifications or renderer delivery.
 * Browser automation is installed through
 * the runtime factory, but only when an Electron serve sidecar or an operator-supplied
 * Chromium proves available at startup.
 */
import { join } from 'node:path'
import process from 'node:process'
import { getAppEnvironment } from '../../shared/app-environment'
import { resolveQuirkydInstallRoot, resolveUserDataPath } from './quirkyd-app-paths'
import { prepareQuirkydCliLauncher } from './quirkyd-cli-launcher'
import {
  installQuirkydHostAdapters,
  prepareQuirkydSecretStore,
  runQuirkydQuitHandlers
} from './quirkyd-host-adapters'
import { describeQuirkydBindExposure, resolveQuirkydBindHost } from './quirkyd-bind-address'
import {
  flushQuirkydProfileStoreForShutdown,
  installQuirkydShutdownSignals,
  startQuirkydWithHost,
  type QuirkydShutdownTrigger
} from './quirkyd-lifecycle'
import { QUIRKYD_USAGE, parseArgs, resolveQuirkydWebClientRoot } from './quirkyd-command-arguments'
import type { QuirkydRuntimeCleanup } from './quirkyd-runtime-lifetime'
import { installQuirkydStopRequestListeners } from './quirkyd-stop-request-listener'
import { prepareQuirkydManagedStop } from './quirkyd-managed-stop-admission'
import type { QuirkydHandle, QuirkydOptions } from './quirkyd-start-contract'
import { beginQuirkydIdleExit, bindQuirkydIdleShutdown } from './quirkyd-managed-idle-exit-host'
import { quirkydAutomationsKeepHostBusy, startQuirkydAutomations } from './quirkyd-automations'
import {
  changedAiVaultSearchSettings,
  type AiVaultSearchSettings
} from '../../shared/ai-vault-search-settings'
import { stampRuntimeSourceEnv } from '../../shared/runtime-source-env'
import { adoptWslHostLoginEnvironment } from './quirkyd-wsl-host-login-environment'
import { installQuirkydProcessErrorGuards } from './quirkyd-process-error-guards'
import { quirkydWsPortOptions } from './quirkyd-ws-port-policy'
import { QUIRKY_LAYOUT_OWNER_IS_MAIN } from '../../shared/layout-owner-switch'
import { placeUnshownLiveTerminalsBestEffort } from '../runtime/terminal/adoption/unshown-live-terminal-placement'

export { parseArgs }

let closeQuirkydObservability = (): void => {}

/**
 * Boot the runtime and serve RPC. Resolves once the transport is listening and the
 * readiness payload has been published, mirroring the desktop `--serve` contract byte
 * for byte so the same harnesses can drive either host.
 */
export async function startQuirkyd(options: QuirkydOptions = {}): Promise<QuirkydHandle> {
  installQuirkydHostAdapters()
  // Why: an quirkyd started from an Quirky terminal must not fence its own CLI children to that Quirky.
  stampRuntimeSourceEnv(process.env, null)
  const userDataPath = resolveUserDataPath()
  // Why, as on the desktop: an inherited value would aim the CLI-shared Codex home paths elsewhere.
  process.env.QUIRKY_USER_DATA_PATH = userDataPath
  const { readiness, instance, stop } = await startQuirkydWithHost(
    userDataPath,
    (registerCleanup) => startQuirkydRuntime(options, registerCleanup),
    () => {
      try {
        runQuirkydQuitHandlers()
      } finally {
        // Last, after every quit handler (even a failing one), so their spans still reach the file.
        closeQuirkydObservability()
        closeQuirkydObservability = () => {}
      }
    }
  )
  const version = getAppEnvironment().getVersion()
  return { readiness, managedStop: { version, runtimeId: readiness.runtimeId, instance }, stop }
}

async function prepareQuirkydSecretStoreAndMigrate(userDataPath: string): Promise<void> {
  const { getSecretStore } = await import('../../shared/secret-store')
  const { reportSecretProtectionGap } = await import('../host/secret-protection-report')
  const { migratePlaintextCredentials, quirkydCredentialRoot } =
    await import('./quirkyd-plaintext-credential-migration')
  // Why the credential root, not userData: a disposable QUIRKY_USER_DATA would take the key with it.
  if (await prepareQuirkydSecretStore(quirkydCredentialRoot(), userDataPath)) {
    migratePlaintextCredentials(getSecretStore())
  }
  reportSecretProtectionGap({ dataFile: join(userDataPath, 'quirky-data.json') })
}

async function startQuirkydRuntime(
  options: QuirkydOptions,
  registerCleanup: (cleanup: QuirkydRuntimeCleanup) => void
): Promise<Pick<QuirkydHandle, 'readiness'>> {
  // Started first so the login-shell probe overlaps the imports and store startup below.
  const loginEnvironment = adoptWslHostLoginEnvironment().then(
    (names) => {
      if (names.length > 0) {
        console.info(`[quirkyd] adopted login-shell variables: ${names.join(', ')}`)
      }
    },
    (error: unknown) => console.warn('[quirkyd] could not adopt login-shell variables:', error)
  )
  const { QuirkyRuntimeService } = await import('../runtime/quirky-runtime')
  const { QuirkyRuntimeRpcServer } = await import('../runtime/runtime-rpc')
  const { registerHeadlessPtyRuntime } = await import('../ipc/pty/register-headless-runtime')
  const { getLocalPtyProvider } = await import('../ipc/pty/provider/registry')
  const { installQuirkydObservability } = await import('./quirkyd-observability')
  closeQuirkydObservability = installQuirkydObservability()
  const { ServeReadinessPublisher } = await import('../server/serve-readiness')
  const { servePublishMode } = await import('../server/serve-pairing-readiness')
  const { buildQuirkydServeReadiness } = await import('./quirkyd-serve-readiness')
  const { createQuirkydProfileStateStartup } = await import('./quirkyd-profile-state-startup')
  const { startQuirkydDaemon, stopQuirkydDaemon } = await import('./quirkyd-daemon-supervision')
  const { daemonOwnsFreshPersistentPtys } = await import('../daemon/daemon-provider-state')
  const { collectQuirkydHealth } = await import('./quirkyd-health')
  // Why importable here: the singleton's module tree never reaches Electron, and quirkyd supplies
  // its persistence and endpoint paths explicitly below.
  const { agentHookServer } = await import('../agent-hooks/server')
  const { isAgentStatusHooksEnabled } = await import('../agent-hooks/managed-agent-hook-controls')
  const { agentHookRuntimeDeps } = await import('../agent-hooks/agent-hook-runtime-deps')
  const { installHookStatusSessionTabsRepublish } =
    await import('../agent-hooks/hook-status-session-tabs-republish')
  const { startQuirkydManagedAgentHooks } = await import('./quirkyd-managed-agent-hooks')
  const { AgentStatusObservedPaneIdentities, AgentStatusObservedPaneIdentityCapture } =
    await import('../runtime/agent-status-observed-pane-identity')

  const { disposeWatcherProcessAndWait } = await import('../ipc/parcel-watcher-process')

  let paneGridsForShutdown: { flushPaneGrids(): Promise<void> | null } | null = null
  let profileStoreForShutdown:
    | { flushFinalOrThrowAsync(): Promise<void>; freezeWritesAsync(): Promise<void> }
    | undefined
  let uninstallHookStatusRepublish = (): void => {}
  let uninstallObservedStatusIdentity = (): void => {}
  // Cleanups run in reverse: RPC, then recovery and watchers, then the final flush, then daemon.
  registerCleanup(() => agentHookServer.stop())
  registerCleanup(() => uninstallHookStatusRepublish())
  registerCleanup(() => uninstallObservedStatusIdentity())
  // Why disconnect and not shut down: the daemon must outlive this process, or an quirkyd
  // restart goes back to killing every running terminal.
  registerCleanup(() => stopQuirkydDaemon())
  registerCleanup(async () => {
    // A SQLite-backed quirkyd has no JSON mirror to absorb a debounced write after SIGTERM.
    if (profileStoreForShutdown) {
      // Layout-owner build: a pane's grid still inside its write burst joins the final save.
      const paneGrids = paneGridsForShutdown?.flushPaneGrids()
      if (paneGrids) {
        await paneGrids
      }
      await flushQuirkydProfileStoreForShutdown(profileStoreForShutdown)
    }
  })
  // Watcher children outlive a disposal that does not wait for them.
  registerCleanup(() => disposeWatcherProcessAndWait())

  const runtimeUserDataPath = getAppEnvironment().getPath('userData')
  const { startEventLoopDelayProbe } = await import('../diagnostics/event-loop-delay-probe')
  startEventLoopDelayProbe('quirkyd', runtimeUserDataPath)
  // A missing `quirky` command must never keep the server from starting.
  await prepareQuirkydCliLauncher().catch((error: unknown) => {
    console.warn('[quirkyd] Could not prepare the profile CLI launcher', error)
  })
  const idleExitStartup = beginQuirkydIdleExit(runtimeUserDataPath)
  // Why before the profile store: it unseals protected settings as it loads.
  await prepareQuirkydSecretStoreAndMigrate(runtimeUserDataPath)
  const { store: profileStore, authority: profileStateAuthority } =
    await createQuirkydProfileStateStartup(runtimeUserDataPath)
  const observedPaneIdentities = new AgentStatusObservedPaneIdentities()
  const observedStatusCapture = new AgentStatusObservedPaneIdentityCapture(observedPaneIdentities)
  profileStoreForShutdown = profileStore
  uninstallObservedStatusIdentity = agentHookServer.subscribeEnrichedStatus((enriched) =>
    observedStatusCapture.observe(enriched)
  )
  // Before the hook server starts: a turn that begins before the feed subscribes is never counted.
  const { startQuirkydStats } = await import('./quirkyd-stats')
  const stats = startQuirkydStats(runtimeUserDataPath, agentHookServer, registerCleanup)
  await agentHookServer.start({
    env: 'production',
    userDataPath: runtimeUserDataPath,
    statusHooksEnabled: isAgentStatusHooksEnabled(profileStore.getSettings())
  })

  // Before hook reconcile, the daemon and the runtime: each reads or inherits this env.
  await loginEnvironment
  startQuirkydManagedAgentHooks(
    profileStore,
    (enabled) => agentHookServer.setStatusHooksEnabled(enabled),
    registerCleanup
  )

  // Why before the runtime and the PTY handlers: `setLocalPtyProvider` installs the daemon
  // adapter as THE local provider, and the registry's contract is that it lands before
  // registerPtyHandlers so the IPC layer routes through the daemon from the first call.
  await startQuirkydDaemon()

  // Why a holder and not a direct reference: the index is installed after the runtime is
  // constructed, and the deps hook is only ever called later, from an RPC.
  let sessionSearch: { apply(settings: AiVaultSearchSettings): void; dispose(): void } | null = null

  const { quirkydCodexAccountHomes } = await import('./quirkyd-codex-account-homes')
  const codexAccountHomes = quirkydCodexAccountHomes(
    () => profileStore.getSettings(),
    registerCleanup
  )

  // Why before the runtime: its structured Codex resolvers are constructor deps.
  const { createQuirkydAccountServices } = await import('./quirkyd-account-services')
  const accountLaunch = createQuirkydAccountServices({
    store: profileStore,
    setClaudeStatusLineListener: (listener) =>
      agentHookServer.setClaudeStatusLineListener(listener),
    registerCleanup,
    clientCodexHomes: codexAccountHomes
  })

  const { loadAgentSessionClaimSigner } = await import('../runtime/agent-session-claim-identity')
  const runtime = new QuirkyRuntimeService(profileStore, stats, {
    // Why persistent: the terminal daemon outlives quirkyd, so a per-process key would make a
    // restarted quirkyd unable to recognise (and adopt) the agent PTYs it already owns.
    agentSessionClaimSigner: loadAgentSessionClaimSigner(runtimeUserDataPath, runtimeUserDataPath),
    getAdditionalAiVaultCodexHomePaths: () => [
      ...codexAccountHomes.listSessionHomes(),
      ...(accountLaunch?.listCodexSessionHomes() ?? [])
    ],
    // Why absent on a WSL host: a resolver overrides the desktop-pushed CODEX_HOME.
    ...accountLaunch?.runtimeDeps,
    // Why here too: quirkyd serves `worktree.ps` and `agentSession.*`; unwired it lists no agents.
    ...agentHookRuntimeDeps(agentHookServer, observedPaneIdentities, () =>
      profileStore.getSettings()
    ),
    // Why lazy: a daemon swap replaces the provider after construction, so an eager
    // reference would freeze the pre-daemon one.
    getLocalProvider: () => getLocalPtyProvider(),
    // Why the daemon predicate and not a constant: quirkyd now spawns the terminal daemon, so
    // its PTYs DO survive an quirkyd restart — but only while a daemon that owns fresh
    // sessions is installed. A failed or degraded launch has to answer false, and this reads
    // that live rather than snapshotting it at construction.
    canRecoverPersistentLocalPtys: () => daemonOwnsFreshPersistentPtys(),
    // Why 'blocked': `'openable'` means a desktop window can be opened here, which is
    // what powers serve→desktop promotion. A Node host can never do that, and the
    // constructor's default would advertise it.
    getDesktopWindowStatus: () => 'blocked',
    // Why the dedupe here and not in the instance: `apply` closes and reconstructs
    // unconditionally, so an unchanged value would restart a healthy index.
    applySessionSearchSettings: (before, after) => {
      const next = changedAiVaultSearchSettings(before, after)
      if (next) {
        sessionSearch?.apply(next)
      }
    }
  })
  paneGridsForShutdown = runtime

  accountLaunch?.attachToRuntime(runtime)

  // Why before any launch: a desktop that owns this host's accounts pushed them on an earlier run.
  const { restoreQuirkydHostAccountLaunchEnv } =
    await import('./quirkyd-host-account-launch-env-store')
  restoreQuirkydHostAccountLaunchEnv(runtime, runtimeUserDataPath)

  const { installQuirkydSessionSearchService } = await import('./quirkyd-session-search')
  sessionSearch = await installQuirkydSessionSearchService({
    userDataPath: runtimeUserDataPath,
    getSettings: () => profileStore.getSettings()
  })
  getAppEnvironment().onWillQuit(() => sessionSearch?.dispose())

  // Why: this host evaluates its own panes, so it applies its own rules override.
  const { startAgentStateRulesOverride } =
    await import('../runtime/agent-state-rules/agent-state-rules-override')
  startAgentStateRulesOverride(profileStore, (rules) =>
    console.info(`[quirkyd] agent state rules ${rules.version} (${rules.source})`)
  )
  // Switch point: main's load repair, here too, now that this runtime can move pane owners.
  if (QUIRKY_LAYOUT_OWNER_IS_MAIN) {
    const { repairDuplicatePtyPanesOnStart } = await import('../runtime/moved-pane-owner-rekey')
    // Awaited: it queues behind any in-flight write, and must land before reconcile and RPC.
    await repairDuplicatePtyPanesOnStart(profileStore, runtime)
  }

  // Why here too and not only on the desktop: nothing else republishes `session.tabs` when a
  // pane's status row changes, and quirkyd's whole job is serving paired clients.
  uninstallHookStatusRepublish = installHookStatusSessionTabsRepublish(
    agentHookServer,
    () => runtime
  )
  registerCleanup(runtime.attachAgentStatusStore(agentHookServer))

  // Why the headless entry point rather than registerPtyHandlers directly: this is the
  // same call `--serve` makes, and it threads the store through. Without the store the
  // handlers install fine and every terminal.create then fails at persistence time.
  //
  // A client-sent Codex account home wins; otherwise this host's own selection applies. A WSL host
  // has none: its desktop sends the prepared account env.
  await registerHeadlessPtyRuntime(
    runtime,
    async (target, launchEnv, context) =>
      (await codexAccountHomes.selectLaunchHome(target, launchEnv, context)) ??
      (accountLaunch ? accountLaunch.prepareCodexHome(target, launchEnv, context) : null),
    () => profileStore.getSettings(),
    accountLaunch?.prepareClaudeAuth,
    profileStore,
    accountLaunch?.prepareCodexSessionResume
  )

  // Why: same post-registration reconciliation `--serve` performs. Skipping it leaves
  // restored orchestration rows claiming an authority this host never took over.
  // Why before the RPC server binds: a client host attaching first would find no pages to recover.
  runtime.rehydrateClientHostedBrowserPages()

  await runtime.refreshRestoredOrchestrationAuthority()
  await runtime.reconcileLegacyWorkerTerminals()
  // Switch point: main shows live terminals no pane shows, before any client attaches.
  if (QUIRKY_LAYOUT_OWNER_IS_MAIN) {
    await placeUnshownLiveTerminalsBestEffort(runtime)
  }
  // Hook rows hydrated and the PTY runtime registered: stored sort tiers can be checked.
  runtime.agentTransitions.seedRestoredRows()
  void runtime.sidebarFacts?.reconcileSortStampTiers(getLocalPtyProvider())

  // Runs after RPC stops (cleanups run reversed); later records save synchronously until exit.
  registerCleanup(() => runtime.closeNotificationDismissals())
  // A retry armed during recovery would otherwise write after the final profile flush.
  registerCleanup(() => runtime.stopLegacyWorkerTerminalRecovery())

  // Recovery binds terminal and dispatch identities; only now can startup observations be fenced.
  observedStatusCapture.attach(runtime)
  agentHookServer.setCliWriterExecutionMatcher(observedPaneIdentities, runtime)
  // Why before the RPC server binds: like `--serve`, the first client must find a ready graph.
  const { publishHeadlessRuntimeGraph } = await import('../runtime/headless-runtime-graph')
  publishHeadlessRuntimeGraph(runtime)
  // Store load skipped moved shell history: only the runtime can tell which worktrees run a shell.
  void runtime.installPendingQuirkydMigrationShellHistory().catch((error: unknown) => {
    console.error('[quirkyd-migration] installing pending shell history failed:', error)
  })

  const bindHost = resolveQuirkydBindHost(options.bind)
  const rpc = new QuirkyRuntimeRpcServer({
    runtime,
    userDataPath: runtimeUserDataPath,
    enableWebSocket: true,
    // Why pinned and not `exposeNetworkByDefault`: an unattended host's exposure must be
    // exactly what the operator asked for, on every launch. The default path widens itself
    // once a device has connected, so a loopback deployment would silently go wide one
    // restart after its first client paired.
    pinnedBindHost: bindHost,
    webClientRoot: resolveQuirkydWebClientRoot(options.webClientRoot),
    ...quirkydWsPortOptions(options.port)
  })
  // Stops first: no RPC may write while the rest of the runtime is torn down.
  registerCleanup(() => rpc.stop())
  await rpc.start()
  startQuirkydAutomations(runtime, profileStore, registerCleanup)
  console.error(`[quirkyd] ${describeQuirkydBindExposure(bindHost)}`)

  const readiness = await buildQuirkydServeReadiness({
    options,
    runtimeId: runtime.getRuntimeId(),
    rpc,
    collectHealth: () =>
      collectQuirkydHealth(
        getAppEnvironment().getVersion(),
        profileStateAuthority,
        idleExitStartup.previousIdleStop
      )
  })

  await new ServeReadinessPublisher().publish(readiness, servePublishMode(options))

  await idleExitStartup.start({
    rpc,
    agentStates: () => agentHookServer.getStatusSnapshot(),
    hasStagedMigration: () => profileStore.hasStagedQuirkydMigrationCatalog(),
    automationsBusy: () => quirkydAutomationsKeepHostBusy(profileStore),
    registerCleanup
  })
  return { readiness }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(QUIRKYD_USAGE)
    return
  }
  let shutdownTrigger: QuirkydShutdownTrigger | null = null
  // Before startup: its fire-and-forget chains can reject before the first await settles.
  installQuirkydProcessErrorGuards(() => shutdownTrigger)
  const startup = startQuirkyd(options)
  const requestShutdown = installQuirkydShutdownSignals(async () => (await startup).stop())
  shutdownTrigger = requestShutdown
  const handle = await startup
  // Why after startup: a managed request must name the runtime and instance this run became.
  installQuirkydStopRequestListeners(() => requestShutdown('stop request'), {
    installRoot: resolveQuirkydInstallRoot(),
    managedStop: handle.managedStop,
    beforeManagedStop: prepareQuirkydManagedStop
  })
  bindQuirkydIdleShutdown(requestShutdown)
}
