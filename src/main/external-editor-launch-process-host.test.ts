import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))

import {
  launchExternalEditor,
  resolveVsCodeRemoteSshLaunchSpec,
  type ExternalEditorLaunchSpec
} from './external-editor-launch'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function spawnedChild(): { once: unknown; off: unknown; unref: unknown } {
  const child = {
    once: vi.fn((eventName: string, callback: () => void) => {
      if (eventName === 'spawn') {
        queueMicrotask(callback)
      }
      return child
    }),
    off: vi.fn(() => child),
    unref: vi.fn()
  }
  return child
}

function remoteSpec(
  code: string,
  path: string,
  platform: NodeJS.Platform
): ExternalEditorLaunchSpec {
  const spec = resolveVsCodeRemoteSshLaunchSpec(code, path, 'builder', {
    platform,
    fileExists: () => true
  })
  if (!spec) {
    throw new Error('expected a VS Code launch spec')
  }
  return spec
}

const HIDDEN_FIELDS = { detached: true, stdio: 'ignore', windowsHide: true, shell: false }
const HIDDEN = expect.objectContaining(HIDDEN_FIELDS)

describe('VS Code Remote-SSH launch through @orca/process-host', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(spawnedChild)
  })

  afterEach(() => {
    if (platformDescriptor) {
      Object.defineProperty(process, 'platform', platformDescriptor)
    }
  })

  it.each([
    ['darwin', '/usr/local/bin/code'],
    ['linux', '/usr/bin/code']
  ] as const)(
    'starts code directly on %s with a hidden, detached child',
    async (platform, code) => {
      setPlatform(platform)
      await launchExternalEditor(remoteSpec(code, '/home/ada/my project', platform))
      expect(spawnMock).toHaveBeenCalledWith(
        code,
        ['--remote', 'ssh-remote+builder', '/home/ada/my project'],
        HIDDEN
      )
    }
  )
})
