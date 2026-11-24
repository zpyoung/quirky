import { beforeEach, describe, expect, it, vi } from 'vitest'

const runProcessMock = vi.hoisted(() => vi.fn())

vi.mock('@quirky/process-host', () => ({ runProcess: runProcessMock }))

import { runMacPrivilegedCommand } from './cli-privileged-processes'

describe('macOS CLI privileged process boundary', () => {
  beforeEach(() => runProcessMock.mockReset())

  it('uses the canonical process wrapper without a shell', async () => {
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })

    await runMacPrivilegedCommand("ln -s 'source' 'target'")

    expect(runProcessMock).toHaveBeenCalledWith({
      program: 'osascript',
      args: ['-e', "do shell script \"ln -s 'source' 'target'\" with administrator privileges"],
      timeoutMs: null
    })
  })
})
