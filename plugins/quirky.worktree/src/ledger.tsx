import type { UiPluginContext } from '@quirky/protocol'

export type ExpectedLedgerSnapshot = { ledgerId: string; revision: number }
export type LedgerRemovalPreview = ExpectedLedgerSnapshot & { entryCount: number }
export type LedgerRemovalScope = { repoIds?: string[]; groupIds?: string[] }

export async function previewLedgerRemoval(context: UiPluginContext, scope: LedgerRemovalScope): Promise<LedgerRemovalPreview[] | null> {
  try {
    const raw = await context.call('quirky.ledger/request', { operation: 'removal-preview', removal: scope })
    if (typeof raw !== 'object' || raw === null || !('removalPreview' in raw) || !Array.isArray(raw.removalPreview)) {
      throw new Error('Ledger removal preview response is invalid.')
    }
    const preview = raw.removalPreview
    if (!preview.every((item) => {
      if (typeof item !== 'object' || item === null || !('ledgerId' in item) || !('revision' in item) || !('entryCount' in item)) return false
      return typeof item.ledgerId === 'string' && typeof item.revision === 'number' && Number.isSafeInteger(item.revision) && item.revision >= 0 && typeof item.entryCount === 'number' && Number.isSafeInteger(item.entryCount) && item.entryCount >= 0
    })) throw new Error('Ledger removal preview contains an invalid snapshot.')
    return preview as LedgerRemovalPreview[]
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === -32601) return null
    throw error
  }
}

export function ledgerRetentionNotice(preview: LedgerRemovalPreview[] | null): string | null {
  if (!preview?.length) return null
  const ledgers = preview.length
  const entries = preview.reduce((sum, ledger) => sum + ledger.entryCount, 0)
  return `Ledger records retained: ${entries} ${entries === 1 ? 'entry' : 'entries'} across ${ledgers} ${ledgers === 1 ? 'ledger' : 'ledgers'} will be retained and detached as needed.`
}

export function expectedLedgerSnapshots(preview: LedgerRemovalPreview[] | null): ExpectedLedgerSnapshot[] | undefined {
  return preview === null ? undefined : preview.map(({ ledgerId, revision }) => ({ ledgerId, revision }))
}
