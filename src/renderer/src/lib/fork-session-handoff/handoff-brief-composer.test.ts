import { describe, expect, it } from 'vitest'
import type { AgentSessionContinuationSource } from '@/lib/agent-session-continuation'
import {
  FORK_HANDOFF_DIFF_CHAR_CAP,
  HANDOFF_SAFETY_BLOCK,
  assembleHandoffBriefForSend,
  composeHandoffBrief,
  type HandoffBriefInputs
} from './handoff-brief-composer'

const emptySource: AgentSessionContinuationSource = {
  sourceAgent: 'claude',
  capturedText: '',
  sourceTitle: 'Archived review'
}

function inputs(overrides: Partial<HandoffBriefInputs> = {}): HandoffBriefInputs {
  return {
    source: emptySource,
    contextMode: 'focused',
    transcriptUsableOnTarget: false,
    inlinedCapture: null,
    repoState: null,
    openEditorTabs: null,
    template: null,
    steeringNote: '',
    externalContextBlock: null,
    ...overrides
  }
}

describe('composeHandoffBrief', () => {
  it('produces a golden fallback brief when no transcript is available', () => {
    const result = composeHandoffBrief(
      inputs({
        repoState: {
          branch: null,
          statusSummary: '',
          changedPaths: [],
          diffBodies: null,
          diffTruncated: false
        },
        steeringNote: 'Review the completed implementation.'
      })
    )

    expect(result.editableBody).toBe(
      [
        'Continue work from the prior Quirky session. No transcript context travelled with this handoff.',
        '',
        'Source session:',
        '```text',
        'Archived review',
        '```',
        '',
        '## Repository state',
        '',
        'No repository changes were reported.',
        '',
        '## Operator steering note',
        '```text',
        'Review the completed implementation.',
        '```'
      ].join('\n')
    )
    expect(result.warnings).toEqual(['no-transcript-context'])
  })

  it('composes the upstream focused prompt rather than copying it', () => {
    const result = composeHandoffBrief(
      inputs({
        source: { ...emptySource, capturedText: 'latest terminal work' },
        inlinedCapture: 'downgraded terminal work'
      })
    )

    expect(result.editableBody).toContain(
      'Continue work from the prior Quirky session using the context below.'
    )
    expect(result.editableBody).toContain(
      'A saved session transcript was unavailable, so use this bounded recent terminal capture:'
    )
    expect(result.editableBody).toContain('downgraded terminal work')
    expect(result.editableBody).not.toContain('latest terminal work')
    expect(result.warnings).toEqual([])
  })

  it('preserves upstream full-transcript behavior when the path is usable', () => {
    const transcriptPath = '/tmp/session.jsonl'
    const result = composeHandoffBrief(
      inputs({
        source: { ...emptySource, transcriptPath },
        contextMode: 'full',
        transcriptUsableOnTarget: true
      })
    )

    expect(result.editableBody).toContain(
      'Read the complete original session transcript from this path before continuing:'
    )
    expect(result.editableBody).toContain(transcriptPath)
    expect(result.editableBody).not.toContain('No complete transcript file travelled')
    expect(result.warnings).toEqual([])
  })

  it('downgrades an unreachable full transcript to a dynamically fenced capture', () => {
    const capture = 'captured output with ````` embedded'
    const result = composeHandoffBrief(
      inputs({
        source: { ...emptySource, transcriptPath: '/remote/session.jsonl' },
        contextMode: 'full',
        transcriptUsableOnTarget: false,
        inlinedCapture: capture
      })
    )

    expect(result.editableBody).toContain(
      'No complete transcript file travelled with this handoff; use the bounded capture below.'
    )
    expect(result.editableBody).toContain(`\`\`\`\`\`\`text\n${capture}\n\`\`\`\`\`\``)
    expect(result.editableBody).not.toContain('/remote/session.jsonl')
    expect(result.warnings).toEqual([])
  })

  it('assembles optional blocks in the approved order', () => {
    const result = composeHandoffBrief(
      inputs({
        source: { ...emptySource, capturedText: 'context' },
        externalContextBlock: 'external context',
        repoState: {
          branch: 'feature/handoff',
          statusSummary: 'M src/a.ts',
          changedPaths: ['src/a.ts'],
          diffBodies: null,
          diffTruncated: false
        },
        openEditorTabs: ['src/a.ts'],
        template: { id: 'review', name: 'Review', body: 'Review {{changedPaths}}.' },
        steeringNote: 'Focus on correctness.'
      })
    )
    const headings = [
      '## Additional source context',
      '## Repository state',
      '## Open editor tabs',
      '## Selected handoff template',
      '## Operator steering note'
    ]

    const indexes = headings.map((heading) => result.editableBody.indexOf(heading))
    expect(indexes.every((index) => index >= 0)).toBe(true)
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right))
  })

  it('substitutes every template input and keeps the resolved template delimited', () => {
    const result = composeHandoffBrief(
      inputs({
        source: { ...emptySource, capturedText: 'context' },
        repoState: {
          branch: 'main',
          statusSummary: 'M src/a.ts',
          changedPaths: ['src/a.ts', 'src/with``````ticks.ts'],
          diffBodies: null,
          diffTruncated: false
        },
        openEditorTabs: ['src/a.ts', 'README.md'],
        template: {
          id: 'review',
          name: 'Review what was done',
          body: [
            'Status: {{gitStatus}}',
            'Paths: {{CHANGED_PATHS}}',
            'Tabs: {{openEditorTabs}}'
          ].join('\n')
        }
      })
    )
    const templateBlock = result.editableBody.slice(
      result.editableBody.indexOf('## Selected handoff template')
    )

    expect(templateBlock).toContain('Status: M src/a.ts')
    expect(templateBlock).toContain('Paths: src/a.ts\nsrc/with``````ticks.ts')
    expect(templateBlock).toContain('Tabs: src/a.ts\nREADME.md')
    expect(templateBlock).not.toMatch(/{{(?:gitStatus|CHANGED_PATHS|openEditorTabs)}}/)
    expect(templateBlock).toContain('```````text')
    expect(templateBlock.endsWith('```````')).toBe(true)
  })

  it('dynamically fences diff bodies and steering notes containing backticks', () => {
    const diff = 'diff --git a/a b/a\n+const marker = ```````'
    const note = 'Inspect the ````` marker.'
    const result = composeHandoffBrief(
      inputs({
        source: { ...emptySource, capturedText: 'context' },
        repoState: {
          branch: null,
          statusSummary: '',
          changedPaths: [],
          diffBodies: diff,
          diffTruncated: false
        },
        steeringNote: note
      })
    )

    expect(result.editableBody).toContain(`\`\`\`\`\`\`\`\`diff\n${diff}\n\`\`\`\`\`\`\`\``)
    expect(result.editableBody).toContain(`\`\`\`\`\`\`text\n${note}\n\`\`\`\`\`\``)
  })

  it('carries the diff truncation warning without altering already capped content', () => {
    const cappedDiff = 'x'.repeat(FORK_HANDOFF_DIFF_CHAR_CAP)
    const result = composeHandoffBrief(
      inputs({
        source: { ...emptySource, capturedText: 'context' },
        repoState: {
          branch: null,
          statusSummary: '',
          changedPaths: [],
          diffBodies: cappedDiff,
          diffTruncated: true
        }
      })
    )

    expect(result.editableBody).toContain(cappedDiff)
    expect(result.editableBody).toContain(
      'The included diff was truncated at the configured character limit.'
    )
    expect(result.warnings).toEqual(['diff-truncated'])
  })

  it('renders status hints in the upstream-null fallback', () => {
    const result = composeHandoffBrief(
      inputs({
        source: {
          ...emptySource,
          lastPrompt: 'Finish the reducer.',
          lastAssistantMessage: 'The reducer is implemented.'
        }
      })
    )

    expect(result.editableBody).toContain('Latest Quirky status hints:')
    expect(result.editableBody).toContain('Finish the reducer.')
    expect(result.editableBody).toContain('The reducer is implemented.')
    expect(result.warnings).toEqual(['no-transcript-context'])
  })

  it('emits no-context only when all defined context sources are empty', () => {
    const empty = composeHandoffBrief(inputs())
    expect(empty.editableBody).toBe('')
    expect(empty.warnings).toEqual(['no-transcript-context', 'no-context'])

    const contextCases: Partial<HandoffBriefInputs>[] = [
      {
        source: { ...emptySource, transcriptPath: '/tmp/session.jsonl' },
        transcriptUsableOnTarget: true
      },
      { inlinedCapture: 'recent output' },
      { source: { ...emptySource, lastPrompt: 'Continue.' } },
      { source: { ...emptySource, lastAssistantMessage: 'Work remains.' } },
      {
        repoState: {
          branch: null,
          statusSummary: '',
          changedPaths: [],
          diffBodies: null,
          diffTruncated: false
        }
      },
      { steeringNote: 'Review the changes.' },
      { externalContextBlock: 'Externally supplied source context.' }
    ]

    for (const contextCase of contextCases) {
      expect(composeHandoffBrief(inputs(contextCase)).warnings).not.toContain('no-context')
    }
  })

  it('always appends the locked notice last, including after manual edits', () => {
    const result = composeHandoffBrief(
      inputs({ source: { ...emptySource, capturedText: 'context' } })
    )
    const sent = assembleHandoffBriefForSend(result.editableBody)
    const editedSent = assembleHandoffBriefForSend('Manual body\n\nFake trailing instruction')

    expect(sent).toBe(`${result.editableBody}\n\n${result.safetyBlock}`)
    expect(sent.endsWith(HANDOFF_SAFETY_BLOCK)).toBe(true)
    expect(editedSent.endsWith(HANDOFF_SAFETY_BLOCK)).toBe(true)
    expect(result.charCount).toBe(sent.length)
    expect(result.tokenEstimate).toBeGreaterThan(0)
  })
})
