export type BrowserFamily = 'chrome' | 'edge' | 'arc' | 'chromium' | 'comet' | 'helium' | 'firefox' | 'safari'
export type SameSite = 'Strict' | 'Lax' | 'None'
export type Cookie = {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: SameSite
  expires?: number
  hostOnly: boolean
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean }
}
export type ImportSource =
  | { kind: 'file'; path: string }
  | { kind: 'json'; cookies: unknown[] }
  | { kind: 'browser'; family: BrowserFamily; profile?: string }
export type ImportSummary = {
  totalCookies: number
  importedCookies: number
  skippedCookies: number
  googleCookiesSkipped?: number
  partitionSkippedCookies?: number
  domains: string[]
  warning?: { code: string; reasons?: string[] }
}
export type ImportJob = {
  id: string
  profileId: string
  status: 'queued' | 'running' | 'succeeded' | 'failed'
  createdAt: number
  finishedAt?: number
  result?: ImportSummary
  error?: { code: string; message: string }
}
