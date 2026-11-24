import { describe, expect, it } from 'vitest'
import {
  classifyQuirkydHostUnavailable,
  quirkydCandidateLaunchFailureCode
} from './quirkyd-host-unavailable'
import { QuirkydWindowsLaunchRefusedError } from '../managed-server/install/quirkyd-remote-launch-windows'
import { QuirkydWindowsCommandLineError } from '../managed-server/install/quirkyd-remote-windows-node'

describe('classifyQuirkydHostUnavailable', () => {
  it('sends a Windows host that cannot launch quirkyd back to the relay', () => {
    const refused = new QuirkydWindowsLaunchRefusedError('breakaway denied')
    const unsafe = new QuirkydWindowsCommandLineError('C:\\Users\\%x%')
    expect(classifyQuirkydHostUnavailable(refused)).toBe('unsupported_host')
    expect(classifyQuirkydHostUnavailable(unsafe)).toBe('unsupported_host')
    expect(classifyQuirkydHostUnavailable({ code: refused.code })).toBe('unsupported_host')
    expect(classifyQuirkydHostUnavailable({ code: unsafe.code })).toBe('unsupported_host')
  })

  it('keeps an ordinary launch failure retryable', () => {
    expect(quirkydCandidateLaunchFailureCode(new Error('spawn failed'))).toBe(
      'quirkyd_candidate_launch_failed'
    )
    expect(
      classifyQuirkydHostUnavailable({
        code: quirkydCandidateLaunchFailureCode(new Error('spawn failed'))
      })
    ).toBeNull()
    expect(quirkydCandidateLaunchFailureCode(new QuirkydWindowsLaunchRefusedError('x'))).toBe(
      'quirkyd_windows_launch_refused'
    )
  })
})
