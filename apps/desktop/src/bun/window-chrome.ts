/**
 * Where the native traffic lights sit in the main window's 40-high bar. The value comes from
 * measuring a real window, where this offset centers the lights on the bar's own controls.
 */
export const MAIN_WINDOW_TRAFFIC_LIGHT_OFFSET = { x: 0, y: 4 }

/** The main window draws its own bar under inset traffic lights; auxiliary windows keep the system title bar. */
export function nativeWindowOptions(lifecycle: { kind: 'main' | 'auxiliary' }) {
  return lifecycle.kind === 'main'
    ? { titleBarStyle: 'hiddenInset' as const, trafficLightOffset: MAIN_WINDOW_TRAFFIC_LIGHT_OFFSET }
    : {}
}
