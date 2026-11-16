import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const s = await import('./panel-support')
const { PANEL, buttonText, click, compareOf, entry, fakeContext, layoutFor, mountPanel, q, qa, rowOf, settle, statusOf } = s
const { GIT_UI_CONTROL_COMMAND } = await import('../../src/ui-control')

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => {
  document.body.innerHTML = ''
})

const mountedPanels = new Set<() => void>()
afterEach(() => {
  for (const unmount of [...mountedPanels]) unmount()
})

type Fake = ReturnType<typeof fakeContext>

async function openPanel(configure: (fake: Fake) => void) {
  const fake = fakeContext(layoutFor('feat'))
  configure(fake)
  const mounted = mountPanel(fake)
  let live = true
  const unmount = () => {
    if (!live) return
    live = false
    mountedPanels.delete(unmount)
    mounted.unmount()
  }
  mountedPanels.add(unmount)
  try {
    await settle()
    return { fake, ...mounted, unmount }
  } catch (error) {
    unmount()
    throw error
  }
}

const scenarios = [
  {
    name: 'invalid base with a message',
    status: 'invalid-base' as const,
    message: 'Base ref origin/gone could not be resolved in this repository.',
    expected: 'Base ref origin/gone could not be resolved in this repository.'
  },
  {
    name: 'no merge base with a message',
    status: 'no-merge-base' as const,
    message: 'No merge base fixture.',
    expected: 'No merge base fixture.'
  },
  {
    name: 'invalid base without a message',
    status: 'invalid-base' as const,
    message: null,
    expected: 'Branch compare is unavailable.'
  }
]

const layouts = [
  { name: 'no uncommitted files', entries: [] },
  { name: 'one uncommitted file', entries: [entry('math.ts')] }
]

function expectActions(element: ParentNode) {
  expect(qa(element, 'button').filter((button) => button.textContent?.trim() === 'Change base ref')).toHaveLength(1)
  expect(qa(element, 'button').filter((button) => button.textContent?.trim() === 'Retry')).toHaveLength(1)
}

function expectControlRoute(fake: Fake, routeCount: number, connId: number, action: string) {
  const routes = fake.called('ui.window.command.run')
  expect(routes).toHaveLength(routeCount + 1)
  expect(routes.at(-1)?.params).toEqual({
    connId,
    id: GIT_UI_CONTROL_COMMAND,
    args: {
      surface: PANEL,
      target: 'worktree:feat',
      generation: expect.any(String),
      action
    }
  })
}

const dialog = () => q(document.body, '[role="dialog"]')
const dialogTitle = () => {
  const titleId = dialog()?.getAttribute('aria-labelledby')
  return titleId ? document.getElementById(titleId)?.textContent ?? null : null
}

describe('mounted Source Control comparison diagnostic states', () => {
  for (const scenario of scenarios) {
    for (const layout of layouts) {
      test(`${scenario.name} renders as one shared error with ${layout.name}`, async () => {
        const { element } = await openPanel((fake) => {
          fake.status = statusOf(layout.entries)
          fake.compare = compareOf({ status: scenario.status, message: scenario.message })
        })

        const messages = qa(element, '.ui-inline-error__message')
        expect(messages.map((message) => message.textContent)).toEqual([scenario.expected])
        expect(messages[0]?.closest('.ui-inline-error')?.getAttribute('role')).toBe('alert')
        expect(messages[0]?.closest('[role="status"]')).not.toBeNull()
        expectActions(element)

        const card = q(element, '.ui-inline-agent-card')
        if (layout.entries.length === 0) {
          expect(card).not.toBeNull()
          expect(q(card!, 'h3')?.textContent).toBe('Branch compare unavailable')
          expect(card?.classList.contains('ui-inline-agent-card--failing')).toBe(true)
          expect(q(card!, '[aria-label="Status: failing"]')).not.toBeNull()
          expect(q(element, '[role="status"] .ui-inline-agent-card')).toBe(card)
        } else {
          expect(card).toBeNull()
          expect(rowOf(element, 'math.ts')).not.toBeNull()
        }
      })
    }
  }

  test('Retry routes one exact-window refresh-compare and a ready response removes the error', async () => {
    const connId = 731
    let retryRequested = false
    const unavailable = compareOf({
      status: 'invalid-base',
      message: 'Base ref origin/gone could not be resolved in this repository.'
    })
    const ready = compareOf()
    const { fake, element } = await openPanel((context) => {
      context.status = statusOf([entry('math.ts')])
      context.on('ui.window.self', () => ({ connId }))
      context.on('quirky.git/compare', () => retryRequested ? ready : unavailable)
    })

    expect(qa(element, '.ui-inline-error__message').map((message) => message.textContent)).toEqual(['Base ref origin/gone could not be resolved in this repository.'])
    expectActions(element)
    const routesBefore = fake.called('ui.window.command.run').length
    const comparesBefore = fake.called('quirky.git/compare').length
    retryRequested = true
    await click(buttonText(element, 'Retry'))
    await settle()

    expectControlRoute(fake, routesBefore, connId, 'refresh-compare')
    expect(fake.called('quirky.git/compare')).toHaveLength(comparesBefore + 1)
    expect(qa(element, '.ui-inline-error__message')).toHaveLength(0)
  })

  for (const layout of layouts) {
    test(`Change base ref opens its dialog without changing the base (${layout.name})`, async () => {
      const connId = 842
      const unavailable = compareOf({
        status: 'invalid-base',
        message: 'Base ref origin/gone could not be resolved in this repository.'
      })
      const { fake, element } = await openPanel((context) => {
        context.status = statusOf(layout.entries)
        context.compare = unavailable
        context.on('ui.window.self', () => ({ connId }))
        context.on('quirky.git/branches', () => ({ refs: [{ name: 'origin/main', kind: 'remote' }], current: 'origin/main' }))
      })
      const originalBase = fake.compare.base
      const routesBefore = fake.called('ui.window.command.run').length
      const setBaseBefore = fake.called('quirky.git/setBase').length

      await click(buttonText(element, 'Change base ref'))
      await settle()

      expectControlRoute(fake, routesBefore, connId, 'change-base')
      expect(dialogTitle()).toBe('Change Base Ref')
      expect(fake.called('quirky.git/setBase')).toHaveLength(setBaseBefore)
      expect(fake.compare.base).toBe(originalBase)
    })
  }
})
