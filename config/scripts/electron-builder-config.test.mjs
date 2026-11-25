import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { writeMobileWebBundleFixtureTree } from './mobile-web-bundle-fixture-tree.mjs'

const REPO_ROOT = join(import.meta.dirname, '..', '..')

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const { copyFiles, FileMatcher } = require('app-builder-lib/out/fileMatcher')
const electronBuilderNativeRebuild = require('./electron-builder-native-rebuild.cjs')

describe('electron-builder config', () => {
  it('keeps the packaged app identity aligned with local-build validation', () => {
    expect(electronBuilderConfig.appId).toBe(
      require('../../src/shared/local-build-compatibility-contract.json').appId
    )
  })

  it('excludes repo-only source trees from app.asar', () => {
    expect(electronBuilderConfig.files).toEqual(
      expect.arrayContaining([
        '!src{,/**/*}',
        '!config{,/**/*}',
        '!docs{,/**/*}',
        '!mobile{,/**/*}',
        '!native{,/**/*}',
        '!skills{,/**/*}',
        '!skill-guides{,/**/*}',
        '!skill-stubs{,/**/*}',
        '!resources/skills/**',
        '!tests{,/**/*}',
        '!examples{,/**/*}',
        '!pr-evidence{,/**/*}',
        '!notes{,/**/*}',
        '!{.claude,.grok,.agents,.codex,.quirk,.anti-slop-plugin}{,/**/*}',
        '!Casks{,/**/*}',
        '!{AGENTS.md,CLAUDE.md,DEVELOPING.md,bundle-size-progress.md,ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md,ORCHESTRATION_STRUCTURED_OUTPUT_DESIGN.md}',
        '!out/**/*.test.js',
        '!resources/plugins/launch/**'
      ])
    )
  })

  it('keeps release build staging out of app.asar while preserving runtime output', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    expect(isPacked(join('/app', '.build'), { isDirectory: () => true })).toBe(false)
    for (const stagingPath of [
      '.build/release-javascript/release-javascript.tar.gz',
      '.build/release-javascript/manifest.json',
      '.build/release-javascript-123/out/main/index.js'
    ]) {
      expect(isPacked(join('/app', stagingPath), { isDirectory: () => false })).toBe(false)
    }
    for (const runtimePath of [
      'out/main/index.js',
      'out/cli/index.js',
      'out/renderer/index.html'
    ]) {
      expect(isPacked(join('/app', runtimePath), { isDirectory: () => false })).toBe(true)
    }
  })

  it('keeps local agent tooling out of app.asar', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    const packs = (repoPath) => isPacked(join('/app', repoPath), { isDirectory: () => false })

    for (const toolingPath of [
      '.grok/skills/review-and-submit/review-and-submit/SKILL.md',
      '.claude/skills/review-and-submit/review-and-submit/SKILL.md',
      '.agents/skills/electron/SKILL.md',
      '.codex/sessions/session.json'
    ]) {
      expect(packs(toolingPath)).toBe(false)
    }
    expect(packs('out/main/index.js')).toBe(true)
    expect(packs('out/web/web-index.html')).toBe(false)
    expect(packs('out/web/assets/shared.js')).toBe(false)
    expect(packs('out/renderer/web-index.html')).toBe(true)
    expect(packs('out/renderer/.quirky-web-client-files.json')).toBe(true)
  })

  it.each(['file', 'directory'])('keeps a root notes %s out of app.asar', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'quirky-packaging-notes-'))
    const source = join(root, 'app')
    const destination = join(root, 'selected')
    const runtimePaths = [
      'package.json',
      'out/main/index.js',
      'out/renderer/index.html',
      'out/cli/index.js',
      'out/shared/index.js',
      'out/main/notes/index.js',
      'out/renderer/assets/notes/help.md',
      'resources/notes/help.md',
      'notes.txt'
    ]
    const notesPaths =
      kind === 'file'
        ? ['notes']
        : [
            'notes/build.log',
            'notes/installed-quirky-backup/Quirky.exe',
            'notes/installed-quirky-backup/resources/app.asar',
            'notes/quirky-windows-setup.exe',
            'notes/.recovery/state.json'
          ]
    try {
      for (const fixturePath of [...runtimePaths, ...notesPaths]) {
        const file = join(source, fixturePath)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, 'synthetic fixture\n')
      }
      if (kind === 'directory') {
        await mkdir(join(source, 'notes', 'empty'))
      }
      const matcher = new FileMatcher(
        source,
        destination,
        (value) => value,
        electronBuilderConfig.files
      )
      // copyFiles adds the default include and prunes excluded directories during traversal.
      await copyFiles([matcher])
      for (const runtimePath of runtimePaths) {
        expect(await readFile(join(destination, runtimePath), 'utf8')).toBe('synthetic fixture\n')
      }
      const isPacked = matcher.createFilter()
      for (const notesPath of new Set(['notes', ...notesPaths])) {
        const file = join(source, notesPath)
        expect(isPacked(file, await lstat(file)), notesPath).toBe(false)
      }
      expect(existsSync(join(destination, 'notes'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // Why: `files` is an all-negation list, so electron-builder's default `**/*` packs
  // anything without an explicit `!` entry — examples/ landed without one and shipped
  // hostile-panel, the adversarial containment fixture, into 1.4.160-rc.3's app.asar.
  // Drive the real matcher: pinning the pattern string cannot prove it excludes the tree.
  it('keeps plugin authoring examples out of app.asar', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    // copyFiles() prepends this itself once the pattern list is all-negation.
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    const packs = (repoPath) => isPacked(join('/app', repoPath), { isDirectory: () => false })

    for (const authoringOnly of [
      'examples/plugins/hostile-panel/panel.html',
      'examples/plugins/hostile-panel/quirky-plugin.json',
      'examples/plugins/hello-quirky/main.mjs',
      'examples/plugins/hello-quirky/quirky-plugin.json'
    ]) {
      expect(packs(authoringOnly)).toBe(false)
    }
    // The negation stays anchored at the app root, so nested `examples` segments still ship.
    expect(packs('out/main/examples/index.js')).toBe(true)
  })

  // Why: out/electron-dev holds `pnpm dev`'s cached Electron.app copies (~270MB per branch).
  // CI never creates it, so only a local package would have hit this -- silently, as bulk.
  it('keeps cached dev Electron bundles and Vite dependencies out of app.asar', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    const packs = (repoPath) => isPacked(join('/app', repoPath), { isDirectory: () => false })

    for (const devBundlePath of [
      'out/electron-dev/1a2b3c4d5e6f/Quirky: dev.app/Contents/MacOS/Electron',
      'out/electron-dev/1a2b3c4d5e6f/quirky-dev-electron-app.json',
      '.cache/vite/renderer/deps/react.js',
      '.cache/vite/web/deps/react.js',
      '.cache/vite.lock/owner'
    ]) {
      expect(packs(devBundlePath)).toBe(false)
    }
    // The real build outputs sit beside it under out/ and must still ship.
    expect(packs('out/main/index.js')).toBe(true)
    expect(packs('out/renderer/index.html')).toBe(true)
  })

  // Why: an AV verdict on the bundled relay.js used to take app.asar with it as a
  // compound object, gutting the install (#20966). resources/relay is the only copy
  // a packaged build resolves, so the asar copy was 14MB of pure blast radius.
  it('keeps the relay bundles out of app.asar and ships them only through extraResources', () => {
    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    const packs = (repoPath) => isPacked(join('/app', repoPath), { isDirectory: () => false })

    for (const relayPath of [
      'out/relay/linux-x64/relay.js',
      'out/relay/darwin-arm64/relay-watcher.js'
    ]) {
      expect(packs(relayPath)).toBe(false)
    }

    for (const platform of ['mac']) {
      expect(electronBuilderConfig[platform].extraResources).toContainEqual({
        from: 'out/relay',
        to: 'relay'
      })
    }
  })

  it('keeps runtime resources available through extraResources', () => {
    const bundledPluginResources = expect.objectContaining({
      from: 'resources/plugins/launch',
      to: 'plugins/launch'
    })
    for (const platform of ['mac']) {
      expect(electronBuilderConfig[platform].extraResources).toContainEqual({
        from: 'resources/skills',
        to: 'skills'
      })
      expect(electronBuilderConfig[platform].extraResources).toEqual(
        expect.arrayContaining([bundledPluginResources])
      )
    }
    expect(electronBuilderConfig.mac.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/computer-use-macos/.build/release/Quirky Computer Use.app',
          to: 'Quirky Computer Use.app'
        })
      ])
    )
  })

  it('ships one macOS serve-sim package through the runtime closure', () => {
    const serveSimResources = electronBuilderConfig.mac.extraResources.filter((resource) =>
      [join('node_modules', 'serve-sim'), 'serve-sim'].includes(resource.to)
    )

    expect(serveSimResources).toEqual([
      expect.objectContaining({ to: join('node_modules', 'serve-sim') })
    ])
  })

  it.each(['mac'])('loads Codex TOML parsing after %s runtime pruning', async (platform) => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'quirky-packaged-codex-toml-'))
    try {
      const resource = electronBuilderConfig[platform].extraResources.find(
        (entry) => entry.to === join('node_modules', 'smol-toml')
      )
      expect(resource).toBeDefined()
      await copyFiles([
        new FileMatcher(resource.from, join(resourcesDir, resource.to), (value) => value)
      ])
      require('../packaged-runtime-node-modules.cjs').prunePackagedRuntimeNodeModules(
        resourcesDir,
        platform === 'mac' ? 'darwin' : 'linux',
        process.arch
      )
      const stagedRequire = createRequire(join(resourcesDir, 'out', 'main', 'codex', 'trust.cjs'))
      expect(await realpath(stagedRequire.resolve('smol-toml'))).toBe(
        await realpath(join(resourcesDir, resource.to, 'dist', 'index.cjs'))
      )
      const { parse } = stagedRequire('smol-toml')
      expect(parse('[projects."/workspace"]\ntrust_level = "trusted"\n')).toEqual({
        projects: { '/workspace': { trust_level: 'trusted' } }
      })
    } finally {
      await rm(resourcesDir, { recursive: true, force: true })
    }
  })

  // Why: on macOS 26 UNUserNotificationCenter aborts for executables launched
  // from Contents/Resources, so the helper must ship in Contents/MacOS (#7929).
  it('ships the mac notification-status helper in Contents/MacOS, not Resources', () => {
    expect(electronBuilderConfig.mac.extraFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/notification-status-macos/.build/release/quirky-notification-status',
          to: 'MacOS/quirky-notification-status'
        })
      ])
    )
    expect(electronBuilderConfig.mac.extraResources).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ to: 'quirky-notification-status' })])
    )
  })

  it('ships the mac keyboard-layout helper in Contents/MacOS, not Resources', () => {
    expect(electronBuilderConfig.mac.extraFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'native/keyboard-layout-macos/.build/release/quirky-keyboard-layout',
          to: 'MacOS/quirky-keyboard-layout'
        })
      ])
    )
    expect(electronBuilderConfig.mac.extraResources).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ to: 'quirky-keyboard-layout' })])
    )
  })

  it('unpacks the compiled CommonJS boundary with CLI runtime files', () => {
    expect(electronBuilderConfig.asarUnpack).toEqual(
      expect.arrayContaining(['out/package.json', 'out/cli/**', 'out/shared/**'])
    )
  })

  // Why: without the unpacked entry the watcher client silently falls back to
  // in-process @parcel/watcher, reintroducing the #7547 main-process crash.
  it('unpacks the forked parcel-watcher process entry', () => {
    expect(electronBuilderConfig.asarUnpack).toEqual(
      expect.arrayContaining(['out/main/parcel-watcher-process-entry.js'])
    )
  })

  // Why: the CLI runs this entry under ELECTRON_RUN_AS_NODE, which cannot read
  // app.asar, so a packed copy sends every `quirky serve` to Electron (#27307).
  it('unpacks the quirkyd serve-selection entry the CLI runs', async () => {
    const sharedSource = await readFile(
      join(REPO_ROOT, 'src', 'shared', 'quirkyd-local-serve-selection.ts'),
      'utf8'
    )
    const entryName = sharedSource.match(/QUIRKYD_LOCAL_SERVE_SELECTION_ENTRY = '([^']+)'/)?.[1]
    expect(entryName).toBeDefined()

    const matcher = new FileMatcher(
      '/app',
      '/dest',
      (value) => value,
      electronBuilderConfig.asarUnpack
    )
    const isUnpacked = matcher.createFilter()
    expect(
      isUnpacked(join('/app', 'out', 'main', `${entryName}.js`), { isDirectory: () => false })
    ).toBe(true)
  })

  // Why: opening a packed file reads a one-time /tmp extract; once a /tmp sweep removes it, the
  // web client answers an empty 500 and phone bundle reads fail until restart (#27976).
  it('unpacks the web and mobile bundles a host serves by opening their files', () => {
    const matcher = new FileMatcher(
      '/app',
      '/dest',
      (value) => value,
      electronBuilderConfig.asarUnpack
    )
    const isUnpacked = matcher.createFilter()
    for (const webPath of [
      'out/renderer/web-index.html',
      'out/renderer/assets/index-abc123.js',
      'out/renderer/.quirky-web-client-files.json',
      'out/mobile-web/manifest.json',
      'out/mobile-web/assets/index-abc123.js'
    ]) {
      expect(isUnpacked(join('/app', webPath), { isDirectory: () => false })).toBe(true)
    }
  })

  it('keeps the worker-thread hang watchdog inside app.asar', () => {
    expect(electronBuilderConfig.asarUnpack).not.toContain(
      'out/main/main-thread-hang-watchdog-entry.js'
    )
  })

  it('overrides packaged semver only for local macOS builds', () => {
    const configPath = require.resolve('../electron-builder.config.cjs')
    const original = process.env.QUIRKY_LOCAL_BUILD_VERSION
    const originalMacRelease = process.env.QUIRKY_MAC_RELEASE
    try {
      delete require.cache[configPath]
      delete process.env.QUIRKY_MAC_RELEASE
      process.env.QUIRKY_LOCAL_BUILD_VERSION = '1.4.159-rc.0.local.123.abc'
      expect(require('../electron-builder.config.cjs').extraMetadata).toEqual({
        version: '1.4.159-rc.0.local.123.abc'
      })
    } finally {
      if (originalMacRelease === undefined) {
        delete process.env.QUIRKY_MAC_RELEASE
      } else {
        process.env.QUIRKY_MAC_RELEASE = originalMacRelease
      }
      if (original === undefined) {
        delete process.env.QUIRKY_LOCAL_BUILD_VERSION
      } else {
        process.env.QUIRKY_LOCAL_BUILD_VERSION = original
      }
      delete require.cache[configPath]
      require('../electron-builder.config.cjs')
    }
  })

  it('never applies local semver to release packaging', () => {
    const configPath = require.resolve('../electron-builder.config.cjs')
    const originalLocalVersion = process.env.QUIRKY_LOCAL_BUILD_VERSION
    const originalMacRelease = process.env.QUIRKY_MAC_RELEASE
    try {
      delete require.cache[configPath]
      process.env.QUIRKY_LOCAL_BUILD_VERSION = '1.4.159-local.123.abc'
      process.env.QUIRKY_MAC_RELEASE = '1'
      expect(require('../electron-builder.config.cjs').extraMetadata).toBeUndefined()
    } finally {
      if (originalLocalVersion === undefined) {
        delete process.env.QUIRKY_LOCAL_BUILD_VERSION
      } else {
        process.env.QUIRKY_LOCAL_BUILD_VERSION = originalLocalVersion
      }
      if (originalMacRelease === undefined) {
        delete process.env.QUIRKY_MAC_RELEASE
      } else {
        process.env.QUIRKY_MAC_RELEASE = originalMacRelease
      }
      delete require.cache[configPath]
      require('../electron-builder.config.cjs')
    }
  })

  it('uses Quirky native rebuild hook instead of electron-builder default rebuild', () => {
    expect(electronBuilderConfig.beforeBuild).toBe(electronBuilderNativeRebuild)
    expect(electronBuilderConfig.npmRebuild).toBe(true)
  })
})

describe('arch-aware packaging guard', () => {
  // electron-builder Arch enum: ia32=0, x64=1, armv7l=2, arm64=3.
  const HOST_ARCH = process.arch === 'arm64' ? 3 : 1
  const OTHER_ARCH = process.arch === 'arm64' ? 1 : 3
  const OTHER_ARCH_NAME = process.arch === 'arm64' ? 'x64' : 'arm64'
  const SHERPA_PLATFORM = process.platform === 'win32' ? 'win' : process.platform
  const otherSherpa = `sherpa-onnx-${SHERPA_PLATFORM}-${OTHER_ARCH_NAME}`

  // beforePack also hash-verifies the mobile web bundle, which the unit-test job never builds.
  // Point it at a real bundle built into a temp dir: these tests are about the native-variant
  // guard, and the bundle guard has its own suite.
  let scratch
  let bundleDir
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'quirky-electron-builder-guard-'))
    bundleDir = join(scratch, 'mobile-web')
    await writeMobileWebBundleFixtureTree({ outDir: bundleDir })
  })
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true })
  })

  const packHost = (arch) =>
    electronBuilderConfig.beforePack({ electronPlatformName: process.platform, arch }, bundleDir)

  it('allows packaging the host platform and architecture', () => {
    expect(() => packHost(HOST_ARCH)).not.toThrow()
  })

  it('refuses to package a dark layout-owner build', () => {
    const previous = process.env.QUIRKY_LAYOUT_OWNER
    process.env.QUIRKY_LAYOUT_OWNER = 'main'
    try {
      expect(() => packHost(HOST_ARCH)).toThrow('QUIRKY_LAYOUT_OWNER=main')
    } finally {
      if (previous === undefined) {
        delete process.env.QUIRKY_LAYOUT_OWNER
      } else {
        process.env.QUIRKY_LAYOUT_OWNER = previous
      }
    }
  })

  it('refuses to package an quirkyd template marked by a dark test build', async () => {
    const templateDir = join(scratch, 'quirkyd-template')
    await mkdir(templateDir, { recursive: true })
    await writeFile(join(templateDir, 'QUIRKY_LAYOUT_OWNER_MAIN'), 'dark\n')
    try {
      expect(() =>
        electronBuilderConfig.beforePack(
          { electronPlatformName: process.platform, arch: HOST_ARCH },
          bundleDir,
          templateDir
        )
      ).toThrow(`${templateDir} holds an QUIRKY_LAYOUT_OWNER=main build`)
    } finally {
      await rm(templateDir, { recursive: true, force: true })
    }
  })

  it('requires the other architecture natives to be installed', () => {
    const otherSherpaInstalled = existsSync(
      join(REPO_ROOT, 'node_modules', otherSherpa, 'package.json')
    )
    const otherSherpaExpected = Object.hasOwn(
      require('../../package.json').optionalDependencies,
      otherSherpa
    )
    if (otherSherpaExpected && !otherSherpaInstalled) {
      expect(() => packHost(OTHER_ARCH)).toThrow(otherSherpa)
      expect(() => packHost(OTHER_ARCH)).toThrow('pnpm install:release')
    } else if (process.platform === 'darwin') {
      expect(() => packHost(OTHER_ARCH)).not.toThrow()
    }
  })
})
