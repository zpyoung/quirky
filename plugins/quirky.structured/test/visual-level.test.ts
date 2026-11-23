import { afterEach, describe, expect, test } from 'bun:test'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { parseVisualLevel, visualGuidance, visualInstructions, visualLevelMarker } from '../visual-guidance'
import { bootChat, teardownChat, type ChatBoot } from './chat-harness'

let chat: ChatBoot | undefined
afterEach(async () => {
  await teardownChat(chat)
  chat = undefined
})

const MARKER = (level: string) => `[quirky visual level: ${level}]\n`
const userTexts = async (boot: ChatBoot, session: string) =>
  (await boot.messages(session)).filter((message) => message.role === 'user').map((message) => message.text)
const levelItems = async (boot: ChatBoot, session: string) =>
  (await boot.messages(session)).flatMap((message) => (message.item?.kind === 'visual-level' ? [message.item] : []))

describe('visual guidance', () => {
  test('stays short and covers the levels, the marker and the rules the agent needs', () => {
    const text = visualGuidance()
    expect(text.split('\n').length).toBeLessThanOrEqual(60)
    for (const needle of [
      'off',
      'balanced',
      'visual-first',
      '[quirky visual level: <level>]',
      'Chit-chat',
      'near-duplicate',
      'quirky view patch',
      'refused',
      'lowercase letters, digits and dashes',
      '@view:<viewId>/v<version>/<element>',
      'quirky view get --id <viewId> --at-version <n>',
      'quirky view --help',
      '`label`',
      'tabs',
      'quirky view done --id <id>',
      'Updating it later makes it live again'
    ]) {
      expect(text).toContain(needle)
    }
  })

  test('parses only the three levels and writes the marker as its own first line', () => {
    expect(parseVisualLevel('balanced')).toBe('balanced')
    expect(parseVisualLevel('loud')).toBeNull()
    expect(visualLevelMarker('off')).toBe(MARKER('off'))
  })
})

describe('the visual level of a chat', () => {
  test('a new session gets the guidance with its level and no marker on the first message', async () => {
    chat = await bootChat()
    const session = await chat.create('draw it')
    await waitFor(() => chat!.runner.started.length === 1)
    const appended = chat.runner.started[0]!.options.appendInstructions
    expect(appended).toBe(visualInstructions('visual-first'))
    expect(appended).toBe(`${visualGuidance()}\nThis chat's visual level is visual-first.`)
    expect(await userTexts(chat, session.id)).toEqual(['draw it'])
    expect(await levelItems(chat, session.id)).toEqual([])
  })

  test('later messages at the same level carry no marker', async () => {
    chat = await bootChat()
    const session = await chat.create('one')
    await chat.call('quirky.structured/send', { session: session.id, text: 'two' })
    await chat.call('quirky.structured/send', { session: session.id, text: 'three' })
    expect(chat.runner.sent.map((sent) => sent.text)).toEqual(['two', 'three'])
  })

  test('a session started without a prompt sends its first message with no marker', async () => {
    chat = await bootChat()
    const session = (await chat.call('quirky.structured/create', { worktree: 'main', agent: 'claude', deferStart: true })) as { id: string }
    await chat.call('quirky.structured/send', { session: session.id, text: 'first' })
    await chat.call('quirky.structured/send', { session: session.id, text: 'second' })
    expect(chat.runner.sent.map((sent) => sent.text)).toEqual(['first', 'second'])
  })

  test('configure accepts a level, journals it, reports it and announces it once with the next message', async () => {
    chat = await bootChat()
    const session = await chat.create('one')
    const result = await chat.call('quirky.structured/configure', { session: session.id, visualLevel: 'balanced' })
    expect(result).toEqual({ ok: true, settings: { visualLevel: 'balanced' } })
    expect(await levelItems(chat, session.id)).toEqual([{ kind: 'visual-level', level: 'balanced' }])
    expect(await chat.call('quirky.structured/settings', { session: session.id })).toEqual({ settings: { visualLevel: 'balanced' } })

    await chat.call('quirky.structured/send', { session: session.id, text: 'two' })
    await chat.call('quirky.structured/send', { session: session.id, text: 'three' })
    await chat.call('quirky.structured/configure', { session: session.id, visualLevel: 'off' })
    await chat.call('quirky.structured/send', { session: session.id, text: 'four' })
    expect(chat.runner.sent.map((sent) => sent.text)).toEqual([`${MARKER('balanced')}two`, 'three', `${MARKER('off')}four`])
    expect(await levelItems(chat, session.id)).toEqual([
      { kind: 'visual-level', level: 'balanced' },
      { kind: 'visual-level', level: 'off' }
    ])
  })

  test('configure keeps the other picks going to the runner and leaves the level out of them', async () => {
    chat = await bootChat()
    const session = await chat.create('one')
    await chat.call('quirky.structured/configure', { session: session.id, effort: 'high', visualLevel: 'off' })
    expect(chat.runner.configured).toEqual([{ sessionId: session.id, settings: { effort: 'high' } }])
  })

  test('setting the level it already has journals nothing', async () => {
    chat = await bootChat()
    const session = await chat.create('one')
    await chat.call('quirky.structured/configure', { session: session.id, visualLevel: 'visual-first' })
    expect(await levelItems(chat, session.id)).toEqual([])
  })

  test('an unknown level is refused', async () => {
    chat = await bootChat()
    const session = await chat.create('one')
    expect(await chat.failure(chat.call('quirky.structured/configure', { session: session.id, visualLevel: 'loud' }))).toMatchObject({
      message: expect.stringContaining('visualLevel')
    })
  })

  test('a send that fails leaves a changed level unannounced, so the retry carries the marker', async () => {
    chat = await bootChat()
    const session = await chat.create('one')
    await chat.call('quirky.structured/configure', { session: session.id, visualLevel: 'off' })
    chat.runner.sendError = new Error('down')
    await chat.failure(chat.call('quirky.structured/send', { session: session.id, text: 'two' }))
    chat.runner.sendError = null
    await chat.call('quirky.structured/send', { session: session.id, text: 'two' })
    expect(chat.runner.sent.map((sent) => sent.text)).toEqual([`${MARKER('off')}two`])
  })

  test('a queued message is marked when it goes out, with the level then in force', async () => {
    chat = await bootChat()
    const session = await chat.create('one')
    await chat.call('quirky.structured/send', { session: session.id, text: 'queued', when: 'idle' })
    await chat.call('quirky.structured/configure', { session: session.id, visualLevel: 'off' })
    chat.runner.finish(session.id)
    await waitFor(() => chat!.runner.sent.length === 1)
    expect(chat.runner.sent[0]!.text).toBe(`${MARKER('off')}queued`)
  })

  test('a resumed session starts at the level its chat had, carried by the guidance, with no marker', async () => {
    const home = '/tmp/qs-resume-' + Math.random().toString(36).slice(2)
    chat = await bootChat({ home })
    chat.world.worktree.path = home
    const original = await chat.create('one')
    chat.world.sessions.get(original.id)!.providerSession = { id: 'provider-1', transcriptPath: null }
    await chat.call('quirky.structured/configure', { session: original.id, visualLevel: 'balanced' })
    await chat.call('quirky.structured/stop', { session: original.id })

    const resumed = (await chat.call('quirky.structured/resume', { session: original.id })) as { id: string }
    await waitFor(() => chat!.runner.started.length === 2)
    expect(chat.runner.started[1]!.options.appendInstructions).toBe(visualInstructions('balanced'))
    expect(await levelItems(chat, resumed.id)).toEqual([{ kind: 'visual-level', level: 'balanced' }])
    await chat.call('quirky.structured/send', { session: resumed.id, text: 'back' })
    await chat.call('quirky.structured/send', { session: resumed.id, text: 'again' })
    expect(chat.runner.sent.map((sent) => sent.text)).toEqual(['back', 'again'])
  })

  test('a session that runs no tools gets neither the guidance nor the marker', async () => {
    chat = await bootChat()
    const session = (await chat.call('quirky.structured/create', {
      worktree: 'main',
      agent: 'claude',
      prompt: 'summarize',
      options: { toolPolicy: 'deny-all' }
    })) as { id: string }
    await waitFor(() => chat!.runner.started.length === 1)
    expect(chat.runner.started[0]!.options).not.toHaveProperty('appendInstructions')
    expect(await userTexts(chat, session.id)).toEqual(['summarize'])
  })
})
