import { inheritOmpLaunchEnvironment } from '../host-env/omp-launch-environment'
import { getAppEnvironment } from '../../../../shared/app-environment'
import type { QuirkyRuntimeService } from '../../../runtime/quirky-runtime'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { isAgentStatusHooksEnabled } from '../../../agent-hooks/managed-agent-hook-controls'
import { LocalPtyProvider } from '../../../providers/local-pty-provider'
import type { CodexAccountSelectionTarget } from '../../../codex-accounts/runtime-selection'
import { buildPtyHostEnv } from '../host-env/assembly'
import { stampRuntimeSourceEnv } from '../../../../shared/runtime-source-env'
import { getRuntimeSourceStamp } from '../../../runtime/host-descriptor'
import {
  getCompatibleSelectedCodexHomePath,
  shouldStripInheritedQuirkyCodexHome
} from '../host-env/codex-home'
import type { GetSelectedCodexHomePath } from '../host-env/types'
import { isCurrentPtyExit, ptyOwnership } from './ownership-state'
import { localProvider } from './registry'
import { clearProviderPtyState } from './state-cleanup'
import { visibleRendererPtys } from '../delivery/visibility-state'
import { QUIRKY_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { prepareAntigravityAccountForLaunch } from '../../../antigravity/native-account-launch'

export function configureLocalPtyProvider(args: {
  runtime?: QuirkyRuntimeService
  getSettings?: () => GlobalSettings
  getSelectedCodexHomePath?: GetSelectedCodexHomePath
  trustedTerminalHandleEnv: Set<string>
}): void {
  // Why: only LocalPtyProvider needs main-process hook injection; daemon-backed providers spawn subprocesses internally.
  if (!(localProvider instanceof LocalPtyProvider)) {
    return
  }
  const { runtime, getSettings, getSelectedCodexHomePath, trustedTerminalHandleEnv } = args
  localProvider.configure({
    isHistoryEnabled: () => getSettings?.()?.terminalScopeHistoryByWorktree ?? true,
    getWindowsShell: () => getSettings?.()?.terminalWindowsShell,
    getDefaultShell: () => getSettings?.()?.terminalDefaultShell,
    getWindowsPowerShellImplementation: () =>
      getSettings ? (getSettings()?.terminalWindowsPowerShellImplementation ?? 'auto') : undefined,
    buildSpawnEnv: async (id, baseEnv, ctx) => {
      await prepareAntigravityAccountForLaunch({
        launchAgent: ctx?.launchAgent,
        command: ctx?.command,
        isWsl: ctx?.isWsl,
        env: baseEnv,
        envIsComplete: true
      })
      const codexSelectionTarget: CodexAccountSelectionTarget =
        ctx?.isWsl === true
          ? { runtime: 'wsl', wslDistro: ctx.wslDistro ?? null }
          : { runtime: 'host' }
      const selectedCodexHomePath = getCompatibleSelectedCodexHomePath(
        codexSelectionTarget,
        ctx?.codexHomePathOverride
          ? ctx.codexHomePathOverride.value
          : ((await getSelectedCodexHomePath?.(codexSelectionTarget, baseEnv)) ?? null)
      )
      const skipCodexHomeEnv = ctx?.isWsl === true && !selectedCodexHomePath
      const ptySettings = getSettings?.()
      await inheritOmpLaunchEnvironment(baseEnv, {
        shellPath: ctx?.shellPath,
        explicitEnv: ctx?.explicitEnv,
        isWsl: ctx?.isWsl,
        launchAgent: ctx?.launchAgent,
        launchCommand: ctx?.command
      })
      const env = buildPtyHostEnv(id, baseEnv, {
        isPackaged: getAppEnvironment().isPackaged(),
        resourcesPath: process.resourcesPath,
        userDataPath: getAppEnvironment().getPath('userData'),
        selectedCodexHomePath,
        skipCodexHomeEnv,
        stripInheritedQuirkyCodexHome: shouldStripInheritedQuirkyCodexHome({
          target: codexSelectionTarget,
          selectedCodexHomePath,
          skipCodexHomeEnv,
          settings: ptySettings
        }),
        launchCommand: ctx?.command,
        launchAgent: ctx?.launchAgent,
        shellPath: ctx?.shellPath,
        isWsl: ctx?.isWsl,
        wslDistro: ctx?.wslDistro ?? null,
        agentStatusHooksEnabled: isAgentStatusHooksEnabled(ptySettings),
        terminalInlineImages: ptySettings?.terminalInlineImages,
        disabledTuiAgents: ptySettings?.disabledTuiAgents,
        networkProxySettings: ptySettings,
        routeBrowserOpensToClient: runtime?.shouldRelayTerminalBrowserOpens?.()
      })
      // Why: agents need their terminal handle at process start to self-identify in orchestration messages without an extra RPC.
      const requestedHandle = baseEnv.QUIRKY_TERMINAL_HANDLE
      const preAllocatedHandle =
        requestedHandle && trustedTerminalHandleEnv.has(requestedHandle)
          ? requestedHandle
          : runtime?.preAllocateHandleForPty(id)
      if (requestedHandle && requestedHandle !== preAllocatedHandle) {
        delete env.QUIRKY_TERMINAL_HANDLE
      }
      if (preAllocatedHandle) {
        env.QUIRKY_TERMINAL_HANDLE = preAllocatedHandle
      }
      stampRuntimeSourceEnv(
        env,
        getRuntimeSourceStamp(runtime, getAppEnvironment().getPath('userData'))
      )
      return env
    },
    onSpawned: (id, incarnationId) => runtime?.onPtySpawned(id, incarnationId),
    onExit: (id, code, incarnationId, cause) => {
      if (!isCurrentPtyExit({ id, incarnationId })) {
        return
      }
      // Read before the clean-up below forgets it.
      const viewShown = QUIRKY_LAYOUT_OWNER_IS_MAIN && visibleRendererPtys.has(id)
      clearProviderPtyState(id)
      ptyOwnership.delete(id)
      runtime?.onPtyExit(id, code, incarnationId, {
        providerExitObserved: true,
        ...(viewShown ? { viewShown } : {}),
        ...(cause ? { cause } : {})
      })
    },
    onData: (id, data, timestamp, sequenceChars, transformed) =>
      runtime?.onPtyData(id, data, timestamp, sequenceChars ?? data.length, transformed)
  })
}
