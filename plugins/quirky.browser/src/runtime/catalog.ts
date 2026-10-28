import { EXTRAS_METHODS } from '../extras-contract'
import { DESIGN_METHODS } from '../design-contract'
import { PANE_METHODS } from '../pane-contract'

export const BROWSER_METHODS = [
  'profileList', 'profileCreate', 'tabList', 'tabShow', 'tabCurrent', 'tabCreate', 'tabSwitch', 'tabClose',
  ...PANE_METHODS,
  ...DESIGN_METHODS,
  ...EXTRAS_METHODS
]

export type BrowserMethod = (typeof BROWSER_METHODS)[number]

export const READ_ONLY_METHODS: Readonly<Record<string, true>> = {
  profileList: true,
  tabList: true,
  tabShow: true,
  tabCurrent: true,
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
  tabProfileShow: true,
  detectBrowsers: true,
  importGet: true,
  importList: true,
  identityGet: true,
  designRead: true,
  designHover: true,
  designCapture: true,
  designFormat: true,
  designTargets: true
}

export const DESTRUCTIVE_METHODS: Readonly<Record<string, true>> = {
  tabClose: true,
  cookieDelete: true,
  storageLocalClear: true,
  storageSessionClear: true,
  importCookies: true,
  importStart: true
}
