import { randomUUID } from 'node:crypto'
import type { BrowserWindow, IpcMainEvent } from 'electron'
import { getRuntimeDesktopSurface } from '../runtime-desktop-surface'
import { PublicRpcError } from '../rpc/public-rpc-error'
import { UiStateSnapshotSchema, type UiStateSnapshot } from '../../../shared/public-rpc/ui-state'

export const UI_RENDERER_REQUEST_TIMEOUT_MS = 10_000

export type RendererActionRequest = {
  actionId: string
  worktreeId?: string
  probeOnly?: boolean
}

export type RendererActionReply = { claimed: boolean; reason?: string }

function requestFromRenderer<TReply extends { requestId: string }>(
  win: BrowserWindow,
  channels: { request: string; reply: string },
  payload: Record<string, unknown>
): Promise<TReply> {
  const requestId = randomUUID()
  return new Promise<TReply>((resolve, reject) => {
    const timer = setTimeout(() => {
      getRuntimeDesktopSurface().removeIpcListener(channels.reply, handler)
      reject(
        new PublicRpcError(
          'timeout',
          'renderer_timeout',
          [{ command: 'quirky ui state', why: 'check the window is responsive' }],
          undefined,
          'the app window did not answer in time'
        )
      )
    }, UI_RENDERER_REQUEST_TIMEOUT_MS)

    const handler = (event: IpcMainEvent, reply: TReply): void => {
      if (event.sender !== win.webContents || reply.requestId !== requestId) {
        return
      }
      clearTimeout(timer)
      getRuntimeDesktopSurface().removeIpcListener(channels.reply, handler)
      resolve(reply)
    }
    getRuntimeDesktopSurface().onIpc(channels.reply, handler)
    win.webContents.send(channels.request, { requestId, ...payload })
  })
}

/** Asks the renderer to run (or, with `probeOnly`, only check) one app action. */
export async function requestRendererAction(
  win: BrowserWindow,
  request: RendererActionRequest
): Promise<RendererActionReply> {
  const reply = await requestFromRenderer<{ requestId: string } & RendererActionReply>(
    win,
    { request: 'ui:requestAction', reply: 'ui:actionReply' },
    { ...request }
  )
  return reply.reason === undefined
    ? { claimed: reply.claimed }
    : { claimed: reply.claimed, reason: reply.reason }
}

/** Asks the renderer what the user is looking at. */
export async function requestRendererUiState(win: BrowserWindow): Promise<UiStateSnapshot> {
  const reply = await requestFromRenderer<{ requestId: string; state: UiStateSnapshot }>(
    win,
    { request: 'ui:requestState', reply: 'ui:stateReply' },
    {}
  )
  return UiStateSnapshotSchema.parse(reply.state)
}
