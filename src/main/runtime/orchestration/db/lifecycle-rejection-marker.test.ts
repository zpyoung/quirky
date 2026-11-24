import { describe, expect, it } from 'vitest'
import {
  addLifecycleRejectionMarker,
  hasLifecycleRejectionMarker
} from './lifecycle-rejection-marker'

describe('lifecycle-rejection-marker', () => {
  it('adds a marker onto an object payload and recognizes it', () => {
    const marked = addLifecycleRejectionMarker('{"keep":true}', 'rejected', 'not current', {
      originalReason: 'report file is invalid',
      originalBody: 'worker authored body'
    })
    expect(JSON.parse(marked)).toMatchObject({
      keep: true,
      _quirkyLifecycleRejection: {
        code: 'rejected',
        reason: 'not current',
        originalReason: 'report file is invalid',
        originalBody: 'worker authored body'
      }
    })
    expect(hasLifecycleRejectionMarker(marked)).toBe(true)
  })

  it('treats missing, non-object, and incomplete markers as absent', () => {
    expect(hasLifecycleRejectionMarker(null)).toBe(false)
    expect(hasLifecycleRejectionMarker('[]')).toBe(false)
    expect(hasLifecycleRejectionMarker('{"_quirkyLifecycleRejection":{"code":1}}')).toBe(false)
    expect(hasLifecycleRejectionMarker('not-json')).toBe(false)
  })
})
