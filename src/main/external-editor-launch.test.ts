import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveCliCommandMock } = vi.hoisted(() => ({
  resolveCliCommandMock: vi.fn((command: string) => command)
}))

vi.mock('./codex-cli/command', () => ({
  resolveCliCommand: resolveCliCommandMock
}))

import {
  resolveExternalEditorLaunchSpec,
  resolveVsCodeRemoteSshLaunchSpec
} from './external-editor-launch'

describe('resolveExternalEditorLaunchSpec', () => {
  beforeEach(() => {
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockImplementation((command: string) => command)
  })

  it('keeps simple CLI commands on the executable launch path', () => {
    const spec = resolveExternalEditorLaunchSpec('cursor', '/tmp/workspace', {
      platform: 'darwin'
    })
    expect(spec).toEqual({
      kind: 'executable',
      spawnCmd: expect.any(String),
      spawnArgs: ['--new-window', '/tmp/workspace']
    })
  })

  it('appends escaped paths to compound macOS open commands', () => {
    expect(
      resolveExternalEditorLaunchSpec('open -a "Typora"', "/tmp/note's.md", {
        platform: 'darwin'
      })
    ).toEqual({
      kind: 'shell',
      spawnCmd: '/bin/sh',
      spawnArgs: ['-c', "open -a \"Typora\" '/tmp/note'\\''s.md'"]
    })
  })

  it('treats an existing POSIX executable path with spaces as an executable launcher', () => {
    const ideaPath = '/Users/me/Library/Application Support/JetBrains/Toolbox/scripts/idea'
    expect(
      resolveExternalEditorLaunchSpec(ideaPath, '/tmp/workspace', {
        platform: 'darwin',
        fileExists: (candidate) => candidate === ideaPath
      })
    ).toEqual({
      kind: 'executable',
      spawnCmd: ideaPath,
      spawnArgs: ['/tmp/workspace']
    })
  })

  it('keeps absolute POSIX commands with arguments on the shell launch path', () => {
    expect(
      resolveExternalEditorLaunchSpec('/usr/local/bin/code --reuse-window', '/tmp/workspace', {
        platform: 'darwin',
        fileExists: () => false
      })
    ).toEqual({
      kind: 'shell',
      spawnCmd: '/bin/sh',
      spawnArgs: ['-c', '/usr/local/bin/code --reuse-window /tmp/workspace']
    })
  })
})

describe('resolveVsCodeRemoteSshLaunchSpec', () => {
  beforeEach(() => {
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockImplementation((command: string) => command)
  })

  it.each(['code', 'code-insiders'])('builds exact Remote-SSH arguments for %s', (command) => {
    expect(
      resolveVsCodeRemoteSshLaunchSpec(command, '/home/Ada Lovelace/project', 'builder', {
        platform: 'linux'
      })
    ).toEqual({
      kind: 'executable',
      spawnCmd: command,
      spawnArgs: ['--remote', 'ssh-remote+builder', '/home/Ada Lovelace/project']
    })
  })

  it('supports an existing direct POSIX launcher path containing spaces', () => {
    const command = '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'
    expect(
      resolveVsCodeRemoteSshLaunchSpec(command, '/srv/project', 'builder', {
        platform: 'darwin',
        fileExists: (candidate) => candidate === command
      })
    ).toMatchObject({
      kind: 'executable',
      spawnCmd: command,
      spawnArgs: ['--remote', 'ssh-remote+builder', '/srv/project']
    })
  })

  it.each(['cursor', 'zed', 'code --reuse-window', 'open -a "Visual Studio Code"'])(
    'rejects unsupported and compound SSH commands: %s',
    (command) => {
      expect(
        resolveVsCodeRemoteSshLaunchSpec(command, '/srv/project', 'builder', {
          platform: 'linux'
        })
      ).toBeNull()
    }
  )
})
