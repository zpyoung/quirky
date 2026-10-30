import { expect, test } from 'bun:test'
import { MAIN_WINDOW_TRAFFIC_LIGHT_OFFSET, nativeWindowOptions } from '../src/bun/window-chrome'

test('only the main window gets inset traffic lights and the offset that centers them in the bar', () => {
  expect(nativeWindowOptions({ kind: 'main' })).toEqual({
    titleBarStyle: 'hiddenInset',
    trafficLightOffset: MAIN_WINDOW_TRAFFIC_LIGHT_OFFSET
  })
  expect(nativeWindowOptions({ kind: 'auxiliary' })).toEqual({})
})
