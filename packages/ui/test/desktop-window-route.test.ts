import { expect, test } from 'bun:test'
import { parseDesktopWindowRoute } from '../src/desktop-bridge'

test('a native window route carries its daemon owner and exact view input', () => {
  const input = { filters: { hidden: false, group: 'ready' } }
  const route = parseDesktopWindowRoute(
    `http://127.0.0.1:6768/?quirkyWindowId=window-123&quirkyOwnerShellConnId=17&quirkyView=${encodeURIComponent('view:quirky.agent-status/dashboard')}&quirkyInput=${encodeURIComponent(JSON.stringify(input))}&quirkyTitle=Dashboard#token=local`
  )
  expect(route).toEqual({
    windowId: 'window-123',
    ownerShellConnId: 17,
    view: 'view:quirky.agent-status/dashboard',
    input,
    title: 'Dashboard',
    attached: false
  })
})

test('a partial or ambiguous window route is refused rather than becoming the global layout', () => {
  expect(parseDesktopWindowRoute('http://127.0.0.1:6768/?quirkyView=view%3Aquirky.agent-status%2Fdashboard')).toBeNull()
  expect(parseDesktopWindowRoute('http://127.0.0.1:6768/?quirkyWindowId=a&quirkyWindowId=b&quirkyView=view%3Aquirky.agent-status%2Fdashboard&quirkyOwnerShellConnId=17')).toBeNull()
})
