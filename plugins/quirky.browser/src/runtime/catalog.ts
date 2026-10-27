export const BROWSER_METHODS = [
  'profileList', 'profileCreate', 'tabList', 'tabShow', 'tabCurrent', 'tabCreate', 'tabSwitch', 'tabClose',
  'goto', 'eval', 'snapshot', 'fill', 'click', 'screenshot', 'exec'
] as const

export type BrowserMethod = (typeof BROWSER_METHODS)[number]

export const READ_ONLY_METHODS: Readonly<Record<string, true>> = {
  profileList: true,
  tabList: true,
  tabShow: true,
  tabCurrent: true,
  snapshot: true,
  screenshot: true
}

export const DESTRUCTIVE_METHODS: Readonly<Record<string, true>> = {
  tabClose: true
}
