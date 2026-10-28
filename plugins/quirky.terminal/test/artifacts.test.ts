import { afterEach, expect, test } from 'bun:test'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import type { TerminalArtifactResult } from '@quirky/protocol'
import { shellEscapePaths } from '../src/shell-escape'
import { E2eHarness, cleanupAll, type E2eOptions } from './e2e-support'
import { makeBuiltinDir } from './support'

const PLUGINS_ROOT = resolve(import.meta.dir, '../..')
const MOBILE_SLOT = { slot: 'phone-a' }
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nXcAAAAASUVORK5CYII=',
  'base64'
)

function builtinPluginsDir(home: string): string {
  const hooksPath = join(home, 'empty-git-hooks')
  mkdirSync(hooksPath)
  writeFileSync(join(home, '.gitconfig'), [
    '[user]',
    'name = Terminal Artifact Test',
    'email = terminal-artifact@example.invalid',
    '[core]',
    `hooksPath = ${hooksPath}`,
    '[commit]',
    'gpgSign = false',
    '[tag]',
    'gpgSign = false',
    ''
  ].join('\n'))
  const real = readdirSync(PLUGINS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(PLUGINS_ROOT, entry.name, 'quirky-plugin.json')))
    .map((entry) => entry.name)
    .filter((id) => id !== 'quirky.mobile')
  return makeBuiltinDir(home, { real, fakes: ['quirky.mobile'] }, 'artifacts-builtins')
}

const environmentRestorers: (() => void)[] = []
const ISOLATED_GIT_ENVIRONMENT_KEYS = [
  'HOME',
  'QUIRKY_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'GIT_CONFIG_GLOBAL',
  'PATH',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_KEY_1',
  'GIT_CONFIG_VALUE_1',
  'GIT_CONFIG_KEY_2',
  'GIT_CONFIG_VALUE_2',
  'GIT_CONFIG_PARAMETERS',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_OBJECT_DIRECTORY_RELATIVE',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_SHALLOW_FILE'
]

function isolateTestEnvironment(): () => void {
  const root = mkdtempSync(join(tmpdir(), 'terminal-artifact-test-env-'))
  const gitConfigKeys = Object.keys(process.env).filter((key) => /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key))
  const savedKeys = new Set([...ISOLATED_GIT_ENVIRONMENT_KEYS, ...gitConfigKeys])
  const previous = new Map([...savedKeys].map((key) => [key, process.env[key]]))
  let changed = false
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    if (changed) {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    rmSync(root, { recursive: true, force: true })
  }

  try {
    const paths = {
      HOME: join(root, 'home'),
      QUIRKY_HOME: join(root, 'quirky'),
      CODEX_HOME: join(root, 'codex'),
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      XDG_CONFIG_HOME: join(root, 'xdg')
    }
    for (const path of Object.values(paths)) mkdirSync(path, { recursive: true })
    const hooksPath = join(root, 'empty-hooks')
    mkdirSync(hooksPath)
    const originalPath = process.env.PATH ?? ''
    const gitCandidate = originalPath.split(delimiter).filter(Boolean).map((directory) => join(directory, 'git')).find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK)
        return true
      } catch {
        return false
      }
    })
    if (!gitCandidate) throw new Error('git executable was not found on PATH')
    const realGit = realpathSync.native(gitCandidate)
    const globalConfig = join(root, 'gitconfig')
    const systemConfig = join(root, 'gitconfig-system')
    writeFileSync(globalConfig, [
      '[user]',
      'name = Terminal Artifact Test',
      'email = terminal-artifact@example.invalid',
      '[core]',
      `hooksPath = ${hooksPath}`,
      '[commit]',
      'gpgSign = false',
      '[tag]',
      'gpgSign = false',
      ''
    ].join('\n'))
    writeFileSync(systemConfig, '')
    const gitBin = join(root, 'git-bin')
    mkdirSync(gitBin)
    const gitWrapper = join(gitBin, 'git')
    writeFileSync(gitWrapper, [
      '#!/bin/sh',
      'unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_OBJECT_DIRECTORY_RELATIVE GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_PREFIX GIT_CEILING_DIRECTORIES GIT_DISCOVERY_ACROSS_FILESYSTEM GIT_SHALLOW_FILE GIT_CONFIG_PARAMETERS',
      `export GIT_CONFIG_GLOBAL=${shellEscapePaths([globalConfig])}`,
      `export GIT_CONFIG_SYSTEM=${shellEscapePaths([systemConfig])}`,
      'export GIT_CONFIG_NOSYSTEM=1',
      'export GIT_CONFIG_COUNT=3',
      'export GIT_CONFIG_KEY_0=core.hooksPath',
      `export GIT_CONFIG_VALUE_0=${shellEscapePaths([hooksPath])}`,
      'export GIT_CONFIG_KEY_1=commit.gpgSign',
      'export GIT_CONFIG_VALUE_1=false',
      'export GIT_CONFIG_KEY_2=tag.gpgSign',
      'export GIT_CONFIG_VALUE_2=false',
      `exec ${shellEscapePaths([realGit])} "$@"`,
      ''
    ].join('\n'))
    chmodSync(gitWrapper, 0o755)

    changed = true
    for (const key of savedKeys) delete process.env[key]
    Object.assign(process.env, paths, {
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_SYSTEM: systemConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: hooksPath,
      GIT_CONFIG_KEY_1: 'commit.gpgSign',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'tag.gpgSign',
      GIT_CONFIG_VALUE_2: 'false',
      PATH: `${gitBin}${delimiter}${originalPath}`
    })
    return restore
  } catch (error) {
    restore()
    throw error
  }
}

async function start(options: Omit<E2eOptions, 'builtinPluginsDir'> = {}): Promise<E2eHarness> {
  const restore = isolateTestEnvironment()
  try {
    const harness = await E2eHarness.start({ ...options, builtinPluginsDir })
    environmentRestorers.push(restore)
    return harness
  } catch (error) {
    restore()
    throw error
  }
}

function scenario(name: string, run: () => Promise<void>, timeoutMs = 90_000): void {
  test(name, run, timeoutMs)
}

afterEach(async () => {
  try {
    await cleanupAll()
  } finally {
    for (const restore of environmentRestorers.splice(0).reverse()) restore()
  }
})

type Listed = Extract<TerminalArtifactResult, { kind: 'listed' }>
type Preview = Extract<TerminalArtifactResult, { kind: 'preview' }>
type Refused = Extract<TerminalArtifactResult, { kind: 'refused' }>

function listed(result: TerminalArtifactResult): Listed {
  if (result.kind !== 'listed') throw new Error(`expected listed artifacts, got ${result.kind}`)
  return result
}

function preview(result: TerminalArtifactResult): Preview {
  if (result.kind !== 'preview') throw new Error(`expected artifact preview, got ${result.kind}`)
  return result
}

function refused(result: TerminalArtifactResult, reason: Refused['reason']): Refused {
  if (result.kind !== 'refused') throw new Error(`expected refusal, got ${result.kind}`)
  expect(result.reason).toBe(reason)
  return result
}

async function printPath(h: E2eHarness, session: string, path: string): Promise<void> {
  await h.run(session, `printf '%s\\n' ${shellEscapePaths([path])}`)
  await h.waitForLine(session, path)
}

function request(action: 'list' | 'preview' | 'refresh' | 'save', worktree: string, session: string) {
  return { action, worktree, session }
}

scenario('discovers only printed outside-worktree files and saves from the exact preview across CLI connections', async () => {
  const h = await start({ cleanShell: true })
  const session = await h.newSession()
  const outside = join(dirname(h.repo), 'outside-note.md')
  const unprinted = join(dirname(h.repo), 'never-printed.md')
  const draft = join(dirname(h.repo), 'draft.md')
  writeFileSync(outside, '# original\n')
  writeFileSync(unprinted, 'private\n')
  await printPath(h, session.id, outside)

  const firstList = listed(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', request('list', session.worktreeId, session.id)))
  const artifact = firstList.artifacts.find((item) => item.path === outside)
  expect(artifact).toBeDefined()
  expect(firstList.artifacts.some((item) => item.path === unprinted)).toBe(false)

  const firstPreview = preview(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('preview', session.worktreeId, session.id),
    artifactId: artifact!.artifactId,
    grant: artifact!.grant
  }))
  expect(firstPreview).toMatchObject({ format: 'markdown', content: '# original\n', writable: true, truncated: false })

  const secondList = listed(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', request('list', session.worktreeId, session.id)))
  expect(secondList.artifacts.find((item) => item.path === outside)).toMatchObject({
    artifactId: artifact!.artifactId,
    grant: artifact!.grant
  })

  const otherSession = await h.newSession()
  refused(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('preview', session.worktreeId, otherSession.id),
    artifactId: artifact!.artifactId,
    grant: artifact!.grant
  }), 'grant-invalid')
  refused(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('preview', 'not-the-worktree', session.id),
    artifactId: artifact!.artifactId,
    grant: artifact!.grant
  }), 'grant-invalid')
  refused(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('preview', session.worktreeId, session.id),
    artifactId: 'not-issued',
    grant: 'not-issued'
  }), 'grant-invalid')

  await expect(h.call('quirky.terminal/artifacts', {
    ...request('preview', session.worktreeId, session.id),
    artifactId: artifact!.artifactId,
    grant: artifact!.grant,
    path: unprinted
  })).rejects.toBeDefined()

  writeFileSync(draft, '# saved through the CLI\n')
  const saved = await h.json<TerminalArtifactResult>([
    'terminal', 'artifacts', 'save', session.worktreeId, session.id,
    '--artifact-id', artifact!.artifactId,
    '--grant', artifact!.grant,
    '--revision', firstPreview.revision,
    '--content-file', draft
  ])
  expect(saved.kind).toBe('saved')
  expect(readFileSync(outside, 'utf8')).toBe('# saved through the CLI\n')
})

scenario('refuses stale revisions without changing external bytes and rejects a repointed parent symlink', async () => {
  const h = await start({ cleanShell: true })
  const session = await h.newSession()
  const outside = join(dirname(h.repo), 'stale.txt')
  writeFileSync(outside, 'base\n')
  await printPath(h, session.id, outside)
  const artifact = listed(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', request('list', session.worktreeId, session.id)))
    .artifacts.find((item) => item.path === outside)!
  const before = preview(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('preview', session.worktreeId, session.id), artifactId: artifact.artifactId, grant: artifact.grant
  }))
  writeFileSync(outside, 'external edit\n')
  refused(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('save', session.worktreeId, session.id), artifactId: artifact.artifactId, grant: artifact.grant,
    expectedRevision: before.revision, content: 'draft must not overwrite\n'
  }), 'file-changed')
  expect(readFileSync(outside, 'utf8')).toBe('external edit\n')

  const firstDir = join(dirname(h.repo), 'first-target')
  const secondDir = join(dirname(h.repo), 'second-target')
  const linkDir = join(dirname(h.repo), 'current-target')
  mkdirSync(firstDir)
  mkdirSync(secondDir)
  const original = join(firstDir, 'linked.txt')
  const replacement = join(secondDir, 'linked.txt')
  const lexical = join(linkDir, 'linked.txt')
  writeFileSync(original, 'original target\n')
  writeFileSync(replacement, 'replacement target\n')
  symlinkSync(firstDir, linkDir)
  await printPath(h, session.id, lexical)
  const linkArtifact = listed(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', request('list', session.worktreeId, session.id)))
    .artifacts.find((item) => item.path === lexical)!
  const linkPreview = preview(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('preview', session.worktreeId, session.id), artifactId: linkArtifact.artifactId, grant: linkArtifact.grant
  }))
  rmSync(linkDir)
  symlinkSync(secondDir, linkDir)
  const result = await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('save', session.worktreeId, session.id), artifactId: linkArtifact.artifactId, grant: linkArtifact.grant,
    expectedRevision: linkPreview.revision, content: 'must not clobber either target\n'
  })
  expect(result.kind).toBe('refused')
  if (result.kind === 'refused') expect(['file-changed', 'source-unavailable']).toContain(result.reason)
  expect(readFileSync(original, 'utf8')).toBe('original target\n')
  expect(readFileSync(replacement, 'utf8')).toBe('replacement target\n')
})

scenario('bounds text previews and keeps binary and raster files read-only', async () => {
  const h = await start({ cleanShell: true })
  const session = await h.newSession()
  const root = dirname(h.repo)
  const large = join(root, 'large.txt')
  const binary = join(root, 'unknown.bin')
  const image = join(root, 'tiny.png')
  const boundedImage = join(root, 'bounded.png')
  const largeImage = join(root, 'large.png')
  writeFileSync(large, 'x'.repeat(48 * 1024 + 17))
  writeFileSync(binary, Buffer.from([0, 0xff, 0x00, 0x82]))
  writeFileSync(image, PNG_1X1)
  const boundedPng = Buffer.alloc(192 * 1024)
  PNG_1X1.copy(boundedPng)
  writeFileSync(boundedImage, boundedPng)
  const oversizedPng = Buffer.alloc(192 * 1024 + 1)
  PNG_1X1.copy(oversizedPng)
  writeFileSync(largeImage, oversizedPng)
  await printPath(h, session.id, large)
  await printPath(h, session.id, binary)
  await printPath(h, session.id, image)
  await printPath(h, session.id, boundedImage)
  await printPath(h, session.id, largeImage)

  const artifacts = listed(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', request('list', session.worktreeId, session.id))).artifacts
  const get = (path: string) => artifacts.find((artifact) => artifact.path === path)!
  const largePreview = preview(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('preview', session.worktreeId, session.id), artifactId: get(large).artifactId, grant: get(large).grant
  }))
  expect(largePreview).toMatchObject({ format: 'text', truncated: true, writable: false })
  expect(Buffer.byteLength(largePreview.content, 'utf8')).toBeLessThanOrEqual(48 * 1024)

  const binaryPreview = preview(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('preview', session.worktreeId, session.id), artifactId: get(binary).artifactId, grant: get(binary).grant
  }))
  expect(binaryPreview).toMatchObject({ format: 'binary', writable: false, content: '' })
  refused(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('save', session.worktreeId, session.id),
    artifactId: get(large).artifactId,
    grant: get(large).grant,
    expectedRevision: largePreview.revision,
    content: 'not a complete-file save'
  }), 'read-only')
  refused(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('save', session.worktreeId, session.id),
    artifactId: get(binary).artifactId,
    grant: get(binary).grant,
    expectedRevision: binaryPreview.revision,
    content: 'not a binary save'
  }), 'read-only')
  const imagePreview = preview(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('preview', session.worktreeId, session.id), artifactId: get(image).artifactId, grant: get(image).grant
  }))
  expect(imagePreview).toMatchObject({ format: 'image', writable: false, image: { mime: 'image/png' } })
  const boundedImagePreview = preview(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('preview', session.worktreeId, session.id),
    artifactId: get(boundedImage).artifactId,
    grant: get(boundedImage).grant
  }))
  expect(boundedImagePreview.format).toBe('image')
  expect(boundedImagePreview.image?.data.length).toBe(256 * 1024)
  const oversizedImagePreview = preview(await h.call<TerminalArtifactResult>('quirky.terminal/artifacts', {
    ...request('preview', session.worktreeId, session.id),
    artifactId: get(largeImage).artifactId,
    grant: get(largeImage).grant
  }))
  expect(oversizedImagePreview).toMatchObject({
    format: 'binary',
    bytes: 192 * 1024 + 1,
  })
  expect(oversizedImagePreview.image).toBeUndefined()
})

scenario('a second authenticated mobile device cannot use another device’s artifact grant', async () => {
  const h = await start({ cleanShell: true })
  const session = await h.newSession()
  const outside = join(dirname(h.repo), 'mobile-owned.txt')
  writeFileSync(outside, 'owned by the first phone\n')
  await printPath(h, session.id, outside)

  await h.call('quirky.mobile/testAdmit', MOBILE_SLOT)
  const phoneList = await h.call<TerminalArtifactResult>('quirky.mobile/testCall', {
    ...MOBILE_SLOT,
    method: 'quirky.terminal/artifacts',
    params: request('list', session.worktreeId, session.id)
  })
  const artifact = listed(phoneList).artifacts.find((item) => item.path === outside)!
  await h.call('quirky.mobile/testAdmit', { slot: 'phone-b' })
  const denied = await h.call<TerminalArtifactResult>('quirky.mobile/testCall', {
    slot: 'phone-b',
    method: 'quirky.terminal/artifacts',
    params: {
      ...request('preview', session.worktreeId, session.id),
      artifactId: artifact.artifactId,
      grant: artifact.grant
    }
  })
  refused(denied, 'grant-invalid')
})
