export const COPY_PAIRING_CODE_COMMAND = 'command:quirky.mobile/copy-pairing-code'

type ShownPairingCode = { pairingUrl: string }

const shownPairingCodes: ShownPairingCode[] = []

/** Marks a pairing URL as on screen in this window until the returned cleanup runs. */
export function showPairingCode(pairingUrl: string): () => void {
  const shown = { pairingUrl }
  shownPairingCodes.push(shown)
  let mounted = true

  return () => {
    if (!mounted) return
    mounted = false
    const index = shownPairingCodes.indexOf(shown)
    if (index !== -1) shownPairingCodes.splice(index, 1)
  }
}

/** Copies the requested or newest on-screen URL without returning the URL. */
export async function copyPairingCode(args: unknown): Promise<{ copied: true }> {
  const requestedUrl = typeof args === 'object' && args !== null && 'pairingUrl' in args && typeof args.pairingUrl === 'string'
    ? args.pairingUrl
    : undefined
  const shown = shownPairingCodes[shownPairingCodes.length - 1]
  const pairingUrl = requestedUrl ?? shown?.pairingUrl
  if (pairingUrl === undefined) throw new Error('No pairing code is shown. Generate one on the Mobile page first.')

  const clipboard = globalThis.navigator?.clipboard
  if (!clipboard?.writeText) {
    throw new Error('Clipboard access is unavailable. Select the pairing code below and copy it manually.')
  }
  await clipboard.writeText(pairingUrl)
  return { copied: true }
}
