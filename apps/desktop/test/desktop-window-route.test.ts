import { expect, test } from 'bun:test'
import { desktopWindowRouteUrl, folderPickerResult } from '../src/bun/desktop-window-route'

const request = {
  view: 'view:quirky.agent-status/dashboard',
  input: { filter: { hidden: false, status: 'ready' }, selected: ['group:one'] },
  title: 'Agent dashboard'
}

test('an auxiliary window route carries its exact view and input while preserving the daemon token', () => {
  const route = new URL(desktopWindowRouteUrl('http://127.0.0.1:6768/#token=owner-secret', request, 'window-123', { connId: 17, name: 'main-shell' }))
  expect(route.hash).toBe('#token=owner-secret')
  expect(route.searchParams.get('quirkyOwnerShellConnId')).toBe('17')
  expect(route.searchParams.get('quirkyOwnerShellName')).toBe('main-shell')
  expect(route.searchParams.get('quirkyWindowId')).toBe('window-123')
  expect(route.searchParams.get('quirkyView')).toBe(request.view)
  expect(JSON.parse(route.searchParams.get('quirkyInput') ?? 'null')).toEqual(request.input)
  expect(route.searchParams.get('quirkyTitle')).toBe(request.title)
})

test('an empty SDK selection is cancellation; selected SDK paths are preserved exactly', () => {
  expect(folderPickerResult([])).toEqual({ cancelled: true, paths: [] })
  expect(folderPickerResult(['/Users/alice/My Projects', '/Volumes/data'])).toEqual({
    cancelled: false, paths: ['/Users/alice/My Projects', '/Volumes/data']
  })
})
