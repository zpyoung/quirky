import type { DesktopWindowOwner, DesktopWindowRequest, FolderPickerResult } from '@quirky/protocol'

export function desktopWindowRouteUrl(
  baseUrl: string,
  request: DesktopWindowRequest,
  windowId: string,
  ownerShell: DesktopWindowOwner
): string {
  if (windowId.length === 0 || request.view.length === 0 || !Number.isSafeInteger(ownerShell.connId) || ownerShell.connId < 1) {
    throw new Error('native window route identity is incomplete')
  }
  const url = new URL(baseUrl)
  url.searchParams.set('quirkyWindowId', windowId)
  url.searchParams.set('quirkyOwnerShellConnId', String(ownerShell.connId))
  if (ownerShell.name !== undefined) url.searchParams.set('quirkyOwnerShellName', ownerShell.name)
  else url.searchParams.delete('quirkyOwnerShellName')
  url.searchParams.set('quirkyView', request.view)
  url.searchParams.delete('quirkyInput')
  if (request.input !== undefined) url.searchParams.set('quirkyInput', JSON.stringify(request.input))
  else url.searchParams.delete('quirkyInput')
  if (request.title !== undefined) url.searchParams.set('quirkyTitle', request.title)
  else url.searchParams.delete('quirkyTitle')
  return url.toString()
}

export function folderPickerResult(paths: string[]): FolderPickerResult {
  return { cancelled: paths.length === 0, paths }
}
