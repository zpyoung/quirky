import { describe, expect, test } from 'bun:test'
import { replacementMode } from '../../src/window/model'
import type { AgentListing } from '../../src/core/types'

const listing = (summary: AgentListing['permissions']['summary'], nonAuto: AgentListing['permissions']['nonAuto']): AgentListing => ({
  defaultAgent: 'auto',
  workspaceTrust: true,
  permissions: { summary, nonAuto },
  agents: []
})

describe('the mode "Replace with" offers for custom arguments', () => {
  test.each([
    ['yolo', 'yolo', true, 'yolo'],
    ['manual', 'manual', false, 'manual'],
    ['auto', 'yolo', true, 'auto'],
    ['auto', 'manual', false, 'manual'],
    ['auto', 'mixed', false, 'yolo'],
    ['mixed', 'manual', true, 'manual'],
    ['mixed', 'mixed', true, 'yolo']
  ] as const)('summary %s with others %s (Auto available: %s) offers %s', (summary, nonAuto, hasAuto, expected) => {
    expect(replacementMode(listing(summary, nonAuto), hasAuto)).toBe(expected)
  })
})
