// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalApprovalItem,
  AgentJournalRenderItem
} from '../../../../../shared/agent-session-journal-types'
import type { AgentJournalPlanItem } from '../../../../../shared/agent-session-journal-v1-items'
import type { StructuredPromptItem } from '../../native-chat/use-structured-agent-session'
import { PlanPanel } from './PlanPanel'

vi.mock('../markdown', () => ({
  ChatMarkdown: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>
}))
vi.mock('./panel-link-opening', () => ({ openPanelLink: vi.fn() }))

afterEach(cleanup)

function plan(
  version: number,
  status: AgentJournalPlanItem['status'],
  extra: Partial<AgentJournalPlanItem> = {}
): AgentJournalRenderItem {
  return {
    itemId: `plan-${version}`,
    revision: 1,
    sequence: version,
    observedAt: version,
    body: { kind: 'plan', version, status, text: `text of v${version}`, ...extra }
  }
}

function approval(itemId: string): StructuredPromptItem {
  const body: AgentJournalApprovalItem = {
    kind: 'approval',
    title: 'Review proposed plan',
    detail: null,
    options: [
      { id: 'allow', label: 'Approve plan' },
      { id: 'deny', label: 'Keep planning' }
    ],
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
  return { itemId, revision: 3, sequence: 1, observedAt: 1, body }
}

const items = [plan(1, 'revised'), plan(2, 'waiting', { approvalItemId: 'appr-2' })]

describe('PlanPanel', () => {
  it('shows answer controls only on the waiting version with a pending approval', () => {
    render(
      <PlanPanel
        items={items}
        prompts={[approval('appr-2')]}
        respond={vi.fn()}
        onClose={() => {}}
      />
    )
    expect(screen.getByTestId('markdown').textContent).toBe('text of v2')
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /v1/ }))
    expect(screen.getByTestId('markdown').textContent).toBe('text of v1')
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Keep planning' })).toBeNull()
  })

  it('shows no controls when the approval is not pending', () => {
    render(<PlanPanel items={items} prompts={[]} respond={vi.fn()} onClose={() => {}} />)
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  })

  it('answers the approval with the approve option id', async () => {
    const respond = vi.fn().mockResolvedValue({})
    const prompt = approval('appr-2')
    render(<PlanPanel items={items} prompts={[prompt]} respond={respond} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1))
    expect(respond).toHaveBeenCalledWith(prompt, { kind: 'option', optionId: 'allow' })
  })

  it('answers Keep planning with the deny option id and sends the feedback after it', async () => {
    const respond = vi.fn().mockResolvedValue({})
    const onSendMessage = vi.fn().mockResolvedValue(undefined)
    const prompt = approval('appr-2')
    render(
      <PlanPanel
        items={items}
        prompts={[prompt]}
        respond={respond}
        onSendMessage={onSendMessage}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Keep planning' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: ' split step 3 ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send to Claude' }))
    await waitFor(() => expect(onSendMessage).toHaveBeenCalledWith('split step 3'))
    expect(respond).toHaveBeenCalledWith(prompt, { kind: 'option', optionId: 'deny' })
  })

  it('opens on the requested version', () => {
    render(
      <PlanPanel
        items={items}
        prompts={[approval('appr-2')]}
        respond={vi.fn()}
        openVersion={1}
        onClose={() => {}}
      />
    )
    expect(screen.getByTestId('markdown').textContent).toBe('text of v1')
  })
})
