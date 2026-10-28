import { expect, test } from 'bun:test'
import { fitUsagePrefix } from '../src/window/usage-fit'

test('prefix fitting counts every rendered chip gap including the suffix gap', () => {
  const chips = [20, 20, 20]
  const suffixButtons = [0, 14, 14, 14]

  expect(fitUsagePrefix(chips, suffixButtons, 63, 5)).toBe(1)
  expect(fitUsagePrefix(chips, suffixButtons, 64, 5)).toBe(2)
})

test('all providers fit at the exact content-width boundary without a suffix', () => {
  expect(fitUsagePrefix([20, 20, 20], [0, 14, 14, 14], 70, 5)).toBeNull()
})

test('suffix-only remains the chosen projection when no provider fits', () => {
  expect(fitUsagePrefix([50], [0, 42], 42, 5)).toBe(0)
})

test('a wider allocation recovers the largest prefix and then the all-provider row', () => {
  const chips = [40, 45]
  const suffixButtons = [0, 34, 39]

  expect(fitUsagePrefix(chips, suffixButtons, 38, 5)).toBe(0)
  expect(fitUsagePrefix(chips, suffixButtons, 79, 5)).toBe(1)
  expect(fitUsagePrefix(chips, suffixButtons, 90, 5)).toBeNull()
})

test('uses measured suffix-button border-box widths rather than a copied badge width', () => {
  const chips = [32, 32]
  const available = 66

  expect(fitUsagePrefix(chips, [0, 36, 44], available, 5)).toBe(0)
  expect(fitUsagePrefix(chips, [0, 25, 33], available, 5)).toBe(1)
})
