import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

let dataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => dataDir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  }
}))

async function createStore() {
  const { Store } = await import('../persistence')
  const { createSqliteTestStore } = await import('../persistence-test-harness')
  return createSqliteTestStore(Store, { dataFile: join(dataDir, 'quirky-data.json') })
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'quirky-project-groups-'))
})

afterEach(async () => {
  const { closeTestStores } = await import('../persistence-test-harness')
  await closeTestStores()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('Store project group worktree membership', () => {
  it('releases members of a deleted group subtree without removing metadata', async () => {
    const store = await createStore()
    const root = store.createProjectGroup({ name: 'Root', createdFrom: 'manual' })
    const child = store.createProjectGroup({
      name: 'Child',
      parentGroupId: root.id,
      createdFrom: 'manual'
    })
    const other = store.createProjectGroup({ name: 'Other', createdFrom: 'manual' })
    store.setWorktreeMeta(hostWorktreeTarget({ id: 'root', hostId: 'local' }), {
      projectGroupId: root.id
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: 'child', hostId: 'local' }), {
      projectGroupId: child.id
    })
    store.setWorktreeMeta(hostWorktreeTarget({ id: 'other', hostId: 'local' }), {
      projectGroupId: other.id
    })

    expect(store.deleteProjectGroup(root.id)).toBe(true)
    expect(store.getAllWorktreeMeta()).toMatchObject({
      root: { projectGroupId: null },
      child: { projectGroupId: null },
      other: { projectGroupId: other.id }
    })
    expect(Object.keys(store.getAllWorktreeMeta()).sort()).toEqual(['child', 'other', 'root'])
  })

  it('tolerates a corrupt persisted worktree metadata entry', async () => {
    writeFileSync(
      join(dataDir, 'quirky-data.json'),
      JSON.stringify({
        schemaVersion: 1,
        repos: [],
        worktreeMeta: { corrupt: null },
        settings: {},
        ui: {},
        githubCache: { pr: {}, issue: {} },
        projectGroups: [
          {
            id: 'group-1',
            name: 'Group',
            parentPath: null,
            parentGroupId: null,
            createdFrom: 'manual',
            tabOrder: 0,
            isCollapsed: false,
            color: null,
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
    )
    const store = await createStore()
    expect(() => store.deleteProjectGroup('group-1')).not.toThrow()
    expect(store.getAllWorktreeMeta()).not.toHaveProperty('corrupt')
  })

  it('deletes folder workspaces in a deleted group subtree', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({
      name: 'Folder',
      parentPath: '/folder',
      createdFrom: 'folder-scan'
    })
    const workspace = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Folder ws' })
    store.deleteProjectGroup(group.id)
    expect(store.getFolderWorkspace(workspace.id)).toBeUndefined()
  })

  it('preserves a foreign host group id when writing metadata', async () => {
    const store = await createStore()
    expect(
      store.setWorktreeMeta(hostWorktreeTarget({ id: 'foreign', hostId: 'local' }), {
        projectGroupId: 'host:elsewhere'
      }).projectGroupId
    ).toBe('host:elsewhere')
  })
})
