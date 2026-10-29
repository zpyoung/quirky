import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allowLabelHosts } from '../scripts/allow-label-hosts'

function readAts(plist: string): unknown {
  const result = spawnSync('plutil', ['-extract', 'NSAppTransportSecurity', 'json', '-o', '-', plist], { encoding: 'utf8' })
  return result.status === 0 ? JSON.parse(result.stdout) : null
}

describe.if(process.platform === 'darwin')('label host ATS exception', () => {
  test('merges a quirky.localhost exception into each app bundle and keeps existing ATS keys', () => {
    const build = mkdtempSync(join(tmpdir(), 'quirky-ats-'))
    try {
      const plist = join(build, 'Quirky-dev.app', 'Contents', 'Info.plist')
      mkdirSync(join(build, 'Quirky-dev.app', 'Contents'), { recursive: true })
      writeFileSync(plist, '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>dev.quirky.app</string></dict></plist>\n')
      expect(allowLabelHosts(build)).toEqual([plist])
      const label = { NSIncludesSubdomains: true, NSExceptionAllowsInsecureHTTPLoads: true }
      expect(readAts(plist)).toEqual({ NSExceptionDomains: { 'quirky.localhost': label } })

      spawnSync('plutil', ['-replace', 'NSAppTransportSecurity', '-json', '{"NSAllowsLocalNetworking":true,"NSExceptionDomains":{"example.test":{"NSIncludesSubdomains":true}}}', plist])
      allowLabelHosts(build)
      expect(readAts(plist)).toEqual({
        NSAllowsLocalNetworking: true,
        NSExceptionDomains: { 'example.test': { NSIncludesSubdomains: true }, 'quirky.localhost': label }
      })
    } finally {
      rmSync(build, { recursive: true, force: true })
    }
  })
})
