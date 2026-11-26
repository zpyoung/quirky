import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../runtime-client', () => ({
  RuntimeClientError: class RuntimeClientError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
}))

import { AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY } from '../../shared/agent-session-runtime-capabilities'
import { QUIRKY_AGENT_SESSION_ID_ENV } from '../../shared/agent-session-caller-env'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime-client'
import { VIEW_HANDLERS } from './view'

const SESSION = 'session-alpha'
const SPEC = { title: 'Plan', root: { type: 'markdown', props: { text: 'hello' } } }

describe('quirky view CLI handlers', () => {
  const callMock = vi.fn()
  let dir: string
  let logs: string[]
  let previousSession: string | undefined

  function ctx(flags: Record<string, string | boolean>, json = false): HandlerContext {
    return {
      flags: new Map(Object.entries(flags)),
      client: { call: callMock } as unknown as RuntimeClient,
      cwd: dir,
      json
    }
  }

  function viewCalls() {
    return callMock.mock.calls.filter(([method]) => String(method).startsWith('agentSession.view.'))
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'quirky-view-cli-'))
    logs = []
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      logs.push(String(line))
    })
    previousSession = process.env[QUIRKY_AGENT_SESSION_ID_ENV]
    process.env[QUIRKY_AGENT_SESSION_ID_ENV] = SESSION
    callMock.mockReset()
    callMock.mockImplementation(async (method: string) => {
      if (method === 'status.get') {
        return { result: { capabilities: [AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY] } }
      }
      return { id: 'r', ok: true, result: { viewId: 'view-1', version: 1 }, _meta: {} }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
    if (previousSession === undefined) {
      delete process.env[QUIRKY_AGENT_SESSION_ID_ENV]
    } else {
      process.env[QUIRKY_AGENT_SESSION_ID_ENV] = previousSession
    }
  })

  it('refuses to run outside a chat before reading anything or calling the host', async () => {
    delete process.env[QUIRKY_AGENT_SESSION_ID_ENV]

    await expect(VIEW_HANDLERS['view open'](ctx({ mermaid: '/dev/null' }))).rejects.toThrow(
      'quirky view runs inside a Quirky chat'
    )
    expect(callMock).not.toHaveBeenCalled()
  })

  it('prints validation errors and calls nothing for an invalid spec', async () => {
    await expect(
      VIEW_HANDLERS['view open'](ctx({ spec: '{"title":"x","root":{"type":"nope"}}' }))
    ).rejects.toThrow(/unknown type 'nope'/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('opens an inline spec and prints the new view', async () => {
    await VIEW_HANDLERS['view open'](ctx({ spec: JSON.stringify(SPEC), placement: 'pane' }))

    const [method, params] = viewCalls()[0] ?? []
    expect(method).toBe('agentSession.view.open')
    expect(params).toMatchObject({
      envelope: { sessionId: SESSION },
      spec: SPEC,
      placement: 'pane'
    })
    expect(logs).toEqual(['Opened view view-1 (v1)'])
  })

  it('reads --spec @file', async () => {
    writeFileSync(join(dir, 'view.json'), JSON.stringify(SPEC))

    await VIEW_HANDLERS['view open'](ctx({ spec: '@view.json' }))

    expect(viewCalls()[0]?.[1]).toMatchObject({ spec: SPEC })
  })

  it('wraps --mermaid as a diagram node titled by the file', async () => {
    writeFileSync(join(dir, 'flow.mmd'), 'flowchart LR\n  a --> b')

    await VIEW_HANDLERS['view open'](ctx({ mermaid: 'flow.mmd' }))

    expect(viewCalls()[0]?.[1]).toMatchObject({
      spec: {
        title: 'flow',
        root: { type: 'diagram', props: { source: 'flowchart LR\n  a --> b' } }
      }
    })
  })

  it('wraps --html as an html node and passes --title along', async () => {
    writeFileSync(join(dir, 'page.html'), '<b>hi</b>')

    await VIEW_HANDLERS['view open'](ctx({ html: 'page.html', title: 'Report' }))

    expect(viewCalls()[0]?.[1]).toMatchObject({
      title: 'Report',
      spec: {
        title: 'Report',
        root: { type: 'html', props: { html: '<b>hi</b>', interactive: true } }
      }
    })
  })

  it('wants exactly one of --spec, --html and --mermaid', async () => {
    await expect(VIEW_HANDLERS['view open'](ctx({}))).rejects.toThrow(/exactly one/)
    await expect(
      VIEW_HANDLERS['view open'](ctx({ spec: JSON.stringify(SPEC), html: 'a.html' }))
    ).rejects.toThrow(/exactly one/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('prints the whole response with --json', async () => {
    await VIEW_HANDLERS['view open'](ctx({ spec: JSON.stringify(SPEC) }, true))

    expect(JSON.parse(logs[0] ?? '')).toMatchObject({
      ok: true,
      result: { viewId: 'view-1', version: 1 }
    })
  })

  it('patches from a file whose ops are checked before sending', async () => {
    writeFileSync(join(dir, 'bad.json'), '{"ops":[{"op":"move","path":"/title"}]}')
    writeFileSync(join(dir, 'ok.json'), '{"ops":[{"op":"replace","path":"/title","value":"Done"}]}')
    callMock.mockImplementation(async (method: string) =>
      method === 'status.get'
        ? { result: { capabilities: [AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY] } }
        : { id: 'r', ok: true, result: { version: 4 }, _meta: {} }
    )

    await expect(
      VIEW_HANDLERS['view patch'](ctx({ id: 'view-1', patch: '@bad.json' }))
    ).rejects.toThrow(/invalid/)
    expect(viewCalls()).toEqual([])

    await VIEW_HANDLERS['view patch'](ctx({ id: 'view-1', patch: '@ok.json' }))

    expect(viewCalls()[0]?.[1]).toMatchObject({
      viewId: 'view-1',
      patch: { ops: [{ op: 'replace', path: '/title', value: 'Done' }] }
    })
    expect(logs).toEqual(['Patched view view-1 (v4)'])
  })

  it('sends get without an envelope and close with one', async () => {
    callMock.mockImplementation(async (method: string) =>
      method === 'status.get'
        ? { result: { capabilities: [AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY] } }
        : {
            id: 'r',
            ok: true,
            result: method.endsWith('get')
              ? { spec: SPEC, version: 2, closed: true }
              : { ok: true },
            _meta: {}
          }
    )

    await VIEW_HANDLERS['view get'](ctx({ id: 'view-1' }))
    await VIEW_HANDLERS['view close'](ctx({ id: 'view-1' }))

    expect(viewCalls()[0]).toEqual([
      'agentSession.view.get',
      { sessionId: SESSION, viewId: 'view-1' }
    ])
    expect(viewCalls()[1]?.[1]).toMatchObject({
      envelope: { sessionId: SESSION },
      viewId: 'view-1'
    })
    expect(logs[0]).toContain('View view-1 (v2, closed)')
    expect(logs[1]).toBe('Closed view view-1')
  })

  it('says the host is too old when it lacks the capability or the method', async () => {
    callMock.mockImplementation(async () => ({ result: { capabilities: [] } }))
    await expect(VIEW_HANDLERS['view open'](ctx({ spec: JSON.stringify(SPEC) }))).rejects.toThrow(
      "This Quirky host doesn't support quirky view yet."
    )
    expect(viewCalls()).toEqual([])

    callMock.mockImplementation(async (method: string) => {
      if (method === 'status.get') {
        return { result: { capabilities: [AGENT_SESSION_V1_CHAT_METHODS_RUNTIME_CAPABILITY] } }
      }
      throw new RuntimeClientError('method_not_found', 'Unknown method')
    })
    await expect(VIEW_HANDLERS['view open'](ctx({ spec: JSON.stringify(SPEC) }))).rejects.toThrow(
      "This Quirky host doesn't support quirky view yet."
    )
  })
})
