export const QUIRKY_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY = '__quirkyFeatureInteractionSource'

export const QUIRKY_RUNTIME_RPC_BROWSER_UI_SOURCE = 'browser-pane-ui'

export function withBrowserPaneUiRuntimeRpcSource(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {
      [QUIRKY_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY]: QUIRKY_RUNTIME_RPC_BROWSER_UI_SOURCE
    }
  }
  return {
    ...value,
    [QUIRKY_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY]: QUIRKY_RUNTIME_RPC_BROWSER_UI_SOURCE
  }
}

export function isBrowserPaneUiRuntimeRpcParams(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>)[QUIRKY_RUNTIME_RPC_FEATURE_INTERACTION_SOURCE_KEY] ===
      QUIRKY_RUNTIME_RPC_BROWSER_UI_SOURCE
  )
}
