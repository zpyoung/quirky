/**
 * Where the native traffic lights sit in the main window's 40-high bar: the default placement is
 * centered in a 28-high title bar, so the lights move down by half the difference.
 */
export const MAIN_WINDOW_TRAFFIC_LIGHT_OFFSET = { x: 0, y: 6 }

/** The main window draws its own bar under inset traffic lights; auxiliary windows keep the system title bar. */
export function nativeWindowOptions(lifecycle: { kind: 'main' | 'auxiliary' }) {
  return lifecycle.kind === 'main'
    ? { titleBarStyle: 'hiddenInset' as const, trafficLightOffset: MAIN_WINDOW_TRAFFIC_LIGHT_OFFSET }
    : {}
}
