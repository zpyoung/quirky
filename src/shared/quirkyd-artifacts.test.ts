import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_RIPGREP_PLATFORMS, bundledRipgrepBinaryName } from './bundled-ripgrep'
import { SERVER_TARGETS } from './node-runtime-pin'
import {
  QUIRKYD_BUILD_TARGET_FILENAME,
  QUIRKYD_FOREIGN_SQLITE_READER_ENTRY,
  QUIRKYD_MOBILE_WEB_MANIFEST,
  QUIRKYD_NODE_PTY_JS_ARTIFACTS,
  QUIRKYD_NODE_RUNTIME_MARKER_FILENAME,
  QUIRKYD_RIPGREP_ARTIFACTS,
  QUIRKYD_RIPGREP_LICENSE_ARTIFACTS,
  QUIRKYD_WINDOWS_CLI_LAUNCHER_FILENAME,
  QUIRKYD_WINDOWS_SECURITY_FILENAME,
  quirkydArtifactFilenames,
  quirkydBunRuntimeFilename,
  quirkydMobileWebAssetFilenames,
  quirkydNodePtySlotFiles,
  quirkydNodeRuntimeRelativePath,
  quirkydTemplateCommonFilenames,
  quirkydTemplateTargetFilenames
} from './quirkyd-artifacts'

describe('standalone runtime artifacts', () => {
  it.each(SERVER_TARGETS)('ships the native CLI launcher only in Windows %s slots', (target) => {
    expect(
      quirkydArtifactFilenames(target, []).includes(QUIRKYD_WINDOWS_CLI_LAUNCHER_FILENAME)
    ).toBe(target.startsWith('win32-'))
    expect(quirkydTemplateCommonFilenames([])).not.toContain(QUIRKYD_WINDOWS_CLI_LAUNCHER_FILENAME)
  })

  it.each(SERVER_TARGETS)(
    'ships the foreign SQLite reader worker the %s runtime starts',
    (target) => {
      expect(quirkydArtifactFilenames(target, [])).toContain(QUIRKYD_FOREIGN_SQLITE_READER_ENTRY)
    }
  )

  it('names a search binary for every SSH host platform', () => {
    const expected = BUNDLED_RIPGREP_PLATFORMS.map(
      (platform) => `ripgrep/${platform}/${bundledRipgrepBinaryName(platform)}`
    )
    expect(QUIRKYD_RIPGREP_ARTIFACTS).toEqual(expected)
  })

  it.each(SERVER_TARGETS)('ships only the %s search binary in its install identity', (target) => {
    const [platform, arch] = target.split('-')
    const shipped = quirkydArtifactFilenames(target, []).filter((file) =>
      /^ripgrep\/[^/]+\/rg/.test(file)
    )
    expect(shipped).toEqual([
      `ripgrep/${platform}-${arch}/${bundledRipgrepBinaryName(`${platform}-${arch}`)}`
    ])
  })

  it('ships the binary redistribution notices with every install', () => {
    const sourceDir = join(__dirname, '../../resources/licenses/ripgrep')
    expect(QUIRKYD_RIPGREP_LICENSE_ARTIFACTS.map((path) => path.split('/').at(-1)).sort()).toEqual(
      readdirSync(sourceDir).sort()
    )
    expect(quirkydArtifactFilenames('linux-x64-glibc', [])).toEqual(
      expect.arrayContaining([...QUIRKYD_RIPGREP_LICENSE_ARTIFACTS])
    )
  })

  it.each(SERVER_TARGETS)('references the %s runtime instead of carrying a Bun one', (target) => {
    const filenames = quirkydArtifactFilenames(target, [])
    expect(filenames).toContain(QUIRKYD_NODE_RUNTIME_MARKER_FILENAME)
    expect(filenames).toEqual(expect.arrayContaining(QUIRKYD_NODE_PTY_JS_ARTIFACTS))
    // A Bun-era selector exits 78 on `.build-target` without its Bun runtime (design D7.1 R5).
    expect(filenames).not.toContain(QUIRKYD_BUILD_TARGET_FILENAME)
    expect(filenames).not.toContain(quirkydBunRuntimeFilename(target))
    expect(filenames.some((file) => file.includes('windows-bun-pty'))).toBe(false)
  })

  it('ships node-pty natives per target, with ConPTY and spawn-helper where they run', () => {
    const natives = (target: string): string[] =>
      quirkydArtifactFilenames(target, [])
        .filter((file) => file.startsWith('node_modules/node-pty/build/Release/'))
        .map((file) => file.slice('node_modules/node-pty/build/Release/'.length))
    expect(natives('linux-arm64-musl')).toEqual(['pty.node'])
    expect(natives('darwin-x64')).toEqual(['pty.node', 'spawn-helper'])
    expect(natives('win32-arm64')).toEqual([
      'conpty.node',
      'conpty_console_list.node',
      'conpty/conpty.dll',
      'conpty/OpenConsole.exe',
      'pty.node',
      'winpty.dll',
      'winpty-agent.exe'
    ])
  })

  // #30906: node-pty picks winpty below build 18309, so a ConPTY-only slot left 1809 with no PTY.
  it.each(['win32-x64', 'win32-arm64'])(
    'ships every native module the %s slot node-pty JS can load',
    (target) => {
      const nodePtyDir = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
      const windowsJs = QUIRKYD_NODE_PTY_JS_ARTIFACTS.filter((file) =>
        /\/lib\/(?:windows|conpty)[^/]*\.js$/.test(file)
      )
      const loaded = new Set(
        windowsJs.flatMap((file) =>
          [
            ...readFileSync(
              join(nodePtyDir, file.slice('node_modules/node-pty/'.length)),
              'utf8'
            ).matchAll(/loadNativeModule\('([\w-]+)'\)/g)
          ].map((match) => match[1])
        )
      )
      expect([...loaded].sort()).toEqual(['conpty', 'conpty_console_list', 'pty'])
      const slot = quirkydNodePtySlotFiles(target)
      for (const name of loaded) {
        expect(slot).toContain(`${name}.node`)
      }
      // winpty's pty.node links winpty.dll, which starts winpty-agent.exe from its own folder.
      expect(slot).toEqual(expect.arrayContaining(['winpty.dll', 'winpty-agent.exe']))
    }
  )

  // Without it quirkyd's data-root privacy check fails closed and a Windows slot never starts.
  it('requires the Windows security addon in every Windows slot and nowhere else', () => {
    for (const target of ['win32-x64', 'win32-arm64']) {
      expect(quirkydArtifactFilenames(target, [])).toContain(QUIRKYD_WINDOWS_SECURITY_FILENAME)
      expect(quirkydTemplateTargetFilenames(target)).toContain(QUIRKYD_WINDOWS_SECURITY_FILENAME)
    }
    expect(quirkydArtifactFilenames('linux-x64-glibc', [])).not.toContain(
      QUIRKYD_WINDOWS_SECURITY_FILENAME
    )
    expect(quirkydArtifactFilenames('darwin-arm64', [])).not.toContain(
      QUIRKYD_WINDOWS_SECURITY_FILENAME
    )
  })

  it('keeps the runtime executable under its upstream name in the shared store', () => {
    expect(quirkydNodeRuntimeRelativePath('linux-x64-glibc', 'a'.repeat(64))).toEqual([
      '..',
      'runtimes',
      `node-${'a'.repeat(64)}`,
      'bin',
      'node'
    ])
    expect(quirkydNodeRuntimeRelativePath('win32-x64', 'b'.repeat(64)).at(-1)).toBe('node.exe')
  })

  it('keeps target-specific files out of the shared template set', () => {
    const common = quirkydTemplateCommonFilenames([])
    for (const target of SERVER_TARGETS) {
      expect(common.every((file) => quirkydArtifactFilenames(target, []).includes(file))).toBe(true)
    }
  })

  // Phones paired to quirkyd get the page only when the slot carries it (mobileWeb.bundle.v1).
  it.each(SERVER_TARGETS)(
    'requires the mobile web page in every %s slot, shared by all',
    (target) => {
      const assets = ['out/mobile-web/assets/app-1.js', 'out/mobile-web/index.html']
      expect(quirkydArtifactFilenames(target, assets)).toEqual(
        expect.arrayContaining([QUIRKYD_MOBILE_WEB_MANIFEST, ...assets])
      )
      expect(quirkydTemplateCommonFilenames(assets)).toEqual(
        expect.arrayContaining([QUIRKYD_MOBILE_WEB_MANIFEST, ...assets])
      )
      expect(
        quirkydTemplateTargetFilenames(target).some((file) => file.startsWith('out/mobile-web'))
      ).toBe(false)
    }
  )

  it('names the page assets its manifest lists, in a locale-free order', () => {
    const manifest = JSON.stringify({
      assets: [{ path: 'index.html' }, { path: 'assets/b.js' }, { path: 'assets/B.css' }]
    })
    expect(quirkydMobileWebAssetFilenames(manifest)).toEqual([
      'out/mobile-web/assets/B.css',
      'out/mobile-web/assets/b.js',
      'out/mobile-web/index.html'
    ])
  })

  it.each([
    ['no assets', { assets: [] }],
    ['a traversal path', { assets: [{ path: '../quirkyd.js' }] }],
    ['an absolute path', { assets: [{ path: '/etc/passwd' }] }],
    ['a backslash path', { assets: [{ path: 'a\\b.js' }] }],
    ['a missing path', { assets: [{}] }]
  ])('refuses a page manifest with %s', (_label, manifest) => {
    expect(() => quirkydMobileWebAssetFilenames(JSON.stringify(manifest))).toThrow(
      QUIRKYD_MOBILE_WEB_MANIFEST
    )
  })
})
