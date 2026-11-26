import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { contrastRatio, parseCssRgbColor, type RgbaColor } from '../lib/terminal-title-contrast'

const mainCss = fs.readFileSync(new URL('./main.css', import.meta.url), 'utf8')

function getCssRuleBody(selector: string): string {
  const ruleMarker = mainCss.indexOf(`\n${selector} {`)
  expect(ruleMarker).toBeGreaterThanOrEqual(0)

  const bodyStart = mainCss.indexOf('{', ruleMarker + 1) + 1
  return mainCss.slice(bodyStart, mainCss.indexOf('\n}', bodyStart))
}

function readToken(block: string, name: string): RgbaColor {
  const match = block.match(new RegExp(`(?:^|\\s)${name}:\\s*([^;]+);`))
  expect(match, `missing ${name} declaration`).not.toBeNull()
  const raw = match![1].trim()
  const color = parseCssRgbColor(raw)
  expect(color, `could not parse ${name} value "${raw}"`).not.toBeNull()
  return color!
}

const MODES = {
  light: getCssRuleBody(':root'),
  dark: getCssRuleBody('.dark')
}

const CANVASES = ['--background', '--sidebar']
const TEXT_TOKENS = [
  '--foreground',
  '--muted-foreground',
  '--agent-done-text',
  '--agent-question-text'
]
const STATUS_TOKENS = [
  '--agent-working',
  '--agent-question',
  '--agent-done',
  '--agent-failed',
  '--workspace-status-done'
]

describe('graphite token contrast', () => {
  for (const [mode, block] of Object.entries(MODES)) {
    describe(mode, () => {
      for (const canvas of CANVASES) {
        for (const token of TEXT_TOKENS) {
          it(`${token} clears 4.5:1 against ${canvas}`, () => {
            const ratio = contrastRatio(readToken(block, token), readToken(block, canvas))
            expect(ratio, `${token} on ${canvas}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
              4.5
            )
          })
        }

        for (const token of STATUS_TOKENS) {
          it(`${token} clears 3:1 against ${canvas}`, () => {
            const ratio = contrastRatio(readToken(block, token), readToken(block, canvas))
            expect(ratio, `${token} on ${canvas}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3)
          })
        }
      }

      it('solid open badge (--agent-done-text under --primary-foreground) clears 4.5:1', () => {
        const ratio = contrastRatio(
          readToken(block, '--primary-foreground'),
          readToken(block, '--agent-done-text')
        )
        expect(ratio, `badge: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5)
      })
    })
  }
})
