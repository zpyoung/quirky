import { useSyncExternalStore } from 'react'

/** Where the first-launch import offer stands; onboarding waits until it is `none`. */
export type ImportOfferStatus = 'checking' | 'offered' | 'none'

const DISMISSED_KEY = 'importFromOrca.offerDismissed'
const DETECT_TIMEOUT_MS = 3000

let status: ImportOfferStatus | null = null
const listeners = new Set<() => void>()

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === '1'
  } catch {
    return false
  }
}

function setStatus(next: ImportOfferStatus): void {
  if (status === next) {
    return
  }
  status = next
  for (const listener of listeners) {
    listener()
  }
}

function startCheck(): void {
  if (status !== null) {
    return
  }
  if (readDismissed()) {
    status = 'none'
    return
  }
  status = 'checking'
  // a hung detect must never keep onboarding hidden on first launch
  const fallback = window.setTimeout(() => {
    if (status === 'checking') {
      setStatus('none')
    }
  }, DETECT_TIMEOUT_MS)
  void Promise.resolve()
    .then(() => window.api.importFromOrca.detect())
    .then((result) => {
      if (status === 'checking') {
        setStatus(result.offerFirstRun ? 'offered' : 'none')
      }
    })
    .catch(() => setStatus('none'))
    .finally(() => window.clearTimeout(fallback))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  startCheck()
  return () => listeners.delete(listener)
}

function getSnapshot(): ImportOfferStatus {
  return status ?? (readDismissed() ? 'none' : 'checking')
}

/** The first-launch import offer's status, checked once per window and shared by every caller. */
export function useImportOfferStatus(): ImportOfferStatus {
  return useSyncExternalStore(subscribe, getSnapshot)
}

/** Closes the first-launch offer for good, so it never shows again and onboarding can continue. */
export function dismissImportOffer(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, '1')
  } catch {
    // storage can be unavailable; the offer then shows again next launch
  }
  setStatus('none')
}

/** Restores the module to its unchecked state between tests. */
export function resetImportOfferStateForTests(): void {
  status = null
  listeners.clear()
}
