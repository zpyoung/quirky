import { describe, expect, it } from 'vitest'
import { getLocalExecutionHostLabel } from '../../../src/shared/execution-host'
import {
  buildNewWorkspaceProjectOptions,
  buildNewWorkspaceRunTargetOptions,
  getNewWorkspaceRunTarget
} from './new-workspace-project-targets'

const LOCAL_HOST_LABEL = getLocalExecutionHostLabel('darwin')

describe('new workspace project targets', () => {
  it('groups local and SSH checkouts of the same project', () => {
    const upstream = { owner: 'stablyai', repo: 'quirky' }
    const options = buildNewWorkspaceProjectOptions([
      { id: 'local', displayName: 'quirky', path: '/src/quirky', upstream },
      {
        id: 'ssh',
        displayName: 'quirky',
        path: '/home/dev/quirky',
        connectionId: 'build-server',
        upstream
      }
    ])

    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({ label: 'quirky', detail: 'stablyai/orca' })
  })

  it('shows the provider slug recovered from canonical git identity', () => {
    const options = buildNewWorkspaceProjectOptions([
      {
        id: 'local',
        displayName: 'quirky',
        path: '/src/quirky',
        gitRemoteIdentity: {
          canonicalKey: 'github.com/stablyai/orca',
          remoteName: 'origin',
          remoteUrl: 'git@github.com:stablyai/orca.git'
        }
      }
    ])

    expect(options[0]).toMatchObject({ label: 'quirky', detail: 'stablyai/orca' })
  })

  it('labels local, SSH, and paired runtime targets as the host list names them', () => {
    expect(
      getNewWorkspaceRunTarget(
        { id: 'local', displayName: 'quirky', path: '/src/quirky' },
        'darwin'
      )
    ).toEqual({ hostId: 'local', label: LOCAL_HOST_LABEL, detail: '/src/quirky' })
    expect(
      getNewWorkspaceRunTarget({ id: 'local', displayName: 'quirky', path: 'C:\\src\\quirky' })
    ).toMatchObject({ label: 'This computer' })
    expect(
      getNewWorkspaceRunTarget(
        { id: 'local', displayName: 'quirky', path: 'C:\\src\\quirky' },
        'win32'
      )
    ).toMatchObject({ label: 'Local Windows' })
    expect(
      getNewWorkspaceRunTarget({
        id: 'ssh',
        displayName: 'quirky',
        path: 'C:\\src\\quirky',
        executionHostId: 'ssh:Windows%20VM'
      })
    ).toEqual({ hostId: 'ssh:Windows%20VM', label: 'Windows VM', detail: 'C:\\src\\quirky' })
    const server = {
      id: 'runtime',
      displayName: 'quirky',
      path: '/src/quirky',
      executionHostId: 'runtime:20269ff3-60aa-4e79-a581-513a3f8e394b'
    } as const
    const labels = new Map([[server.executionHostId, 'scratch-server']] as const)
    expect(getNewWorkspaceRunTarget(server, 'darwin', labels)).toEqual({
      hostId: server.executionHostId,
      label: 'scratch-server',
      detail: '/src/quirky'
    })
  })

  it('shows one target per host when the project has multiple local worktrees', () => {
    const upstream = { owner: 'stablyai', repo: 'quirky' }
    const repos = [
      { id: 'local-a', displayName: 'quirky-a', path: '/src/quirky-a', upstream },
      { id: 'local-b', displayName: 'quirky-b', path: '/src/quirky-b', upstream },
      {
        id: 'ssh',
        displayName: 'quirky',
        path: '/home/dev/quirky',
        connectionId: 'build-server',
        upstream
      }
    ]
    const projectId = buildNewWorkspaceProjectOptions(repos)[0]?.id ?? null

    expect(buildNewWorkspaceRunTargetOptions(repos, projectId, 'darwin')).toEqual([
      expect.objectContaining({ id: 'local', label: LOCAL_HOST_LABEL, detail: '/src/quirky-a' }),
      expect.objectContaining({
        id: 'ssh:build-server',
        label: 'build-server',
        detail: '/home/dev/quirky'
      })
    ])
  })
})
