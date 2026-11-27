import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'

/** Cancels an ask by id; used where no card is mounted to own the call. */
export function cancelAsk(askId: string): void {
  void window.api.runtime
    .call({ method: 'ask.cancel', params: { askId } })
    .then((response) => unwrapRuntimeRpcResult(response))
    .catch((error: unknown) => console.error('Failed to cancel ask:', error))
}
