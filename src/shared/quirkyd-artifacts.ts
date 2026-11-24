/**
 * What a packaged `quirkyd` directory must contain, declared once: the build, the content hash
 * and the remote install probe must not keep three lists that drift.
 *
 * Order is load-bearing: the hash concatenates these files in sequence.
 *
 * Keep this file erasable-only TypeScript — build-quirkyd.mjs imports it directly under
 * Node's type stripping, which rejects enums, namespaces and parameter properties.
 */
// Bun-era slots only: kept so a client can still launch one for rollback (design D7.1 R5).
export const QUIRKYD_BUN_RUNTIME_FILENAME = 'bun-runtime'
export const QUIRKYD_WINDOWS_BUN_RUNTIME_FILENAME = 'bun-runtime.exe'
export const QUIRKYD_BUILD_TARGET_FILENAME = '.build-target'
export const QUIRKYD_WINDOWS_PROCESS_TREE_FILENAME = 'windows-process-tree.node'
/** native/windows-security: secure-file ACLs without spawning icacls. */
export const QUIRKYD_WINDOWS_SECURITY_FILENAME = 'windows-security.node'
/** native/windows-cli-launcher: cmd.exe and .ps1 shims cannot carry every argv intact. */
export const QUIRKYD_WINDOWS_CLI_LAUNCHER_FILENAME = 'bin/quirky.exe'

export function quirkydBunRuntimeFilename(target: string): string {
  return isWindowsTarget(target)
    ? QUIRKYD_WINDOWS_BUN_RUNTIME_FILENAME
    : QUIRKYD_BUN_RUNTIME_FILENAME
}

function isWindowsTarget(target: string): boolean {
  return target === 'win32' || target.startsWith('win32-')
}

/** A Node slot's server target (e.g. linux-x64-musl); `.build-target` would mark it as Bun. */
export const QUIRKYD_SERVER_TARGET_FILENAME = '.server-target'

/**
 * Marks a slot launched by the pinned Node runtime; its content is that runtime's
 * executableSha256 (node-runtime-pin.ts), which is how the runtime enters the version hash.
 * A Node slot must never carry `.build-target`: Bun-era selectors exit 78 on `.build-target`
 * without `bun-runtime` (design D7.1 R5).
 */
export const QUIRKYD_NODE_RUNTIME_MARKER_FILENAME = '.runtime-node'
/** Beside the slot dirs and shared across Quirky versions (design D2): `runtimes/node-<sha256>/bin/node`. */
export const QUIRKYD_RUNTIMES_DIRNAME = 'runtimes'
export const QUIRKYD_NODE_RUNTIME_DIR_PREFIX = 'node-'
export const QUIRKYD_NODE_RUNTIME_POSIX_EXECUTABLE = 'bin/node'
// Upstream's own name and layout: renaming node.exe is the masquerading pattern EDR scores.
export const QUIRKYD_NODE_RUNTIME_WINDOWS_EXECUTABLE = 'node.exe'

export function quirkydNodeRuntimeExecutable(target: string): string {
  return isWindowsTarget(target)
    ? QUIRKYD_NODE_RUNTIME_WINDOWS_EXECUTABLE
    : QUIRKYD_NODE_RUNTIME_POSIX_EXECUTABLE
}

/** Slot-relative path segments of the runtime a slot's marker names. */
export function quirkydNodeRuntimeRelativePath(target: string, executableSha256: string): string[] {
  return [
    '..',
    QUIRKYD_RUNTIMES_DIRNAME,
    `${QUIRKYD_NODE_RUNTIME_DIR_PREFIX}${executableSha256}`,
    ...quirkydNodeRuntimeExecutable(target).split('/')
  ]
}

/** N-API level the slot addons are built for; equals SLOT_NAPI_VERSION in the prebuild script. */
export const QUIRKYD_ADDON_NAPI_VERSION = 8

export const QUIRKYD_NODE_PTY_DIR = 'node_modules/node-pty'
export const QUIRKYD_CLI_ENTRY_FILENAME = 'out/cli/index.js'
export const QUIRKYD_CLI_PACKAGE_FILENAME = 'out/package.json'
// Test files and sources stay out; these are every module the runtime path requires.
export const QUIRKYD_NODE_PTY_JS_ARTIFACTS = [
  'package.json',
  'lib/conpty_console_list_agent.js',
  'lib/eventEmitter2.js',
  'lib/index.js',
  'lib/interfaces.js',
  'lib/shared/conout.js',
  'lib/terminal.js',
  'lib/types.js',
  'lib/unixTerminal.js',
  'lib/utils.js',
  'lib/windowsConoutConnection.js',
  'lib/windowsPtyAgent.js',
  'lib/windowsTerminal.js',
  'lib/worker/conoutSocketWorker.js'
].map((file) => `${QUIRKYD_NODE_PTY_DIR}/${file}`)

/** The prebuild slot's files (config/scripts/quirkyd-prebuild-slot-contents.mjs), relative to build/Release. */
export function quirkydNodePtySlotFiles(target: string): string[] {
  if (isWindowsTarget(target)) {
    return [
      'conpty.node',
      'conpty_console_list.node',
      'conpty/conpty.dll',
      'conpty/OpenConsole.exe',
      // node-pty's winpty backend, which it selects below Windows build 18309.
      'pty.node',
      'winpty.dll',
      'winpty-agent.exe'
    ]
  }
  return target.startsWith('darwin-') ? ['pty.node', 'spawn-helper'] : ['pty.node']
}

export function quirkydNodePtyNativeArtifacts(target: string): string[] {
  return quirkydNodePtySlotFiles(target).map(
    (file) => `${QUIRKYD_NODE_PTY_DIR}/build/Release/${file}`
  )
}

export const QUIRKYD_PARCEL_WATCHER_ENTRY = 'node_modules/@parcel/watcher/index.js'
export const QUIRKYD_PARCEL_WATCHER_NATIVE = 'node_modules/@parcel/watcher/watcher.node'
export const QUIRKYD_EMOJI_SHORTCODE_DATASET =
  'node_modules/emojibase-data/en/shortcodes/emojibase.json'
// linear-sdk.ts loads it through createRequire, which the server bundle cannot follow.
export const QUIRKYD_LINEAR_SDK_ENTRY = 'node_modules/@linear/sdk/index.js'

export const QUIRKYD_VERSION = '0.1.0'
export const QUIRKYD_LAUNCHER_FILENAME = 'quirkyd.js'
export const QUIRKYD_SERVER_ENTRY_FILENAME = 'quirkyd-server.js'

// Equals FOREIGN_SQLITE_READER_ENTRY_FILENAME; that module is not loadable under type stripping.
export const QUIRKYD_FOREIGN_SQLITE_READER_ENTRY = 'foreign-sqlite-reader-entry.js'
/** Worker thread that runs workspace port detection's probe commands off the event loop. */
export const QUIRKYD_PORT_SCAN_COMMAND_WORKER_ENTRY = 'port-scan-command-worker-entry.js'
// Equals AI_VAULT_SERVICE_ENTRY_FILENAME: the forked child that lists agent sessions.
export const QUIRKYD_SESSION_SCANNER_SERVICE_ENTRY = 'session-scanner-service-entry.js'

// Kept here because build-quirkyd.mjs imports this manifest directly under Node type stripping.
export const QUIRKYD_RIPGREP_ARTIFACTS = [
  'ripgrep/linux-x64/rg',
  'ripgrep/linux-arm64/rg',
  'ripgrep/darwin-x64/rg',
  'ripgrep/darwin-arm64/rg',
  'ripgrep/win32-x64/rg.exe',
  'ripgrep/win32-arm64/rg.exe'
] as const

/** Only the target's own ripgrep ships (design D2); both libcs share one static build. */
export function quirkydRipgrepArtifact(target: string): string {
  const [platform, arch] = target.split('-')
  const artifact = QUIRKYD_RIPGREP_ARTIFACTS.find((candidate) =>
    candidate.startsWith(`ripgrep/${platform}-${arch}/`)
  )
  if (!artifact) {
    throw new Error(`quirkyd ships no ripgrep for ${target}`)
  }
  return artifact
}

/** Packaging-only references; deployed slots still contain their own verified binary. */
export function quirkydTemplatePackagedRipgrep(
  schemaVersion: number,
  target: string,
  reference: unknown
): string | null {
  if (reference === undefined) {
    return null
  }
  if (schemaVersion !== 4 || reference !== true || target.startsWith('darwin-')) {
    throw new Error(`Invalid packaged ripgrep reference for ${target}`)
  }
  return quirkydRipgrepArtifact(target)
}

export const QUIRKYD_RIPGREP_LICENSE_ARTIFACTS = [
  'ripgrep/licenses/JEMALLOC-COPYING',
  'ripgrep/licenses/LICENSE-MIT',
  'ripgrep/licenses/LLVM-LIBUNWIND-LICENSE.TXT',
  'ripgrep/licenses/MUSL-COPYRIGHT',
  'ripgrep/licenses/PCRE2-LICENCE.md',
  'ripgrep/licenses/README.md',
  'ripgrep/licenses/RUST-CRATE-NOTICES.txt',
  'ripgrep/licenses/SLJIT-LICENSE',
  'ripgrep/licenses/UNLICENSE'
] as const

/** The skill plugin native-chat agents load by path; mirrors resources/native-chat-visuals. */
export const QUIRKYD_NATIVE_CHAT_VISUALS_ARTIFACTS = [
  'native-chat-visuals/.claude-plugin/plugin.json',
  'native-chat-visuals/skills/quirky-chat-visuals/SKILL.md'
] as const

/**
 * The page phones load over mobileWeb.bundle.*, at the path getBundledMobileWebBundleRoot probes
 * under the install root. Its assets are content-addressed, so only its manifest names them.
 */
export const QUIRKYD_MOBILE_WEB_DIR = 'out/mobile-web'
export const QUIRKYD_MOBILE_WEB_MANIFEST = `${QUIRKYD_MOBILE_WEB_DIR}/manifest.json`

// Mirrors manifest-contract ASSET_PATH_PATTERN; cannot import under type stripping.
const MOBILE_WEB_ASSET_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/

/** A bundle-relative asset path that stays inside the page directory. */
export function isQuirkydMobileWebAssetPath(path: string): boolean {
  return (
    MOBILE_WEB_ASSET_PATH.test(path) &&
    !path.split('/').some((segment) => segment === '.' || segment === '..')
  )
}

/** Slot paths of every asset `manifestText` lists, sorted; throws rather than ship a partial page. */
export function quirkydMobileWebAssetFilenames(manifestText: string): string[] {
  const manifest: unknown = JSON.parse(manifestText)
  const assets =
    manifest && typeof manifest === 'object' && 'assets' in manifest ? manifest.assets : undefined
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error(`${QUIRKYD_MOBILE_WEB_MANIFEST} lists no assets`)
  }
  const filenames = assets.map((asset: unknown) => {
    const path = asset && typeof asset === 'object' && 'path' in asset ? asset.path : undefined
    if (typeof path !== 'string' || !isQuirkydMobileWebAssetPath(path)) {
      throw new Error(`${QUIRKYD_MOBILE_WEB_MANIFEST} names an unsafe asset path: ${String(path)}`)
    }
    return `${QUIRKYD_MOBILE_WEB_DIR}/${path}`
  })
  return filenames.sort(compareCodeUnits)
}

/** Code-unit order: page asset lists feed the install hash, so they must not depend on locale. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export type QuirkydArtifact = {
  filename: string
  /**
   * Absence is a degradation, not a torn install, so the remote probe must not require it.
   * The agent-browser binary is the only one: `resolveQuirkydBrowserProvider` already answers
   * "no headless browser" when it is missing, and it is named per platform-arch anyway.
   */
  optional?: boolean
}

export const QUIRKYD_ARTIFACTS: readonly QuirkydArtifact[] = [
  { filename: QUIRKYD_CLI_ENTRY_FILENAME },
  { filename: QUIRKYD_CLI_PACKAGE_FILENAME },
  { filename: QUIRKYD_LAUNCHER_FILENAME },
  { filename: QUIRKYD_SERVER_ENTRY_FILENAME },
  // Forked so a native @parcel/watcher fault kills the child, not the server.
  { filename: 'parcel-watcher-process-entry.js' },
  // Forked so PTYs outlive the runtime process; its absence makes every restart destructive.
  { filename: 'daemon-entry.js' },
  { filename: 'profile-state-writer-worker-entry.js' },
  { filename: 'profile-state-backup-worker-entry.js' },
  // Worker thread that reads other apps' SQLite (the OpenCode binder and history) off the event loop.
  { filename: QUIRKYD_FOREIGN_SQLITE_READER_ENTRY },
  { filename: QUIRKYD_PORT_SCAN_COMMAND_WORKER_ENTRY },
  // Forked so transcript parsing stays off the server's event loop; session search stays in-process.
  { filename: QUIRKYD_SESSION_SCANNER_SERVICE_ENTRY },
  // Worker threads the account services start: CLI probes off the event loop, Claude account setup.
  { filename: 'worker-thread-child-process-entry.js' },
  { filename: 'claude-profile-setup-worker-entry.js' },
  // Dictation's worker thread; it loads the recognizer `quirky serve` names (#31174).
  { filename: 'stt-worker.js' },
  // Target-specific even when the JavaScript bundle is shared across packaged slots.
  { filename: QUIRKYD_SERVER_TARGET_FILENAME },
  // quirkyd never depends on a host runtime or host-installed native module.
  { filename: QUIRKYD_NODE_RUNTIME_MARKER_FILENAME },
  { filename: QUIRKYD_PARCEL_WATCHER_ENTRY },
  { filename: QUIRKYD_PARCEL_WATCHER_NATIVE },
  { filename: QUIRKYD_EMOJI_SHORTCODE_DATASET },
  { filename: QUIRKYD_LINEAR_SDK_ENTRY },
  ...QUIRKYD_NODE_PTY_JS_ARTIFACTS.map((filename) => ({ filename })),
  ...QUIRKYD_RIPGREP_LICENSE_ARTIFACTS.map((filename) => ({ filename })),
  ...QUIRKYD_NATIVE_CHAT_VISUALS_ARTIFACTS.map((filename) => ({ filename })),
  // Without it phones paired to this server get no page (mobileWeb.bundle.v1 is not advertised).
  { filename: QUIRKYD_MOBILE_WEB_MANIFEST }
]

/** Written after the artifacts, so it is never an input to its own hash. */
export const QUIRKYD_VERSION_FILENAME = '.version'
export const QUIRKYD_TEMPLATE_MANIFEST_FILENAME = 'quirkyd-template.json'
export const QUIRKYD_TEMPLATE_TARGETS_DIR = 'targets'

/** Written last by the installer; its absence means a torn install. */
export const QUIRKYD_INSTALL_COMPLETE_FILENAME = '.install-complete'

/**
 * Every file a `target` slot ships, in hash order; `target` is `<os>-<arch>[-<libc>]`.
 * `mobileWebAssets` is quirkydMobileWebAssetFilenames of the slot's own page manifest.
 */
export function quirkydArtifactFilenames(
  target: string,
  mobileWebAssets: readonly string[]
): string[] {
  const filenames = QUIRKYD_ARTIFACTS.filter((artifact) => !artifact.optional).map(
    (artifact) => artifact.filename
  )
  filenames.push(...quirkydNodePtyNativeArtifacts(target), quirkydRipgrepArtifact(target))
  if (isWindowsTarget(target)) {
    filenames.push(
      QUIRKYD_WINDOWS_PROCESS_TREE_FILENAME,
      QUIRKYD_WINDOWS_SECURITY_FILENAME,
      QUIRKYD_WINDOWS_CLI_LAUNCHER_FILENAME
    )
  }
  filenames.push(...mobileWebAssets)
  return filenames
}

/** Files shared by every template target; the rest live under `targets/<target>/`. */
export function quirkydTemplateCommonFilenames(mobileWebAssets: readonly string[]): string[] {
  const filenames = QUIRKYD_ARTIFACTS.filter(
    (artifact) =>
      !artifact.optional &&
      artifact.filename !== QUIRKYD_SERVER_TARGET_FILENAME &&
      artifact.filename !== QUIRKYD_NODE_RUNTIME_MARKER_FILENAME &&
      artifact.filename !== QUIRKYD_PARCEL_WATCHER_NATIVE
  ).map((artifact) => artifact.filename)
  // The page is platform-independent, so the template keeps one copy for every target.
  filenames.push(...mobileWebAssets)
  return filenames
}

/** Files stored under the template's `targets/<target>/`, at their slot-relative paths. */
export function quirkydTemplateTargetFilenames(target: string): string[] {
  const common = new Set(quirkydTemplateCommonFilenames([]))
  return quirkydArtifactFilenames(target, []).filter((filename) => !common.has(filename))
}
