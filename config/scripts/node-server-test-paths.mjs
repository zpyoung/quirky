/** Mirrors QUIRKY_REQUIRED_TEST_INPUTS_ENV in src/main/quirkyd/quirkyd-node-slot-fixture.ts. */
export const REQUIRED_TEST_INPUTS_ENV = 'QUIRKY_REQUIRED_TEST_INPUTS'

// Need the pinned Bun and the last Bun quirkyd slot beside the built Node slot (design D7).
export const CROSS_RUNTIME_TEST_PATHS = [
  'src/main/quirkyd/quirkyd-cross-runtime-daemon-adoption.integration.test.ts',
  'src/main/persistence/profile-state/profile-state-cross-runtime.integration.test.ts'
]

// Need the built desktop server template; CI runs them by path after build-quirkyd-template.mjs.
export const TEMPLATE_TEST_PATHS = [
  'src/main/quirkyd/quirkyd-packaged-structured-chat.integration.test.ts'
]

export function nodeServerTestPaths({
  artifact = false,
  crossRuntime = false,
  template = false
} = {}) {
  return [
    'src/main/persistence/profile-state',
    'src/main/persistence/loading-store/profile-state',
    'src/main/sqlite',
    'src/main/quirkyd/quirkyd-entry.test.ts',
    // The quirkyd server's identity and stop path, which Windows SSH hosts rely on (W2).
    'src/main/quirkyd/quirkyd-instance-lock.test.ts',
    'src/main/quirkyd/quirkyd-process-start-time.test.ts',
    'src/main/quirkyd/quirkyd-stop-request-listener.test.ts',
    'src/main/quirkyd/quirkyd-managed-stop.test.ts',
    'src/main/quirkyd/quirkyd-managed-stop-cancellation.test.ts',
    'src/main/quirkyd/quirkyd-daemon-teardown-linux.test.ts',
    // The directory, not a prefix: its siblings are POSIX-host unit tests pr.yml already runs.
    'src/main/daemon/pty-subprocess/',
    'src/main/daemon/pty-subprocess-spawn-file-foreground.test.ts',
    'src/main/daemon/pty-subprocess-io-failure-native.test.ts',
    ...(artifact
      ? [
          'tests/e2e/daemon-running-work-probe.unit.test.ts',
          'src/shared/pty-running-work-probe.test.ts',
          'src/main/quirkyd/quirkyd-packaged-node-pty.integration.test.ts',
          'src/main/quirkyd/quirkyd-node-launcher.integration.test.ts',
          'src/main/quirkyd/quirkyd-cli-launcher.integration.test.ts',
          'src/main/quirkyd/quirkyd-cli-orchestration.integration.test.ts',
          'src/main/quirkyd/quirkyd-launcher-isolation.integration.test.ts',
          'src/main/quirkyd/quirkyd-stop-request-shutdown.integration.test.ts',
          'src/main/quirkyd/quirkyd-windows-conpty-breakaway.integration.test.ts',
          'src/main/quirkyd/quirkyd-serve-parity.integration.test.ts',
          'config/scripts/zip-extractor-command.test.mjs'
        ]
      : []),
    ...(crossRuntime ? CROSS_RUNTIME_TEST_PATHS : []),
    ...(template ? TEMPLATE_TEST_PATHS : [])
  ]
}
