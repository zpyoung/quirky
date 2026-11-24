import { powerMonitor } from 'electron'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { createDesktopRelayServiceInstaller } from '../runtime/mobile-cloud-relay/desktop-relay-service-installer'
import { mainProcessState as state } from './main-process-state'

// Registers the on-demand Relay installer and starts the first install, which
// waits for the persisted proxy itself, so it can run before the proxy lands.
export function startDesktopRelayService(runtimeRpc: OrcaRuntimeRpcServer): void {
  const installer = createDesktopRelayServiceInstaller({
    runtimeRpc,
    whenNetworkReady: state.initialProxyApplicationReady,
    isFenced: () => state.isQuitting,
    create: () => null,
    onInstalled: (service) => {
      state.desktopRelayService = service
    }
  })
  state.desktopRelayInstaller = installer
  runtimeRpc.setMobileRelayPairingProviderInstaller(() => installer.ensure())
  // Why: sleeping past relay-token expiry kills the broker with no retry
  // timer; resume is the moment that state becomes recoverable.
  powerMonitor.on('resume', () => state.desktopRelayService?.ensureLive())
  void installer.ensure()
}
