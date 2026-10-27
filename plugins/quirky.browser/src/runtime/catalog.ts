export const BROWSER_METHODS = [
  'tabList', 'tabShow', 'tabCurrent', 'tabCreate', 'tabSwitch', 'tabClose',
  'snapshot', 'screenshot', 'fullScreenshot', 'pdf', 'goto', 'back', 'forward', 'reload',
  'click', 'dblclick', 'fill', 'type', 'keyboardInsertText', 'keypress', 'select', 'check', 'uncheck',
  'focus', 'hover', 'scrollIntoView', 'clear', 'selectAll', 'drag', 'upload', 'scroll', 'wait', 'eval', 'get', 'is', 'find',
  'mouseMove', 'mouseDown', 'mouseUp', 'mouseWheel', 'highlight', 'download', 'console', 'network',
  'captureStart', 'captureStop', 'interceptEnable', 'interceptDisable', 'interceptList',
  'cookieGet', 'cookieSet', 'cookieDelete',
  'storageLocalGet', 'storageLocalSet', 'storageLocalClear', 'storageSessionGet', 'storageSessionSet', 'storageSessionClear',
  'viewport', 'geolocation', 'setDevice', 'setOffline', 'setHeaders', 'setCredentials', 'setMedia',
  'clipboardRead', 'clipboardWrite', 'dialogAccept', 'dialogDismiss',
  'profileList', 'profileCreate', 'profileDelete', 'profileShow', 'profileSet', 'profileUseDefault', 'profileClone',
  'detectBrowsers', 'importCookies', 'importStart', 'importGet', 'importList',
  'identityGet', 'identitySet', 'openUrl', 'exec'
] as const

export type BrowserMethod = (typeof BROWSER_METHODS)[number]

export const READ_ONLY_METHODS: Readonly<Record<string, true>> = {
  tabList: true,
  tabShow: true,
  tabCurrent: true,
  profileList: true,
  profileShow: true,
  detectBrowsers: true,
  importGet: true,
  importList: true,
  identityGet: true,
  snapshot: true,
  screenshot: true,
  fullScreenshot: true,
  pdf: true,
  get: true,
  is: true,
  console: true,
  network: true,
  interceptList: true,
  cookieGet: true,
  storageLocalGet: true,
  storageSessionGet: true,
  clipboardRead: true,
}

export const DESTRUCTIVE_METHODS: Readonly<Record<string, true>> = {
  tabClose: true,
  profileDelete: true,
  cookieDelete: true,
  storageLocalClear: true,
  storageSessionClear: true,
  importCookies: true,
  importStart: true
}
