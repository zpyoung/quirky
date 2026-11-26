import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import { UiStateSnapshotSchema, type UiStateSnapshot } from '../../../shared/public-rpc/ui-state'

export const UI_RENDERER_REQUEST_TIMEOUT_MS = 10_000

export type UiBridgeErrorCode = 'invalid_argument' | 'no_ui' | 'not_applicable' | 'renderer_timeout'

/**
 * A refusal from the UI bridge. `message` is the stable code, which is what the RPC layer passes
 * through; `data.reason` carries the human detail for callers that read it.
 */
export class UiBridgeError extends Error {
  readonly code: UiBridgeErrorCode
  readonly data: { reason: string }

  constructor(code: UiBridgeErrorCode, reason: string) {
    super(code)
    this.name = 'UiBridgeError'
    this.code = code
    this.data = { reason }
  }
}

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
      ipcMain.removeListener(channels.reply, handler)
      reject(new UiBridgeError('renderer_timeout', 'the app window did not answer in time'))
    }, UI_RENDERER_REQUEST_TIMEOUT_MS)

    const handler = (event: Electron.IpcMainEvent, reply: TReply): void => {
      if (event.sender !== win.webContents || reply.requestId !== requestId) {
        return
      }
      clearTimeout(timer)
      ipcMain.removeListener(channels.reply, handler)
      resolve(reply)
    }
    ipcMain.on(channels.reply, handler)
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
