import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NODE_RUNTIME_ASSETS } from '../../shared/node-runtime-pin'
import {
  QUIRKYD_NODE_RUNTIME_MARKER_FILENAME,
  QUIRKYD_SERVER_TARGET_FILENAME,
  QUIRKYD_VERSION_FILENAME,
  quirkydNodeRuntimeRelativePath
} from '../../shared/quirkyd-artifacts'
import { formatQuirkydNativePreflightReport } from '../../shared/quirkyd-native-preflight-report'
import { SERVE_RUNTIME_ENV } from '../../shared/quirkyd-local-serve-selection'
import { DEFAULT_LOCAL_QUIRKY_PROFILE_ID } from '../../shared/quirky-profiles'
import { PROFILE_STATE_DATABASE_FILE_NAME } from '../../shared/profile-state-storage-paths'
import Database from '../sqlite/sync-database'
import {
  openProfileStateDatabase,
  profileStatePragmaNumber
} from '../persistence/profile-state/profile-state-database'
import { hashProfileStatePayload } from '../persistence/profile-state/profile-state-document-validation'
import { importProfileStateJson } from '../persistence/profile-state/profile-state-documents'
import {
  selectServeRuntime,
  type ServeRuntimeSelectionInput
} from './quirkyd-local-serve-selection'
import type { AppImageNodeRuntime } from '../node-runtime/appimage-bundled-node-runtime'

const TARGET = 'linux-x64-glibc'
const SSH_TARGET = { id: 'ssh-1', label: 'box', host: 'box.example', port: 22, username: 'me' }
const SHA = NODE_RUNTIME_ASSETS[TARGET].executableSha256
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'quirky-serve-runtime-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A materialized slot as the template would leave it: no runtime of its own yet. */
function slotFixture(): string {
  const slot = join(root, 'quirkyd-artifacts', TARGET, '0.1.0+abc')
  mkdirSync(slot, { recursive: true })
  writeFileSync(join(slot, QUIRKYD_SERVER_TARGET_FILENAME), `${TARGET}\n`)
  writeFileSync(join(slot, QUIRKYD_NODE_RUNTIME_MARKER_FILENAME), `${SHA}\n`)
  writeFileSync(join(slot, QUIRKYD_VERSION_FILENAME), '0.1.0+abc\n')
  writeFileSync(join(slot, 'quirkyd.js'), '')
  writeFileSync(join(slot, 'quirkyd-server.js'), '')
  return slot
}

/** A valid schema-1 profile, as an Quirky from before the normalized run tables left it. */
function seedSchemaV1Profile(dbPath: string, state: Record<string, unknown>): void {
  const db = new Database(dbPath)
  db.exec(`
    PRAGMA user_version = 1;
    CREATE TABLE profile_state_meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    CREATE TABLE profile_state_documents (
      domain TEXT PRIMARY KEY NOT NULL,
      payload TEXT NOT NULL,
      domain_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      content_hash TEXT NOT NULL
    );
  `)
  db.prepare('INSERT INTO profile_state_meta (key, value) VALUES (?, ?)').run(
    'profile_id',
    DEFAULT_LOCAL_QUIRKY_PROFILE_ID
  )
  db.prepare('INSERT INTO profile_state_meta (key, value) VALUES (?, ?)').run('revision', '1')
  const insert = db.prepare(
    `INSERT INTO profile_state_documents
      (domain, payload, domain_version, revision, updated_at, content_hash)
     VALUES (?, ?, 1, 1, 100, ?)`
  )
  for (const [domain, value] of Object.entries(state)) {
    const payload = JSON.stringify(value)
    insert.run(domain, payload, hashProfileStatePayload(payload))
  }
  db.close()
}

function schemaVersion(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true })
  try {
    return profileStatePragmaNumber(db, 'user_version')
  } finally {
    db.close()
  }
}

function input(overrides: Partial<ServeRuntimeSelectionInput> = {}): ServeRuntimeSelectionInput {
  const template = join(root, 'quirkyd-template')
  mkdirSync(template, { recursive: true })
  const cachedNode = join(root, 'cached-node')
  writeFileSync(cachedNode, '#!/bin/sh\n')
  return {
    env: {},
    platform: 'linux',
    userDataPath: root,
    templateDirs: [join(root, 'missing-template'), template],
    hostTarget: () => TARGET,
    materializeSlot: vi.fn(async () => slotFixture()),
    materializeRuntime: vi.fn(async () => cachedNode),
    nativePreflight: async () => `${formatQuirkydNativePreflightReport('ok', null)}\n`,
    ...overrides
  }
}

describe('quirky serve runtime selection', () => {
  it('stays on Electron, silently, when Electron is asked for', async () => {
    const options = input({ env: { [SERVE_RUNTIME_ENV]: 'electron' } })
    expect(await selectServeRuntime(options)).toEqual({ kind: 'electron', reason: null })
    expect(options.materializeSlot).not.toHaveBeenCalled()
  })

  it('serves on quirkyd by default and when quirkyd is asked for by name, Windows included', async () => {
    for (const env of [{}, { [SERVE_RUNTIME_ENV]: 'quirkyd' }]) {
      for (const platform of ['linux', 'win32'] as const) {
        expect(await selectServeRuntime(input({ env, platform }))).toMatchObject({
          kind: 'quirkyd'
        })
      }
    }
  })

  it('stays on Electron by default when the profile has SSH targets quirkyd cannot serve (#25886)', async () => {
    const options = input({ profileHasSshTargets: () => true })
    expect(await selectServeRuntime(options)).toEqual({
      kind: 'electron',
      reason: 'this profile has SSH targets, which quirkyd cannot serve yet'
    })
    expect(options.materializeSlot).not.toHaveBeenCalled()
  })

  it('keeps quirkyd for SSH profiles when quirkyd is asked for by name', async () => {
    const named = input({
      env: { [SERVE_RUNTIME_ENV]: 'quirkyd' },
      profileHasSshTargets: () => true
    })
    expect(await selectServeRuntime(named)).toMatchObject({ kind: 'quirkyd' })
  })

  it('stays on Electron when it cannot tell whether the profile has SSH targets', async () => {
    const unreadable = input({
      profileHasSshTargets: () => {
        throw new Error('locked')
      }
    })
    expect(await selectServeRuntime(unreadable)).toEqual({
      kind: 'electron',
      reason:
        'could not tell whether this profile has SSH targets, which quirkyd cannot serve yet (locked)'
    })
    expect(unreadable.materializeSlot).not.toHaveBeenCalled()
  })

  it.each([
    ['with', [SSH_TARGET], 'electron'],
    ['without', [], 'quirkyd']
  ] as const)(
    'stays on Electron, without migrating, for a schema-1 profile %s SSH targets',
    async (_label, targets, afterMigration) => {
      const dbPath = join(root, PROFILE_STATE_DATABASE_FILE_NAME)
      seedSchemaV1Profile(dbPath, { sshTargets: targets })
      expect(await selectServeRuntime(input())).toMatchObject({
        kind: 'electron',
        reason: expect.stringContaining('could not tell whether this profile has SSH targets')
      })
      expect(schemaVersion(dbPath)).toBe(1)
      // The serve host's own open migrates it; selection then reads the same targets.
      openProfileStateDatabase(dbPath, DEFAULT_LOCAL_QUIRKY_PROFILE_ID).db.close()
      expect(await selectServeRuntime(input())).toMatchObject({ kind: afterMigration })
    }
  )

  it('serves on quirkyd for a current-schema profile with no SSH targets', async () => {
    const opened = openProfileStateDatabase(
      join(root, PROFILE_STATE_DATABASE_FILE_NAME),
      DEFAULT_LOCAL_QUIRKY_PROFILE_ID
    )
    importProfileStateJson(opened.db, JSON.stringify({ sshTargets: [], settings: {} }))
    opened.db.close()
    expect(await selectServeRuntime(input())).toMatchObject({ kind: 'quirkyd' })
  })

  it('reads SSH targets from the profile on disk', async () => {
    writeFileSync(join(root, 'quirky-data.json'), JSON.stringify({ sshTargets: [{ id: 'ssh-1' }] }))
    expect(await selectServeRuntime(input())).toMatchObject({ kind: 'electron' })
  })

  it('runs the local slot on its pinned Node, linked into userData beside it', async () => {
    const options = input()
    const selection = await selectServeRuntime(options)
    const slot = join(root, 'quirkyd-artifacts', TARGET, '0.1.0+abc')
    const runtime = join(slot, ...quirkydNodeRuntimeRelativePath(TARGET, SHA))
    expect(selection).toEqual({
      kind: 'quirkyd',
      runtime,
      entry: join(slot, 'quirkyd-server.js'),
      version: '0.1.0+abc'
    })
    expect(existsSync(runtime)).toBe(true)
    expect(runtime.startsWith(join(root, 'quirkyd-artifacts'))).toBe(true)
    expect(options.materializeSlot).toHaveBeenCalledWith(TARGET, {
      templateDir: join(root, 'quirkyd-template'),
      cacheRoot: join(root, 'quirkyd-artifacts')
    })
  })

  describe('an AppImage that carries the pinned Node', () => {
    const offline = (): ServeRuntimeSelectionInput['materializeRuntime'] =>
      vi.fn(async (): Promise<string> => {
        throw new Error('fetch failed')
      })

    function bundledNode(bytes: string): AppImageNodeRuntime {
      const path = join(root, 'resources', 'node-runtime', 'bin', 'node')
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, bytes)
      return {
        path,
        target: TARGET,
        executableSha256: createHash('sha256').update('#!/bin/sh\n# pinned\n').digest('hex')
      }
    }

    it('prepares the slot from it on an offline first run', async () => {
      const selection = await selectServeRuntime(
        input({
          materializeRuntime: offline(),
          bundledNodeRuntime: bundledNode('#!/bin/sh\n# pinned\n')
        })
      )
      const runtime = join(
        root,
        'quirkyd-artifacts',
        TARGET,
        '0.1.0+abc',
        ...quirkydNodeRuntimeRelativePath(TARGET, SHA)
      )
      expect(selection).toMatchObject({ kind: 'quirkyd', runtime })
      expect(readFileSync(runtime, 'utf8')).toBe('#!/bin/sh\n# pinned\n')
    })

    it('downloads instead when the bundled bytes are not the pin', async () => {
      const options = input({ bundledNodeRuntime: bundledNode('#!/bin/sh\n# tampered\n') })
      expect(await selectServeRuntime(options)).toMatchObject({ kind: 'quirkyd' })
      expect(options.materializeRuntime).toHaveBeenCalledOnce()
    })

    it('downloads instead when the bundled Node is for another host', async () => {
      const options = input({
        hostTarget: () => 'linux-x64-musl',
        bundledNodeRuntime: bundledNode('#!/bin/sh\n# pinned\n')
      })
      await selectServeRuntime(options)
      expect(options.materializeRuntime).toHaveBeenCalledOnce()
    })
  })

  it.each([
    [
      'an unknown runtime name',
      { env: { [SERVE_RUNTIME_ENV]: 'bun' } },
      'QUIRKY_SERVE_RUNTIME=bun is neither quirkyd nor electron'
    ],
    ['an unsupported host', { hostTarget: () => 'linux-riscv64-glibc' }, 'no quirkyd build exists'],
    ['an install without the template', { templateDirs: [] }, 'carries no quirkyd template'],
    [
      'an offline first run',
      {
        materializeRuntime: vi.fn(async (): Promise<string> => {
          throw new Error('fetch failed')
        })
      },
      'could not be prepared: fetch failed'
    ],
    [
      'a host whose node-pty cannot load',
      {
        nativePreflight: async () => formatQuirkydNativePreflightReport('blocked', 'load_crashed')
      },
      'cannot run terminals here (blocked: load_crashed)'
    ],
    [
      'a silent preflight',
      { nativePreflight: async () => '' },
      'did not answer its native preflight'
    ]
  ])('falls back to Electron on %s and says why', async (_name, overrides, reason) => {
    const selection = await selectServeRuntime(input(overrides))
    expect(selection).toEqual({ kind: 'electron', reason: expect.stringContaining(reason) })
  })
})
