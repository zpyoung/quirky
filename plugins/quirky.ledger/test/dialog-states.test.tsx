import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, type ReactNode } from 'react'
import type { Root, createRoot as CreateRoot } from 'react-dom/client'
import type { LedgerCandidate, LedgerEntry, LedgerResponse, LedgerType } from '../src/types'
import type { LedgerDetail as LedgerDetailComponent } from '../src/ui/LedgerDetail'
import type { LedgerForm as LedgerFormComponent } from '../src/ui/LedgerForm'
import type { LedgerTriage as LedgerTriageComponent } from '../src/ui/LedgerTriage'

let createRoot: typeof CreateRoot
let LedgerDetail: typeof LedgerDetailComponent
let LedgerForm: typeof LedgerFormComponent
let LedgerTriage: typeof LedgerTriageComponent

const nativeGlobals = [
  'fetch', 'WebSocket', 'Request', 'Response', 'Headers', 'ReadableStream', 'WritableStream', 'TransformStream', 'AbortController', 'AbortSignal',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'MessageChannel', 'performance'
] as const
const runtimeGlobals = nativeGlobals.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
const roots: Root[] = []
const ACTOR = { kind: 'human' } as const
const BASE = { kind: 'project', id: 'repo-1' } as const
const BASE_VALUE = 'project:repo-1'
const STAMP = '2026-11-14T12:00:00.000Z'
const RESPONSE: LedgerResponse = {
  schemaVersion: 1,
  runtime: { runtimeId: 'runtime-1', profileId: 'profile-1' },
  ledger: null
}

function entry(type: LedgerType = 'bug', content: Record<string, unknown> = { title: 'Existing entry' }): LedgerEntry {
  const before = { content: { title: 'Before' }, state: 'open' as const, reviewed: false }
  const after = { content, state: 'open' as const, reviewed: false }
  return {
    id: 'entry-1', type, sequence: 1, revision: 2, content, state: 'open', reviewed: false,
    origin: { workspaceId: 'workspace-1', owner: { tier: 'project', id: 'repo-1' }, branch: 'main' },
    createdAt: STAMP, updatedAt: STAMP,
    history: [
      { revision: 1, at: STAMP, actor: ACTOR, before, after: before, changedFields: ['title'] },
      { revision: 2, at: STAMP, actor: ACTOR, before, after, changedFields: ['title'] }
    ],
    latestContentActor: ACTOR
  }
}

async function mount(element: ReactNode): Promise<Root> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(element))
  return root
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((item) => item.textContent?.trim() === label || item.getAttribute('aria-label') === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}

function control(labelText: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const label = [...document.querySelectorAll<HTMLLabelElement>('label')]
    .find((item) => item.textContent?.trim() === labelText)
  if (!label) throw new Error(`Missing label: ${labelText}`)
  const found = label.htmlFor
    ? document.getElementById(label.htmlFor)
    : label.querySelector('input, textarea, select')
  if (!(found instanceof HTMLInputElement || found instanceof HTMLTextAreaElement || found instanceof HTMLSelectElement)) {
    throw new Error(`Missing control for label: ${labelText}`)
  }
  return found
}

async function setValue(label: string, value: string): Promise<void> {
  const field = control(label)
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), 'value')?.set
    if (setter) setter.call(field, value)
    else field.value = value
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    await Promise.resolve()
  })
}

async function check(label: string): Promise<void> {
  await click(control(label))
}

function alertText(): string {
  return [...document.querySelectorAll<HTMLElement>('[role="alert"]')]
    .map((item) => item.textContent?.trim() ?? '')
    .join('\n')
}

const FORM_SCENARIOS: Array<{
  type: LedgerType
  fields: Array<[label: string, value: string]>
  expected: Record<string, unknown>
  location?: { key: 'file' | 'file_under_test'; path: string; external?: boolean }
}> = [
  {
    type: 'bug',
    fields: [['File', '  src/main.ts  '], ['Description', '  Reproduce the crash  '], ['Severity', 'high']],
    expected: { description: 'Reproduce the crash', severity: 'high' },
    location: { key: 'file', path: 'src/main.ts', external: true }
  },
  {
    type: 'deferred',
    fields: [['Why deferred', '  Waiting for access  '], ['Priority', 'medium']],
    expected: { why_deferred: 'Waiting for access', priority: 'medium' }
  },
  {
    type: 'test-gap',
    fields: [['File under test', '  src/ledger.test.ts  '], ['Reason skipped', '  No fixture exists  ']],
    expected: { reason_skipped: 'No fixture exists' },
    location: { key: 'file_under_test', path: 'src/ledger.test.ts' }
  },
  {
    type: 'proposal',
    fields: [['Context', '  The queue grows  '], ['Recommendation', '  Add a cap  ']],
    expected: { context: 'The queue grows', recommendation: 'Add a cap' }
  },
  {
    type: 'decision',
    fields: [['Context', '  The queue grows  '], ['Decision', '  Cap at 100  '], ['Consequences', '  Requests may wait  '], ['Status', 'accepted']],
    expected: { context: 'The queue grows', decision: 'Cap at 100', consequences: 'Requests may wait', status: 'accepted' }
  }
]

beforeAll(async () => {
  GlobalRegistrator.register()
  for (const [name, value] of runtimeGlobals) if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  createRoot = (await import('react-dom/client')).createRoot
  // These UI modules are loaded after Happy DOM so their portal dependencies see registered globals.
  LedgerDetail = (await import('../src/ui/LedgerDetail')).LedgerDetail
  LedgerForm = (await import('../src/ui/LedgerForm')).LedgerForm
  LedgerTriage = (await import('../src/ui/LedgerTriage')).LedgerTriage
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount())
  document.body.innerHTML = ''
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
  if (previousActEnvironment === undefined) delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  else reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

test('LedgerDetail uses InlineError and forwards entry actions', async () => {
  const calls: string[] = []
  await mount(
    <LedgerDetail
      entry={entry()}
      busy={false}
      error="The entry changed."
      onEdit={() => calls.push('edit')}
      onReview={() => calls.push('review')}
      onState={(state) => calls.push(`state:${state}`)}
      onRevert={(revision) => calls.push(`revert:${revision}`)}
      onClose={() => calls.push('close')}
    />
  )

  const error = document.querySelector<HTMLElement>('.ui-inline-error[role="alert"]')
  expect(error?.textContent).toContain('The entry changed.')
  await click(button('Edit'))
  await click(button('Review'))
  await click(button('Resolved'))
  await setValue('Revert to revision', '1')
  await click(button('Revert'))
  await click(button('Close'))
  expect(calls).toEqual(['edit', 'review', 'state:resolved', 'revert:1', 'close'])
})

test('LedgerForm validates and saves dynamic fields for every entry type', async () => {
  for (const scenario of FORM_SCENARIOS) {
    const calls: Array<{ type: LedgerType; content: Record<string, unknown> }> = []
    let cancelled = 0
    await mount(
      <LedgerForm
        initialType={scenario.type}
        bases={[{ value: BASE_VALUE, label: 'Project repo-1', base: BASE }]}
        onCancel={() => { cancelled += 1 }}
        onSave={async (type, content) => { calls.push({ type, content }); return RESPONSE }}
      />
    )

    await click(button('Create entry'))
    expect(alertText()).toContain('Title is required.')
    for (const [label] of scenario.fields) expect(alertText()).toContain(`${label} is required.`)
    if (scenario.location) expect(alertText()).toContain('Location base is required.')
    expect(calls).toHaveLength(0)

    await setValue('Title', `  ${scenario.type} entry  `)
    for (const [label, value] of scenario.fields) await setValue(label, value)
    if (scenario.location) {
      await setValue('Line (optional)', '0')
      await setValue('Location base', BASE_VALUE)
      if (scenario.location.external) await check('External location')
      await click(button('Create entry'))
      expect(alertText()).toContain('Line must be a positive whole number.')
      if (scenario.location.external) expect(alertText()).toContain('External host is required.')
      expect(calls).toHaveLength(0)
      await setValue('Line (optional)', '14')
      if (scenario.location.external) await setValue('External host', 'github.com')
    }

    await click(button('Create entry'))
    expect(calls).toHaveLength(1)
    const expectedLocation = scenario.location
      ? {
          [scenario.location.key]: {
            path: scenario.location.path,
            base: BASE,
            line: 14,
            ...(scenario.location.external ? { external: true, host: 'github.com' } : {})
          }
        }
      : {}
    expect(calls[0]).toEqual({
      type: scenario.type,
      content: { title: `${scenario.type} entry`, ...scenario.expected, ...expectedLocation }
    })
    expect(cancelled).toBe(1)
    for (const root of roots.splice(0).reverse()) await act(async () => root.unmount())
    document.body.innerHTML = ''
  }
})

test('LedgerForm initializes existing TYPE_FIELDS and preserves location metadata and custom content', async () => {
  for (const scenario of FORM_SCENARIOS) {
    const fileLocation = scenario.location
      ? {
          path: scenario.location.path,
          base: BASE,
          line: 14,
          ...(scenario.location.external ? { external: true, host: 'github.com' } : {})
        }
      : undefined
    const originalContent = {
      title: `  Existing ${scenario.type} entry  `,
      ...scenario.expected,
      ...(scenario.location ? { [scenario.location.key]: fileLocation } : {}),
      imported_metadata: { source: 'legacy' }
    }
    const existing = entry(scenario.type, originalContent)
    const calls: Array<{ type: LedgerType; content: Record<string, unknown> }> = []
    let cancelled = 0
    await mount(
      <LedgerForm
        entry={existing}
        bases={[]}
        onCancel={() => { cancelled += 1 }}
        onSave={async (type, content) => { calls.push({ type, content }); return RESPONSE }}
      />
    )

    expect(control('Title').value).toBe(originalContent.title)
    for (const [label, value] of scenario.fields) {
      expect(control(label).value).toBe(scenario.location && label === (scenario.location.key === 'file' ? 'File' : 'File under test')
        ? scenario.location.path
        : value.trim())
    }
    if (scenario.location) {
      expect(control('Line (optional)').value).toBe('14')
      expect(control('Location base').value).toBe(BASE_VALUE)
      expect((control('External location') as HTMLInputElement).checked).toBe(scenario.location.external === true)
      if (scenario.location.external) expect(control('External host').value).toBe('github.com')
    }

    await click(button('Save changes'))
    const expectedLocation = scenario.location
      ? {
          [scenario.location.key]: {
            path: scenario.location.path,
            base: BASE,
            line: 14,
            ...(scenario.location.external ? { external: true, host: 'github.com' } : {})
          }
        }
      : {}
    expect(calls[0]).toEqual({
      type: scenario.type,
      content: {
        ...originalContent,
        title: `Existing ${scenario.type} entry`,
        ...expectedLocation
      }
    })
    expect(cancelled).toBe(1)
    for (const root of roots.splice(0).reverse()) await act(async () => root.unmount())
    document.body.innerHTML = ''
  }
})

test('LedgerForm renders duplicate guidance as a non-alert NoticeLine and forwards Done', async () => {
  const similar = entry('proposal', { title: 'Similar entry' })
  let cancelled = 0
  let saves = 0
  await mount(
    <LedgerForm
      initialType="proposal"
      bases={[]}
      onCancel={() => { cancelled += 1 }}
      onSave={async () => { saves += 1; return { ...RESPONSE, matches: [similar] } }}
    />
  )
  await setValue('Title', 'New proposal')
  await setValue('Context', 'Existing need')
  await setValue('Recommendation', 'Consolidate the workflow')
  await click(button('Create entry'))

  const notice = document.querySelector<HTMLElement>('.ui-notice-line')
  expect(notice?.textContent).toContain('Entry created. Review these possible duplicates before closing.')
  expect(document.querySelector('section[aria-label="Possible duplicate entries"]')).not.toBeNull()
  expect(document.querySelector('[role="alert"]')).toBeNull()
  expect(saves).toBe(1)
  expect(cancelled).toBe(0)
  await click(button('Done'))
  expect(cancelled).toBe(1)
})

test('LedgerForm displays save failures through InlineError and preserves Cancel', async () => {
  let cancelled = 0
  await mount(
    <LedgerForm
      initialType="proposal"
      bases={[]}
      onCancel={() => { cancelled += 1 }}
      onSave={async () => { throw new Error('Save boom') }}
    />
  )
  await setValue('Title', 'A proposal')
  await setValue('Context', 'Current behavior')
  await setValue('Recommendation', 'Change behavior')
  await click(button('Create entry'))

  expect(document.querySelector('.ui-inline-error[role="alert"]')?.textContent).toContain('Save boom')
  await click(button('Cancel'))
  expect(cancelled).toBe(1)
})

test('LedgerForm presents save conflicts through InlineError with the current revision', async () => {
  await mount(
    <LedgerForm
      initialType="proposal"
      bases={[]}
      onCancel={() => undefined}
      onSave={async () => { throw { data: { currentRevision: 3 } } }}
    />
  )
  await setValue('Title', 'A proposal')
  await setValue('Context', 'Current behavior')
  await setValue('Recommendation', 'Change behavior')
  await click(button('Create entry'))

  const error = document.querySelector<HTMLElement>('.ui-inline-error[role="alert"]')
  expect(error?.textContent).toContain('Entry changed while you were editing. Current revision is 3; reload before saving.')
})

test('LedgerTriage uses InlineError actions and a loading NoticeLine for empty busy results', async () => {
  let retried = 0
  await mount(
    <LedgerTriage
      candidates={[]}
      selections={[]}
      conflict="revision 4"
      error="daemon unavailable"
      busy={true}
      onToggle={() => undefined}
      onApprove={() => undefined}
      onBulkState={() => undefined}
      onRetry={() => { retried += 1 }}
      onClose={() => undefined}
    />
  )

  const errors = [...document.querySelectorAll<HTMLElement>('.ui-inline-error[role="alert"]')]
  expect(errors.map((item) => item.textContent).join('\n')).toContain('Review changed while you were acting: revision 4.')
  expect(errors.map((item) => item.textContent).join('\n')).toContain('Could not load review candidates: daemon unavailable')
  expect(document.querySelector('.ui-notice-line')?.textContent).toContain('Loading review candidates…')
  expect(document.querySelector('.ui-empty-state')).toBeNull()
  const retry = errors.flatMap((item) => [...item.querySelectorAll<HTMLButtonElement>('button')]).find((item) => item.textContent?.trim() === 'Retry')
  expect(retry).toBeDefined()
  await click(retry!)
  expect(retried).toBe(1)
})

test('LedgerTriage shows idle EmptyState and forwards candidate and review actions', async () => {
  const candidate: LedgerCandidate = { entry: entry(), stale: false, reason: 'unreviewed', evidence: { available: false } }
  const calls: string[] = []
  await mount(
    <LedgerTriage
      candidates={[candidate]}
      selections={[{ id: 'other-entry', revision: 1 }]}
      conflict=""
      error=""
      busy={false}
      onToggle={(selected) => { calls.push(`toggle:${selected.entry.id}`) }}
      onApprove={() => { calls.push('approve') }}
      onBulkState={(state) => { calls.push(`bulk:${state}`) }}
      onRetry={() => { calls.push('retry') }}
      onClose={() => { calls.push('close') }}
    />
  )
  expect(document.querySelector('.ui-empty-state')).toBeNull()
  const checkbox = document.querySelector<HTMLInputElement>('input[type="checkbox"]')
  expect(checkbox).not.toBeNull()
  await click(checkbox!)
  await click(button('Approve review (1)'))
  await click(button('Resolve'))
  await click(button('Archive'))
  await click(button('Close'))
  expect(calls).toEqual(['toggle:entry-1', 'approve', 'bulk:resolved', 'bulk:archived', 'close'])

  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount())
  document.body.innerHTML = ''
  await mount(
    <LedgerTriage
      candidates={[]}
      selections={[]}
      conflict=""
      error=""
      busy={false}
      onToggle={() => undefined}
      onApprove={() => undefined}
      onBulkState={() => undefined}
      onRetry={() => undefined}
      onClose={() => undefined}
    />
  )
  expect(document.querySelector('.ui-empty-state')?.textContent).toContain('No review candidates match these filters.')
  expect(document.querySelector('.ui-notice-line')).toBeNull()
})
