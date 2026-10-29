import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type ProjectGroup, type Repo, type Worktree } from '@quirky/protocol'
import { call, failure, git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { startRealProject, listWorktrees, type RealProject } from './fixtures/real-project'

const { scratch } = isolateGitConfig()
let project: RealProject | undefined

afterEach(async () => {
  await project?.t.cleanup()
  project = undefined
})

async function start() {
  project = await startRealProject(scratch)
  return project
}

const request = {
  automationId: 'automation-for-test',
  runId: 'run-for-test',
  dispatchToken: 'a'.repeat(36)
}

describe('worktree automation provenance API', () => {
  test('rejects malformed requests and caller-supplied snapshots before creating Git workspaces', async () => {
    const { client, repoDir, repo } = await start()
    const initialWorktreeIds = (await listWorktrees(client, { repo: repo.id })).map((worktree) => worktree.id)

    const malformed = await failure(call(client, 'quirky.worktree/create', {
      repo: repo.id,
      name: 'malformed-provenance',
      automationProvenanceRequest: { ...request, dispatchToken: 'short' }
    }))
    expect(malformed.code).toBe(RpcErrorCode.InvalidParams)

    const forgedSnapshot = await failure(call(client, 'quirky.worktree/create', {
      repo: repo.id,
      name: 'forged-snapshot',
      automationProvenance: {
        kind: 'created-by-automation',
        automationId: 'attacker',
        automationName: 'Forged',
        runId: 'forged-run',
        runTitle: 'Forged run',
        projectId: repo.id,
        hostId: 'local'
      }
    }))
    expect(forgedSnapshot.code).toBe(RpcErrorCode.InvalidParams)
    expect((await listWorktrees(client, { repo: repo.id })).map((worktree) => worktree.id)).toEqual(initialWorktreeIds)
    expect(git(repoDir, 'branch', '--list', 'Test/malformed-provenance')).toBe('')
    expect(git(repoDir, 'branch', '--list', 'Test/forged-snapshot')).toBe('')
  })

  test('rejects automation provenance for folder projects and groups before creating folder workspaces', async () => {
    const { client } = await start()
    const folderPath = join(scratch(), 'notes-folder')
    mkdirSync(folderPath, { recursive: true })
    const folder = await call(client, 'quirky.repo/add', { path: folderPath, folder: true }) as Repo
    const folderCreate = await failure(call(client, 'quirky.worktree/create', {
      repo: folder.id,
      name: 'folder-child',
      automationProvenanceRequest: request
    }))
    expect(folderCreate.code).toBe(RpcErrorCode.InvalidParams)
    expect((await listWorktrees(client, { repo: folder.id })).map((worktree) => worktree.name)).toEqual(['notes-folder'])

    const group = await call(client, 'quirky.repo/groupCreate', { name: 'Folder group' }) as ProjectGroup
    const groupCreate = await failure(call(client, 'quirky.worktree/create', {
      group: group.id,
      name: 'group-child',
      automationProvenanceRequest: request
    }))
    expect(groupCreate.code).toBe(RpcErrorCode.InvalidParams)
    expect(await call(client, 'quirky.worktree/list', { group: group.id })).toEqual([] as Worktree[])
  })
})
