import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import * as taskLinks from '../../src/window/pane/task-links'

let Terminal: typeof import('@xterm/xterm').Terminal

beforeAll(async () => {
  GlobalRegistrator.register()
  ;({ Terminal } = await import('@xterm/xterm'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function terminalWith(text: string, cols = 40) {
  const term = new Terminal({ cols, rows: 6, allowProposedApi: true })
  await new Promise<void>((resolve) => term.write(text, resolve))
  return term
}

function linksAt(p: ReturnType<typeof provider.createFileLinkProvider>, y: number): Promise<ILink[] | undefined> {
  return new Promise((resolve) => p.provideLinks(y, resolve))
}

describe('readLogicalLine', () => {
  test('joins wrapped rows and maps characters to cells', async () => {
    const term = await terminalWith('a'.repeat(45), 40)
    const logical = provider.readLogicalLine(term.buffer.active, 2)
    expect(logical.text).toBe('a'.repeat(45))
    expect(logical.cells[40]).toEqual({ row: 1, col: 0, width: 1 })
  })

  test('a wide character takes one string position and two columns', async () => {
    const term = await terminalWith('日本 x')
    const { text, cells } = provider.readLogicalLine(term.buffer.active, 1)
    expect(text).toBe('日本 x')
    expect(cells[1]).toEqual({ row: 0, col: 2, width: 2 })
    expect(cells[3]).toEqual({ row: 0, col: 5, width: 1 })
  })
})

describe('createFileLinkProvider', () => {
  const handlers = (cwd = '/tmp/w/api') => {
    const hovered: (string | null)[] = []
    const activated: unknown[] = []
    return {
      hovered,
      activated,
      value: {
        cwd: () => cwd,
        hover: (target: string | null) => void hovered.push(target),
        activate: (_event: MouseEvent, link: unknown) => void activated.push(link)
      }
    }
  }

  test('SC-40: links only the paths that exist, with xterm ranges and a hover target', async () => {
    const term = await terminalWith('see src/app.ts:12:4 and src/gone.ts\r\n')
    const asked: string[][] = []
    const checker = new provider.PathChecker(async (paths) => {
      asked.push(paths)
      return paths.map((path) => path.endsWith('app.ts'))
    })
    const h = handlers()
    const found = await linksAt(provider.createFileLinkProvider(term, checker, h.value), 1)
    expect(asked).toEqual([['/tmp/w/api/src/app.ts', '/tmp/w/api/src/gone.ts']])
    expect(found).toHaveLength(1)
    expect(found![0]!.range).toEqual({ start: { x: 5, y: 1 }, end: { x: 19, y: 1 } })
    expect(found![0]!.text).toBe('src/app.ts:12:4')
    found![0]!.hover!(new MouseEvent('mousemove'), found![0]!.text)
    found![0]!.leave!(new MouseEvent('mousemove'), found![0]!.text)
    expect(h.hovered).toEqual(['/tmp/w/api/src/app.ts:12:4', null])
    found![0]!.activate(new MouseEvent('click'), found![0]!.text)
    expect(h.activated).toEqual([{ path: '/tmp/w/api/src/app.ts', line: 12, column: 4 }])
  })

  test('SC-40: a line whose existence check throws yields no links', async () => {
    const term = await terminalWith('src/app.ts\r\n')
    const checker = new provider.PathChecker(async () => {
      throw new Error('daemon gone')
    })
    expect(await linksAt(provider.createFileLinkProvider(term, checker, handlers().value), 1)).toBeUndefined()
  })

  test('SC-40: a throwing buffer yields no links', async () => {
    const broken = {
      buffer: {
        active: {
          getLine: () => {
            throw new Error('boom')
          }
        }
      }
    }
    const checker = new provider.PathChecker(async () => [true])
    expect(await linksAt(provider.createFileLinkProvider(broken, checker, handlers().value), 1)).toBeUndefined()
  })

  test('answers are remembered, so hovering the line again asks nothing', async () => {
    const term = await terminalWith('src/app.ts\r\n')
    let calls = 0
    const checker = new provider.PathChecker(async (paths) => {
      calls += 1
      return paths.map(() => true)
    })
    const p = provider.createFileLinkProvider(term, checker, handlers().value)
    await linksAt(p, 1)
    await linksAt(p, 1)
    expect(calls).toBe(1)
  })

  test('relative paths need a pane directory', async () => {
    const term = await terminalWith('src/app.ts /abs/x.ts\r\n')
    const asked: string[][] = []
    const checker = new provider.PathChecker(async (paths) => {
      asked.push(paths)
      return paths.map(() => true)
    })
    const found = await linksAt(provider.createFileLinkProvider(term, checker, handlers('').value), 1)
    expect(asked).toEqual([['/abs/x.ts']])
    expect(found).toHaveLength(1)
  })

  test('a path that wraps across rows is one link spanning both', async () => {
    const term = await terminalWith(`${'x'.repeat(30)} /tmp/w/api/src/long/name.ts\r\n`, 40)
    const checker = new provider.PathChecker(async (paths) => paths.map(() => true))
    const found = await linksAt(provider.createFileLinkProvider(term, checker, handlers().value), 2)
    expect(found![0]!.range.start.y).toBe(1)
    expect(found![0]!.range.end.y).toBe(2)
  })
})
describe('createTaskLinkProvider', () => {
  const handlers = () => {
    const hovered: (string | null)[] = []
    const activated: { event: MouseEvent; taskId: string }[] = []
    return {
      hovered,
      activated,
      value: {
        hover: (target: string | null) => void hovered.push(target),
        activate: (event: MouseEvent, taskId: string) => void activated.push({ event, taskId })
      }
    }
  }

  test('links punctuation-delimited task IDs up to 128 characters, not adjacent or overlong tokens', async () => {
    const maximum = `task_${'a'.repeat(123)}`
    const overlong = `task_${'b'.repeat(124)}`
    const term = await terminalWith(`(task_ok), x-task_adjacent! task_ ${overlong}! ${maximum}.`)
    const h = handlers()
    const found = await linksAt(taskLinks.createTaskLinkProvider(term, h.value), 1)
    expect(found?.map((link) => link.text)).toEqual(['task_ok', maximum])
    expect(found?.[0]?.range).toEqual({ start: { x: 2, y: 1 }, end: { x: 8, y: 1 } })
    found?.[0]?.hover?.(new MouseEvent('mousemove'), found[0].text)
    found?.[0]?.leave?.(new MouseEvent('mousemove'), found[0].text)
    found?.[0]?.activate(new MouseEvent('click'), found[0].text)
    expect(h.hovered[0]).toContain('task_ok')
    expect(h.hovered[1]).toBeNull()
    expect(h.activated.map(({ taskId }) => taskId)).toEqual(['task_ok'])
  })

  test('maps the range after wide characters to xterm cells', async () => {
    const term = await terminalWith('日本(task_wide)!')
    const found = await linksAt(taskLinks.createTaskLinkProvider(term, handlers().value), 1)
    expect(found?.[0]?.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 14, y: 1 } })
  })

  test('maps a token across wrapped rows', async () => {
    const term = await terminalWith(`${'x'.repeat(35)}task_wrap!`, 40)
    const found = await linksAt(taskLinks.createTaskLinkProvider(term, handlers().value), 2)
    expect(found?.[0]?.text).toBe('task_wrap')
    expect(found?.[0]?.range).toEqual({ start: { x: 36, y: 1 }, end: { x: 4, y: 2 } })
  })
})


describe('PathChecker', () => {
  test('asks in batches of 50 and keeps order', async () => {
    const sizes: number[] = []
    const checker = new provider.PathChecker(async (paths) => {
      sizes.push(paths.length)
      return paths.map((path) => Number(path.slice(1)) % 2 === 0)
    })
    const paths = Array.from({ length: 120 }, (_, index) => `/${index}`)
    const answers = await checker.check(paths)
    expect(sizes).toEqual([50, 50, 20])
    expect(answers[4]).toBe(true)
    expect(answers[5]).toBe(false)
  })

  test('a failed batch is asked again next time', async () => {
    let fail = true
    const checker = new provider.PathChecker(async (paths) => {
      if (fail) throw new Error('down')
      return paths.map(() => true)
    })
    expect(await checker.check(['/a'])).toEqual([false])
    fail = false
    expect(await checker.check(['/a'])).toEqual([true])
  })
})
