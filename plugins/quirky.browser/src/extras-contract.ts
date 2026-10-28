/** Additional automation methods; existing pane/preferences owners remain canonical. */
export const EXTRAS_METHODS = [
  'fullScreenshot', 'pdf', 'back', 'forward', 'reload',
  'dblclick', 'type', 'keyboardInsertText', 'keypress', 'select', 'check', 'uncheck',
  'focus', 'hover', 'scrollIntoView', 'clear', 'selectAll', 'drag', 'upload', 'scroll', 'wait', 'get', 'is', 'find',
  'mouseMove', 'mouseDown', 'mouseUp', 'mouseWheel', 'highlight', 'download', 'console', 'network',
  'captureStart', 'captureStop', 'interceptEnable', 'interceptDisable', 'interceptList',
  'cookieGet', 'cookieSet', 'cookieDelete',
  'storageLocalGet', 'storageLocalSet', 'storageLocalClear', 'storageSessionGet', 'storageSessionSet', 'storageSessionClear',
  'viewport', 'geolocation', 'setDevice', 'setOffline', 'setHeaders', 'setCredentials', 'setMedia',
  'clipboardRead', 'clipboardWrite', 'dialogAccept', 'dialogDismiss',
  'tabProfileShow', 'tabProfileSet', 'tabProfileUseDefault', 'profileClone',
  'detectBrowsers', 'importCookies', 'importStart', 'importGet', 'importList',
  'identityGet', 'identitySet', 'openUrl'
] as const
export type ExtrasMethod = (typeof EXTRAS_METHODS)[number]
