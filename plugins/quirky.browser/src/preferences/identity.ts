import type { BrowserIdentityMode } from './contract'

export function identityModeFromSetting(value: unknown): BrowserIdentityMode {
  return value === 'native' ? 'native' : 'clean'
}

export function userAgentForIdentity(mode: BrowserIdentityMode, actualUserAgent: string): string {
  if (mode === 'native') return actualUserAgent
  return actualUserAgent
    .replace(/\bHeadlessChrome(?=\/)/g, 'Chrome')
    .replace(/\s*\b(?:Quirky|Electrobun|Electron)(?:\/[^\s;)]+)?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
}
