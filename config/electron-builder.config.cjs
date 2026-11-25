const { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join, resolve } = require('node:path')
const {
  MACOS_FOLDER_USAGE_DESCRIPTIONS,
  applyMacHelperFolderUsageDescriptions
} = require('./scripts/macos-folder-usage-descriptions.cjs')
const electronBuilderNativeRebuild = require('./scripts/electron-builder-native-rebuild.cjs')
const {
  assertPackagedDaemonEntryExists,
  verifyPackagedDaemonEntryBoots,
  verifyPackagedMacTerminalHostBoots
} = require('./scripts/verify-packaged-daemon-entry.cjs')
const {
  buildMacTerminalHost,
  macTerminalHostSignIgnore,
  verifyMacTerminalHost
} = require('./scripts/macos-terminal-host-bundle.cjs')
const {
  assertPackagedNativeVariantsInstalled,
  assertProcessHostOutputBuilt,
  createPackagedRuntimeNodeModuleResources,
  prunePackagedRuntimeNodeModules,
  verifyPackagedMainRuntimeDeps
} = require('./packaged-runtime-node-modules.cjs')
const { writeMacBuildCompatibility } = require('./scripts/mac-build-compatibility.cjs')
const {
  MOBILE_WEB_BUNDLE_DIR,
  assertMobileWebBundleBuilt
} = require('./scripts/verify-packaged-mobile-web-bundle.cjs')
const { verifyPackagedPluginResources } = require('./scripts/verify-packaged-plugin-resources.cjs')
const {
  assertPackagedServeSelectionEntry,
  assertPackagedWebClient
} = require('./scripts/verify-packaged-serve-payload.cjs')
const {
  assertBundledRipgrepInstalled,
  bundledRipgrepExtraResources,
  bundledRipgrepMacSignIgnore,
  finalizePackagedRipgrep
} = require('./bundled-ripgrep-resources.cjs')
const {
  assertQuirkydTemplateBuilt,
  finalizePackagedQuirkydTemplate,
  quirkydTemplateExtraResource,
  quirkydTemplateNodeModulesExtraResource,
  quirkydTemplateMacSignIgnore
} = require('./scripts/packaged-quirkyd-template.cjs')
const { verifySkillsCliRuntime } = require('./scripts/verify-skills-cli-runtime.cjs')
const { assertNotDarkBuild } = require('./dark-build-switches.cjs')
const { buildMacShipItScheduling } = require('./scripts/macos-shipit-scheduling.cjs')

const isMacRelease = process.env.QUIRKY_MAC_RELEASE === '1'
const localBuildVersion = isMacRelease ? undefined : process.env.QUIRKY_LOCAL_BUILD_VERSION
const appId = 'com.zpyoung.quirky'
const featureWallResources = {
  from: 'resources/onboarding/feature-wall',
  to: 'onboarding/feature-wall'
}
// Why: freshness detection needs immutable identity metadata from this exact
// app build, but never needs the skill package bytes or a runtime network read.
const skillFreshnessResources = {
  from: 'resources/skills',
  to: 'skills'
}
// Why a real directory: native-chat agents load this skill plugin by path (Claude --plugin-dir,
// Codex skill roots), and neither can read inside app.asar.
const nativeChatVisualsResource = {
  from: 'resources/native-chat-visuals',
  to: 'native-chat-visuals'
}
// Why: SSH relay deploy resolves bundles from process.resourcesPath in packaged
// apps. Keeping relay assets as extraResources makes them real directories
// instead of paths hidden inside app.asar.
const relayExtraResource = {
  from: 'out/relay',
  to: 'relay'
}
// Why: bundled plugins are immutable install inputs and must remain ordinary
// directories so the startup bootstrap can verify and publish exact bytes.
const bundledPluginResources = {
  from: 'resources/plugins/launch',
  to: 'plugins/launch'
}
// Why: the main bundle, packaged CLI, SSH paths, and speech worker all execute
// from package directories where pnpm's symlink farm is absent. Copy the exact
// runtime dependency closure to Resources/node_modules so bare require() calls
// do not fall through to a developer checkout's node_modules.
// Why the single file rather than the package root: app.asar carries no node_modules, so main's
// lazy require in deferred-emoji-shortcode-dataset.ts resolves only out of Resources/node_modules,
// but emojibase-data is 49 MB of locale datasets and worktree naming reads exactly this 166 KB file.
const emojiShortcodeDatasetResource = {
  from: 'node_modules/emojibase-data/en/shortcodes/emojibase.json',
  to: 'node_modules/emojibase-data/en/shortcodes/emojibase.json'
}
const commonExtraResources = [
  relayExtraResource,
  quirkydTemplateExtraResource,
  quirkydTemplateNodeModulesExtraResource,
  ...bundledRipgrepExtraResources,
  bundledPluginResources,
  skillFreshnessResources,
  nativeChatVisualsResource,
  emojiShortcodeDatasetResource
]
// Why: native speech addons must be real files outside app.asar; copy only the
// package matching the artifact target instead of every optional variant.
const macSpeechNativeResource = {
  from: 'node_modules/sherpa-onnx-darwin-${arch}',
  to: 'node_modules/sherpa-onnx-darwin-${arch}'
}
// Why mirrored, not imported: this config is CJS loaded by electron-builder outside the TS build.
// Keep in sync with isOsOpenedDocumentName() in src/main/startup/os-opened-documents.ts.
const MARKDOWN_FILE_EXTENSIONS = ['md', 'markdown', 'mdx']
const TABULAR_FILE_EXTENSIONS = ['csv', 'tsv']

// Shared with the terminal host helper so its purpose strings cannot drift from the app's.
const macUsageDescriptions = {
  NSAppleEventsUsageDescription:
    'Quirky allows terminal-launched developer tools to automate local apps when you request it.',
  NSBluetoothAlwaysUsageDescription:
    'Quirky allows terminal-launched developer tools to access Bluetooth devices when you request it.',
  NSBluetoothPeripheralUsageDescription:
    'Quirky allows terminal-launched developer tools to access Bluetooth devices when you request it.',
  NSCameraUsageDescription: "Application requests access to the device's camera.",
  NSLocationUsageDescription:
    'Quirky allows terminal-launched developer tools to access location when you request it.',
  NSLocalNetworkUsageDescription:
    'Quirky allows terminal-launched developer tools to discover and connect to local development servers when you request it.',
  NSMicrophoneUsageDescription: "Application requests access to the device's microphone.",
  NSAudioCaptureUsageDescription:
    'Quirky allows terminal-launched developer tools to capture desktop audio when you request it.',
  NSBonjourServices: ['_http._tcp', '_https._tcp'],
  ...MACOS_FOLDER_USAGE_DESCRIPTIONS
}
/** The Developer ID team the fork's release credentials sign with; a release build must name one. */
function readReleaseMacTeamId() {
  const teamId = process.env.APPLE_TEAM_ID?.trim()
  if (!teamId) {
    throw new Error('APPLE_TEAM_ID is required for a macOS release build.')
  }
  return teamId
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId,
  productName: 'Quirky',
  protocols: [{ name: 'Quirky', schemes: ['quirky'] }],
  ...(localBuildVersion ? { extraMetadata: { version: localBuildVersion } } : {}),
  directories: {
    buildResources: 'resources/build'
  },
  files: [
    '!**/.vscode/*',
    // Why: these repo-only inputs are either bundled into out/ or copied via
    // extraResources. Shipping them in app.asar bloats the desktop bundle.
    '!src{,/**/*}',
    '!out/quirkyd{,/**/*}',
    // Never in app.asar: the template ships via quirkydTemplateExtraResource; prebuilds are build inputs.
    '!out/quirkyd-*{,/**/*}',
    '!out/.quirkyd-*{,/**/*}',
    // Why: the pinned Node a local quirkyd build references (~120 MB) and its download cache.
    '!out/runtimes{,/**/*}',
    '!out/node-runtime-cache{,/**/*}',
    '!config{,/**/*}',
    // Release archives and other build staging are not runtime resources.
    '!.build{,/**/*}',
    // Worktree-local Vite dependency caches are development inputs.
    '!.cache/vite{,.lock}{,/**/*}',
    '!docs{,/**/*}',
    '!mobile{,/**/*}',
    '!native{,/**/*}',
    '!skills{,/**/*}',
    // Why: guide/stub authoring sources are compiled into runtime artifacts; shipping
    // either source tree would duplicate content without a runtime consumer.
    '!skill-guides{,/**/*}',
    '!skill-stubs{,/**/*}',
    '!tests{,/**/*}',
    // Why: examples/ is plugin authoring documentation with no runtime consumer —
    // bundled plugins ship via extraResources from resources/plugins/launch/. It also
    // carries hostile-panel, the adversarial fixture the containment tests point at,
    // which must never reach a user's install.
    '!examples{,/**/*}',
    // Why: pr-evidence/ is a local e2e screenshot output (QUIRKY_CAPTURE_EVIDENCE);
    // it is gitignored, but exclude it defensively so a stray local capture at
    // package time never bloats app.asar.
    '!pr-evidence{,/**/*}',
    // Local build logs and rollback copies are never application resources.
    '!notes{,/**/*}',
    // Why: local agent/tooling directories may contain worktree symlink loops;
    // they are never runtime inputs and must not be traversed by electron-builder.
    '!{.claude,.grok,.agents,.codex,.quirk,.anti-slop-plugin}{,/**/*}',
    '!Casks{,/**/*}',
    '!{AGENTS.md,CLAUDE.md,DEVELOPING.md,bundle-size-progress.md,ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md,ORCHESTRATION_STRUCTURED_OUTPUT_DESIGN.md}',
    '!out/**/*.test.js',
    // Why: main builds with sourcemap:'hidden' so release CI can publish maps
    // for decoding minified crash traces. The app never loads them (no
    // sourceMappingURL is emitted), and packing them would add ~34MB to app.asar.
    '!out/**/*.map',
    // Why: Vite's manifest is only used to project the paired web client.
    '!out/renderer/.vite{,/**/*}',
    // The installed browser serves its allowlisted assets from the unpacked renderer.
    '!out/web{,/**/*}',
    // Why: out/electron-dev caches `pnpm dev`'s per-branch Electron.app copies (~270MB each).
    // CI never creates it, but packaging on a machine that has run dev would pack them all.
    '!out/electron-dev{,/**/*}',
    // Why: relayExtraResource already ships out/relay to resources/relay, which is
    // the only path a packaged build resolves. Packing it again added 14MB and put
    // relay.js inside app.asar, so a script-heuristic verdict on relay.js took the
    // whole asar with it as a compound object and gutted the install (#20966, #20972).
    '!out/relay{,/**/*}',
    '!electron.vite.config.{js,ts,mjs,cjs}',
    '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,CHANGELOG.md,README.md}',
    '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
    '!tsconfig.json',
    // Why: feature-wall media is copied via extraResources so runtime can read
    // it from process.resourcesPath; exclude the source copy from app.asar.
    '!resources/onboarding/feature-wall/**',
    '!resources/skills/**',
    '!resources/native-chat-visuals/**',
    // Why: bundled plugins ship via extraResources to resources/plugins/launch;
    // packing the source tree into app.asar would duplicate those exact bytes.
    '!resources/plugins/launch/**',
    // Why: speech packages are copied selectively through the platform
    // extraResources entry below; keeping them in app.asar would ship every
    // native variant (and duplicate the selected one).
    '!node_modules/sherpa-onnx*{,/**/*}'
  ],
  // Why: the CLI entry-point lives in out/cli/ but imports shared modules
  // from out/shared/ and local hook mutators from out/main/. These paths must be
  // unpacked so that Node's require() can resolve the cross-directory imports
  // when the CLI runs outside the asar archive.
  // Why: daemon-entry.js is forked as a separate Node.js process and must be
  // accessible on disk (not inside the asar archive) for child_process.fork().
  // Why: the CLI is compiled by tsc (not bundled), so its runtime imports
  // resolve at runtime via Node's normal module lookup. The shim launches
  // the CLI with ELECTRON_RUN_AS_NODE, which bypasses Electron's asar
  // integration — dependencies inside the asar archive are invisible to
  // require(). Unpack CLI runtime deps so they resolve from
  // app.asar.unpacked/node_modules/.
  // Why: remote runtime connections use WebSocket + E2EE from the packaged CLI
  // before the GUI process starts, so those deps need the same treatment.
  // Why: out/package.json pins compiled output to CommonJS so parent
  // package.json files with type=module cannot change the packaged CLI loader.
  // Why: the foreign SQLite reader entry is also spawned by the scanner
  // service, which runs under ELECTRON_RUN_AS_NODE and so cannot see into
  // app.asar. Left packed, that spawn fails closed and every OpenCode session
  // disappears from Agent Session History in packaged builds only. Worker
  // entries reached solely from the Electron main process stay packed, since
  // asar redirects their app.asar paths.
  // Why: `quirky serve` runs the quirkyd selection entry under ELECTRON_RUN_AS_NODE too (#27307).
  // Why out/renderer and out/mobile-web: their assets are opened by path, and opening a packed file
  // reads a /tmp extract Electron makes once and never remakes, so a /tmp sweep broke them (#27976).
  asarUnpack: [
    'out/package.json',
    'out/cli/**',
    'out/shared/**',
    'out/main/agent-hooks/**',
    'out/main/antigravity/**',
    'out/main/claude/**',
    'out/main/codex/**',
    'out/main/copilot/**',
    'out/main/cursor/**',
    'out/main/droid/**',
    'out/main/gemini/**',
    'out/main/gitlab/project-ref-parser.js',
    'out/main/grok/**',
    'out/main/hermes/**',
    'out/main/asar-transparent-fs.js',
    'out/main/macos-tree-clone.js',
    'out/main/quirky-profiles/profile-index-store.js',
    'out/main/persistence/profile-state/**',
    'out/main/startup/http1-compatibility-marker.js',
    'out/main/daemon-entry.js',
    'out/main/session-scanner-service-entry.js',
    'out/main/foreign-sqlite-reader-entry.js',
    'out/main/plugin-host-entry.js',
    'out/main/computer-sidecar.js',
    'out/main/parcel-watcher-process-entry.js',
    'out/main/quirkyd/quirkyd-local-serve-selection-entry.js',
    'out/main/chunks/**',
    'out/renderer/**',
    'out/mobile-web/**',
    'resources/**',
    'node_modules/ws/**',
    'node_modules/tweetnacl/**',
    'node_modules/zod/**',
    'node_modules/yaml/**'
  ],
  // electron-builder calls this with the context alone. The second parameter is the bundle root,
  // so a test can point the guard at a scratch bundle instead of needing the repo's out/ built.
  beforePack: (
    context,
    mobileWebBundleDir = MOBILE_WEB_BUNDLE_DIR,
    quirkydTemplateDir = join(__dirname, '..', quirkydTemplateExtraResource.from)
  ) => {
    // The template is the server every SSH host gets, so a dark test template must never ship.
    assertNotDarkBuild([
      join(__dirname, '..', 'out', 'main'),
      mobileWebBundleDir,
      quirkydTemplateDir
    ])
    assertPackagedNativeVariantsInstalled(context.electronPlatformName, context.arch)
    assertBundledRipgrepInstalled()
    assertProcessHostOutputBuilt()
    assertQuirkydTemplateBuilt()
    assertMobileWebBundleBuilt(mobileWebBundleDir)
  },
  afterPack: async (context) => {
    const resourcesDir =
      context.electronPlatformName === 'darwin'
        ? join(
            context.appOutDir,
            `${context.packager.appInfo.productFilename}.app`,
            'Contents',
            'Resources'
          )
        : join(context.appOutDir, 'resources')
    if (!existsSync(resourcesDir)) {
      throw new Error(`Missing packaged resources directory: ${resourcesDir}`)
    }
    if (context.electronPlatformName === 'darwin') {
      applyMacHelperFolderUsageDescriptions(
        join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
        context.packager.appInfo.productFilename
      )
      const architecture = macSliceArch(context.arch, 'local-build compatibility')
      const schedulingAddon = buildMacShipItScheduling(resourcesDir, architecture)
      await signMacStandaloneHelper(schedulingAddon, 'ShipIt scheduling', context.packager)
      const version = context.packager.appInfo.version
      let commit = process.env.QUIRKY_BUILD_COMMIT || process.env.GITHUB_SHA || 'unknown'
      if (commit === 'unknown') {
        try {
          commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
            encoding: 'utf8'
          }).trim()
        } catch {
          // Source archives can still produce a signed build with an explicit version.
        }
      }
      writeMacBuildCompatibility(resourcesDir, { version, commit, architecture })
    }
    stampPackagedCliVersion(resourcesDir, context.packager.appInfo.version)
    prunePackagedRuntimeNodeModules(resourcesDir, context.electronPlatformName, context.arch)
    verifyPackagedMainRuntimeDeps(resourcesDir)
    // Why: boot the packaged daemon-entry under plain Node, but only for the
    // slice matching the packaging host's arch — daemon-entry.js is JS, yet it
    // require()s the native (N-API) node-pty for the TARGET arch, which the host
    // Node cannot load cross-arch. `Arch` enum: ia32=0, x64=1, armv7l=2,
    // arm64=3, universal=4 (universal contains the host slice, so run it).
    const archEnumByNodeArch = { ia32: 0, x64: 1, armv7l: 2, arm64: 3 }
    const hostArchEnum = archEnumByNodeArch[process.arch]
    const canExecuteTargetArch = context.arch === hostArchEnum || context.arch === 4
    verifySkillsCliRuntime(join(resourcesDir, 'app.asar.unpacked', 'out'), resourcesDir, {
      executeCommands: canExecuteTargetArch
    })
    if (!canExecuteTargetArch) {
      console.log(
        `[verify-skills-cli-runtime] skipped command probes on cross-arch slice (target ${context.arch}, host ${process.arch})`
      )
    }
    if (canExecuteTargetArch) {
      verifyPackagedDaemonEntryBoots(resourcesDir)
    } else {
      // Why: a cross-arch slice can't be booted by the host Node, but the
      // unpacked entry must still exist — its absence is a layout regression
      // regardless of arch, so only the boot is skipped, not the check.
      assertPackagedDaemonEntryExists(resourcesDir)
      console.log(
        `[verify-packaged-daemon-entry] skipped boot on cross-arch slice (target ${context.arch}, host ${process.arch})`
      )
    }
    // Why: inspect electron-builder's real output so a broken extraResources
    // mapping fails packaging before bundled content reaches users.
    verifyPackagedPluginResources(resourcesDir)
    assertPackagedWebClient(resourcesDir)
    assertPackagedServeSelectionEntry(resourcesDir)
    finalizePackagedRipgrep(resourcesDir)
    await finalizePackagedQuirkydTemplate(resourcesDir, {
      platform: context.electronPlatformName,
      signMacBinary: (path) =>
        signMacStandaloneHelper(path, 'quirkyd template binary', context.packager)
    })
    chmodUnixCliLaunchers(resourcesDir)
    for (const filename of readdirSync(resourcesDir)) {
      if (!filename.startsWith('agent-browser-')) {
        continue
      }
      // Why: the upstream package has inconsistent executable bits across
      // platform binaries (notably darwin-x64). child_process.execFile needs
      // the copied binary to be executable in packaged apps.
      chmodSync(join(resourcesDir, filename), 0o755)
    }
    if (context.electronPlatformName === 'darwin') {
      await signMacComputerUseHelper(
        join(resourcesDir, 'Quirky Computer Use.app'),
        context.packager
      )
      await signMacStandaloneHelper(
        join(resourcesDir, '..', 'MacOS', 'quirky-notification-status'),
        'quirky-notification-status',
        context.packager
      )
      await signMacStandaloneHelper(
        join(resourcesDir, '..', 'MacOS', 'quirky-keyboard-layout'),
        'quirky-keyboard-layout',
        context.packager
      )
      await packageMacTerminalHost(join(resourcesDir, '..', '..'), context)
    }
  },
  mac: {
    // Why rank Alternate: Quirky joins Finder's "Open With" list without claiming
    // LSHandlerRank ownership, so whichever editor the user already prefers stays the default.
    // Why one entry per extension: app-builder-lib globs `*.${ext}`, which an array would break.
    fileAssociations: [
      ...MARKDOWN_FILE_EXTENSIONS.map((ext) => ({
        ext,
        name: 'Markdown Document',
        description: 'Markdown Document',
        role: 'Editor',
        rank: 'Alternate'
      })),
      ...TABULAR_FILE_EXTENSIONS.map((ext) => ({
        ext,
        name: `${ext.toUpperCase()} Document`,
        description: `${ext.toUpperCase()} Document`,
        role: 'Editor',
        rank: 'Alternate'
      }))
    ],
    icon: 'resources/build/icon.icns',
    entitlements: 'resources/build/entitlements.mac.plist',
    entitlementsInherit: 'resources/build/entitlements.mac.plist',
    ...(isMacRelease ? { sign: resolve(__dirname, 'scripts/sign-mac-app.mjs') } : {}),
    signIgnore: [
      ...bundledRipgrepMacSignIgnore,
      ...quirkydTemplateMacSignIgnore,
      ...macTerminalHostSignIgnore
    ],
    extendInfo: macUsageDescriptions,
    // Why: local macOS validation builds should launch without Apple release
    // credentials. Hardened runtime + notarization stay enabled only on the
    // explicit release path so production artifacts remain strict while dev
    // artifacts do not fail with broken ad-hoc launch behavior.
    hardenedRuntime: isMacRelease,
    notarize: isMacRelease,
    extraResources: [
      ...commonExtraResources,
      ...createPackagedRuntimeNodeModuleResources('darwin'),
      macSpeechNativeResource,
      {
        from: 'resources/darwin/bin/quirky',
        to: 'bin/quirky'
      },
      {
        from: 'node_modules/agent-browser/bin/agent-browser-darwin-${arch}',
        to: 'agent-browser-darwin-${arch}'
      },
      {
        from: 'native/computer-use-macos/.build/release/Quirky Computer Use.app',
        to: 'Quirky Computer Use.app'
      },
      featureWallResources
    ],
    // Why: the notification-status helper must execute from Contents/MacOS —
    // on macOS 26 UNUserNotificationCenter aborts (bundleProxyForCurrentProcess
    // is nil) for executables launched out of Contents/Resources (#7929).
    extraFiles: [
      {
        from: 'native/notification-status-macos/.build/release/quirky-notification-status',
        to: 'MacOS/quirky-notification-status'
      },
      {
        from: 'native/keyboard-layout-macos/.build/release/quirky-keyboard-layout',
        to: 'MacOS/quirky-keyboard-layout'
      }
    ],
    // Fork: arm64 only. Each arch is a separate ~40min notarization submission,
    // so dual-arch put the mac job past any workable timeout; no fork machine
    // runs Intel, and dropping x64 also sidesteps the cross-arch packaging
    // hazard described above.
    target: [
      {
        target: 'dmg',
        arch: ['arm64']
      },
      {
        target: 'zip',
        arch: ['arm64']
      }
    ]
  },
  // Why: release builds should fail if signing is unavailable instead of
  // silently downgrading to ad-hoc artifacts that look shippable in CI logs.
  forceCodeSigning: isMacRelease,
  dmg: {
    artifactName: 'quirky-macos-${arch}.${ext}'
  },
  beforeBuild: electronBuilderNativeRebuild,
  // Why: must be true so that electron-builder rebuilds native modules
  // (node-pty) for each target architecture when producing dual-arch macOS
  // builds (x64 + arm64). With npmRebuild disabled, CI on an arm64 runner
  // packages arm64 binaries into the x64 DMG, causing "posix_spawnp failed"
  // on Intel Macs. The beforeBuild hook performs Quirky's targeted rebuild and
  // returns false so electron-builder does not rebuild optional cpu-features.
  npmRebuild: true,
  publish: {
    provider: 'github',
    owner: 'zpyoung',
    repo: 'quirky',
    // Why draft on the main repo: `--publish always` otherwise creates a
    // public GitHub release as soon as the first platform uploads, and
    // /releases/latest serves a missing asset. release-cut undrafts
    // only after every required asset exists.
    releaseType: 'draft'
  }
}

// Stamp the effective channel version where node-mode CLI code can read it.
function stampPackagedCliVersion(resourcesDir, version) {
  const packageJsonPath = join(resourcesDir, 'app.asar.unpacked', 'out', 'package.json')
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Missing unpacked CLI package boundary: ${packageJsonPath}`)
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  writeFileSync(packageJsonPath, `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`)
}

function chmodUnixCliLaunchers(resourcesDir) {
  for (const launcherName of ['quirky', 'quirky-ide']) {
    const launcherPath = join(resourcesDir, 'bin', launcherName)
    if (!existsSync(launcherPath)) {
      continue
    }
    // Why: packaged Unix installs expose these extraResources as public shell
    // commands, and source/packager mode drift must not ship a non-executable CLI.
    chmodSync(launcherPath, 0o755)
  }
}

async function signMacComputerUseHelper(helperAppPath, packager) {
  if (!existsSync(helperAppPath)) {
    if (isMacRelease) {
      throw new Error(`Missing Quirky Computer Use helper app at ${helperAppPath}`)
    }
    return
  }
  const codeSigningInfo =
    isMacRelease && process.env.CSC_LINK && packager?.codeSigningInfo?.value
      ? await packager.codeSigningInfo.value
      : null
  const identity =
    process.env.QUIRKY_COMPUTER_MACOS_SIGN_IDENTITY ??
    process.env.CSC_NAME ??
    findInstalledMacSigningIdentity(codeSigningInfo?.keychainFile) ??
    (isMacRelease ? null : '-')
  if (!identity) {
    throw new Error('Missing signing identity for Quirky Computer Use helper app')
  }
  // Why: TCC grants attach to this nested app's code identity. Sign it before
  // the outer Quirky.app is sealed so production builds preserve that identity.
  execFileSync('codesign', codesignArgs(identity, helperAppPath), { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', helperAppPath], {
    stdio: 'inherit'
  })
}

// electron-builder `Arch` enum: x64=1, arm64=3. A universal (4) slice has no single arch.
function macSliceArch(archEnum, purpose) {
  const arch = { 1: 'x64', 3: 'arm64' }[archEnum]
  if (!arch) {
    throw new Error(`Unsupported ${purpose} architecture: ${archEnum}`)
  }
  return arch
}

// Why after the node_modules prune: the helper copies this slice's node-pty.
async function packageMacTerminalHost(appPath, context) {
  const arch = macSliceArch(context.arch, 'macOS terminal host')
  await buildMacTerminalHost({
    appPath,
    arch,
    iconPath: resolve(__dirname, '../resources/build/icon.icns'),
    entitlementsPath: resolve(__dirname, '../resources/build/entitlements.mac.plist'),
    usageDescriptions: macUsageDescriptions,
    signCode: (path, { entitlements }) =>
      signMacStandaloneHelper(path, 'terminal host', context.packager, entitlements)
  })
  // Only a local build may skip a slice this host cannot run; a shipped slice must serve a PTY.
  await verifyPackagedMacTerminalHostBoots(appPath, {
    arch,
    required: isMacRelease || process.env.CI === 'true'
  })
  await verifyMacTerminalHost({
    appPath,
    arch,
    usageDescriptions: macUsageDescriptions,
    expectedTeamId: isMacRelease ? readReleaseMacTeamId() : null
  })
}

async function signMacStandaloneHelper(helperPath, helperName, packager, entitlements) {
  if (!existsSync(helperPath)) {
    if (isMacRelease) {
      throw new Error(`Missing ${helperName} helper at ${helperPath}`)
    }
    return
  }
  const codeSigningInfo =
    isMacRelease && process.env.CSC_LINK && packager?.codeSigningInfo?.value
      ? await packager.codeSigningInfo.value
      : null
  const identity =
    process.env.CSC_NAME ??
    findInstalledMacSigningIdentity(codeSigningInfo?.keychainFile) ??
    (isMacRelease ? null : '-')
  if (!identity) {
    throw new Error(`Missing signing identity for ${helperName} helper`)
  }
  // Why: nested executables must be signed before the outer app bundle is sealed.
  const args = ['--force', '--sign', identity]
  if (isMacRelease) {
    args.push('--options', 'runtime', '--timestamp')
  }
  if (entitlements) {
    args.push('--entitlements', entitlements)
  }
  args.push(helperPath)
  execFileSync('codesign', args, { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--strict', helperPath], { stdio: 'inherit' })
}

function codesignArgs(identity, targetPath) {
  const args = ['--force', '--deep', '--sign', identity]
  if (isMacRelease) {
    args.push(
      '--options',
      'runtime',
      '--timestamp',
      '--entitlements',
      resolve(__dirname, '../resources/build/entitlements.computer-use.mac.plist')
    )
  }
  args.push(targetPath)
  return args
}

function findInstalledMacSigningIdentity(keychainFile) {
  try {
    const output = execFileSync(
      'security',
      ['find-identity', '-v', '-p', 'codesigning', ...(keychainFile ? [keychainFile] : [])],
      {
        encoding: 'utf8'
      }
    )
    const releaseMatch =
      output.match(/"([^"]*Developer ID Application:[^"]+)"/) ??
      output.match(/"([^"]*Apple Distribution:[^"]+)"/)
    if (releaseMatch?.[1]) {
      return releaseMatch[1]
    }
    if (!isMacRelease) {
      return output.match(/"([^"]*Apple Development:[^"]+)"/)?.[1] ?? null
    }
  } catch {}
  return null
}
