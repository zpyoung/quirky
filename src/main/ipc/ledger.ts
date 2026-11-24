import { ipcMain, type WebContents } from 'electron'
import { getRuntimeEnvironmentStatus } from './runtime-environments/runtime-environment-status-probe'
import { callRuntimeEnvironment } from './runtime-environments/runtime-environment-transport-routing'
import { isTrustedUIRenderer } from './ui'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import type { LedgerRequest, LedgerResponse } from '../../shared/ledger'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import { getPreferredPairingOffer } from '../../shared/runtime-environments'
import { issueLedgerUiAttestation } from '../runtime/rpc/ledger-ui-attestation'

export type LedgerIpcRuntime = Pick<QuirkyRuntimeService, 'getRuntimeId' | 'executeLedgerUiRequest'>

type LedgerIpcOptions = {
  userDataPath: string
  isTrustedRenderer?: (sender: WebContents) => boolean
}

export type LedgerIpcResult =
  | { ok: true; result: LedgerResponse }
  | { ok: false; error: { code: string; message: string; details?: unknown } }

function throwRemoteLedgerError(response: {
  ok: false
  error?: { code?: string; message?: string; data?: unknown }
}): never {
  const error = new Error(response.error?.message ?? 'Ledger runtime request failed') as Error & {
    code?: string
    details?: unknown
  }
  error.code = response.error?.code
  error.details = response.error?.data
  throw error
}

export function registerLedgerHandlers(runtime: LedgerIpcRuntime, options: LedgerIpcOptions): void {
  ipcMain.removeHandler('ledger:request')
  ipcMain.handle(
    'ledger:request',
    async (event, request: LedgerRequest, environmentId?: string): Promise<LedgerIpcResult> => {
      const trusted = options.isTrustedRenderer ?? isTrustedUIRenderer
      if (!trusted(event.sender)) {
        throw new Error('Ledger requests must originate from the trusted renderer')
      }
      const selectedEnvironment = environmentId || runtime.getRuntimeId()
      if (selectedEnvironment === runtime.getRuntimeId()) {
        try {
          return { ok: true, result: await runtime.executeLedgerUiRequest(request) }
        } catch (error) {
          return {
            ok: false,
            error: {
              code:
                error instanceof Error && 'code' in error
                  ? String((error as { code: unknown }).code)
                  : 'ledger_error',
              message: error instanceof Error ? error.message : String(error),
              ...(error instanceof Error && 'details' in error
                ? { details: (error as { details: unknown }).details }
                : {})
            }
          }
        }
      }
      const status = await getRuntimeEnvironmentStatus(options.userDataPath, selectedEnvironment)
      if (
        !status.ok ||
        !Array.isArray(status.result.capabilities) ||
        !status.result.capabilities.includes('ledger.v1')
      ) {
        throw new Error('Selected runtime does not support ledger.v1')
      }
      const environment = resolveEnvironment(options.userDataPath, selectedEnvironment)
      const pairing = getPreferredPairingOffer(environment)
      const attestation = issueLedgerUiAttestation(request, pairing.deviceToken)
      const response = await callRuntimeEnvironment(
        options.userDataPath,
        selectedEnvironment,
        'ledger.ui',
        { request, attestation },
        undefined,
        environment.pairingRevision
      )
      if (!response.ok) {
        throwRemoteLedgerError(response)
      }
      return { ok: true, result: response.result as LedgerResponse }
    }
  )
}
