import { expect, test } from 'bun:test'
import { parse, render, sortForReview } from './decisions'

const log = `# m0-registry decisions

## D1: Contribution IDs are plugin-qualified strings
- **Question:** How are contributions addressed?
- **Reversibility:** hard
- **Confidence:** medium
- **Source:** assumed — autonomous

## D2: Manifests are JSON
- **Reversibility:** easy
- **Confidence:** high
- **Source:** assumed — autonomous

## Progress
Not a decision.
`

test('parses each D-entry and ignores other sections', () => {
  const decisions = parse('m0-registry', log)
  expect(decisions.map((d) => d.id)).toEqual(['D1', 'D2'])
  expect(decisions[0]).toMatchObject({ reversibility: 'hard', confidence: 'medium', source: 'assumed — autonomous' })
})

test('hardest to reverse first, then least confident', () => {
  const decisions = [
    ...parse('b', '## D1: easy one\n- **Reversibility:** easy\n- **Confidence:** low\n'),
    ...parse('a', log),
    ...parse('c', '## D1: hard and unsure\n- **Reversibility:** hard\n- **Confidence:** low\n'),
  ]
  expect(sortForReview(decisions).map((d) => d.title)).toEqual([
    'hard and unsure',
    'Contribution IDs are plugin-qualified strings',
    'easy one',
    'Manifests are JSON',
  ])
})

test('a missing field shows as ? and sorts first, so it gets noticed', () => {
  const decisions = parse('x', '## D1: no fields\n')
  expect(decisions[0].reversibility).toBe('?')
  expect(render([...parse('a', log), ...decisions])).toContain('| ? | ? | [x D1](decisions/x.md) | no fields |')
  expect(sortForReview([...parse('a', log), ...decisions])[0].title).toBe('no fields')
})
