/** @vitest-environment happy-dom */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dismissImportOffer,
  resetImportOfferStateForTests,
  useImportOfferStatus
} from './import-from-orca-offer-state'

const DISMISSED_KEY = 'importFromOrca.offerDismissed'

function stubDetect(detect: () => Promise<{ offerFirstRun: boolean }>): void {
  ;(window as unknown as { api: unknown }).api = { importFromOrca: { detect } }
}

describe('useImportOfferStatus', () => {
  beforeEach(() => {
    resetImportOfferStateForTests()
    window.localStorage.removeItem(DISMISSED_KEY)
  })

  afterEach(() => {
    window.localStorage.removeItem(DISMISSED_KEY)
  })

  // onboarding renders only on 'none', so 'checking' and 'offered' are what hold it back
  it('holds onboarding while the offer is checked and shown, then releases it on dismiss', async () => {
    stubDetect(async () => ({ offerFirstRun: true }))
    const { result } = renderHook(() => useImportOfferStatus())
    expect(result.current).toBe('checking')
    await waitFor(() => expect(result.current).toBe('offered'))

    act(() => dismissImportOffer())

    expect(result.current).toBe('none')
    expect(window.localStorage.getItem(DISMISSED_KEY)).toBe('1')
  })

  it('releases onboarding when there is nothing to offer or detection fails', async () => {
    stubDetect(async () => {
      throw new Error('no bridge')
    })
    const { result } = renderHook(() => useImportOfferStatus())
    await waitFor(() => expect(result.current).toBe('none'))
  })

  it('never checks again once dismissed', () => {
    window.localStorage.setItem(DISMISSED_KEY, '1')
    const detect = vi.fn(async () => ({ offerFirstRun: true }))
    stubDetect(detect)
    const { result } = renderHook(() => useImportOfferStatus())
    expect(result.current).toBe('none')
    expect(detect).not.toHaveBeenCalled()
  })
})
