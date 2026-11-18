import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'
import type * as SafetyModule from '../src/markdown/blocks/mermaid-safety'
import type * as MarkdownModule from '../src/markdown'
import type { QuirkyMarkdownProps } from '../src/markdown'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

/** Every way mermaid or a library under it could hand a URL to the browser as an image load. */
function attemptImageLoads(source: string) {
  const url = source.match(/https?:\/\/[^\s"')]+/)?.[0]
  if (!url) return
  const probe = new Image()
  probe.src = url
  const element = document.createElement('img')
  element.src = url
  element.srcset = `${url} 2x`
  element.setAttribute('src', url)
  element.setAttribute('SRCSET', `${url} 2x`)
  const svgImage = document.createElementNS(SVG_NS, 'image')
  svgImage.setAttribute('href', url)
  svgImage.setAttributeNS(XLINK_NS, 'xlink:href', url)
}

const mermaidRender = mock(async (_id: string, source: string) => {
  attemptImageLoads(source)
  return { svg: '<svg viewBox="0 0 10 10"><text>drawn</text></svg>' }
})
const mermaidInitialize = mock((_config: Record<string, unknown>) => {})
mock.module('mermaid', () => ({ default: { initialize: mermaidInitialize, render: mermaidRender } }))

const recorded: string[] = []
const record = (kind: string, value: unknown) => recorded.push(`${kind}:${String(value)}`)

type Mounted = { root: Root; container: HTMLDivElement }
let act: typeof import('react').act
let createElement: typeof import('react').createElement
let createRoot: typeof import('react-dom/client').createRoot
let QuirkyMarkdown: typeof MarkdownModule.QuirkyMarkdown
let withRemoteImagesBlocked: typeof SafetyModule.withRemoteImagesBlocked
const mounted: Mounted[] = []

type Globals = { Image: unknown; srcSetter: unknown; srcsetSetter: unknown; setAttribute: unknown; setAttributeNS: unknown }
let stubbed: Globals
let originals: Globals & { image: PropertyDescriptor | undefined; src: PropertyDescriptor | undefined; srcset: PropertyDescriptor | undefined }

const imageProto = () => (globalThis as unknown as { HTMLImageElement: { prototype: object } }).HTMLImageElement.prototype
const elementProto = () => (globalThis as unknown as { Element: { prototype: Record<string, unknown> } }).Element.prototype
const imageProperty = (key: string) => {
  for (let owner: object | null = imageProto(); owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (descriptor) return { owner, descriptor }
  }
  throw new Error(`no ${key}`)
}

/** Replaces the platform loaders with recorders, so anything the guard lets through is visible. */
function stubPlatform() {
  const src = imageProperty('src')
  const srcset = imageProperty('srcset')
  const setAttribute = elementProto().setAttribute as (this: Element, name: string, value: string) => void
  const setAttributeNS = elementProto().setAttributeNS as (this: Element, ns: string | null, name: string, value: string) => void
  class RecordingImage {
    set src(value: string) {
      record('Image', value)
    }
  }
  originals = {
    Image: (globalThis as { Image: unknown }).Image,
    image: Object.getOwnPropertyDescriptor(globalThis, 'Image'),
    src: src.descriptor,
    srcset: srcset.descriptor,
    srcSetter: src.descriptor.set,
    srcsetSetter: srcset.descriptor.set,
    setAttribute,
    setAttributeNS
  }
  ;(globalThis as { Image: unknown }).Image = RecordingImage
  Object.defineProperty(src.owner, 'src', { ...src.descriptor, set: (value: string) => record('src', value) })
  Object.defineProperty(srcset.owner, 'srcset', { ...srcset.descriptor, set: (value: string) => record('srcset', value) })
  elementProto().setAttribute = function (this: Element, name: string, value: string) {
    if (['img', 'image'].includes(this.localName)) record('setAttribute', `${name}=${value}`)
    return setAttribute.call(this, name, value)
  }
  elementProto().setAttributeNS = function (this: Element, ns: string | null, name: string, value: string) {
    if (['img', 'image'].includes(this.localName)) record('setAttributeNS', `${name}=${value}`)
    return setAttributeNS.call(this, ns, name, value)
  }
  stubbed = {
    Image: RecordingImage,
    srcSetter: Object.getOwnPropertyDescriptor(src.owner, 'src')?.set,
    srcsetSetter: Object.getOwnPropertyDescriptor(srcset.owner, 'srcset')?.set,
    setAttribute: elementProto().setAttribute,
    setAttributeNS: elementProto().setAttributeNS
  }
}

function unstubPlatform() {
  const src = imageProperty('src')
  const srcset = imageProperty('srcset')
  Object.defineProperty(globalThis, 'Image', originals.image as PropertyDescriptor)
  Object.defineProperty(src.owner, 'src', originals.src as PropertyDescriptor)
  Object.defineProperty(srcset.owner, 'srcset', originals.srcset as PropertyDescriptor)
  elementProto().setAttribute = originals.setAttribute
  elementProto().setAttributeNS = originals.setAttributeNS
}

function currentGlobals(): Globals {
  return {
    Image: (globalThis as { Image: unknown }).Image,
    srcSetter: imageProperty('src').descriptor.set,
    srcsetSetter: imageProperty('srcset').descriptor.set,
    setAttribute: elementProto().setAttribute,
    setAttributeNS: elementProto().setAttributeNS
  }
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'about:blank' })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(document, 'compatMode', { value: 'CSS1Compat', configurable: true })
  const [react, client, markdown, safety] = await Promise.all([
    import('react'),
    import('react-dom/client'),
    import('../src/markdown'),
    import('../src/markdown/blocks/mermaid-safety')
  ])
  act = react.act
  createElement = react.createElement
  createRoot = client.createRoot
  QuirkyMarkdown = markdown.QuirkyMarkdown
  withRemoteImagesBlocked = safety.withRemoteImagesBlocked
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  mermaidRender.mockClear()
  mermaidInitialize.mockClear()
  recorded.length = 0
  stubPlatform()
})

afterEach(async () => {
  for (const { root } of [...mounted].reverse()) await act(async () => root.unmount())
  mounted.length = 0
  document.body.innerHTML = ''
  unstubPlatform()
})

async function mount(text: string) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => {
    root.render(createElement(QuirkyMarkdown, { profile: 'untrusted', onOpenLink: () => {}, text } as QuirkyMarkdownProps))
  })
  return container
}

async function settle(until: () => boolean, label: string) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (until()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25))
    })
  }
  throw new Error(`timed out waiting for ${label}`)
}

const SOURCES = [
  'flowchart LR\n A@{ label: "}", img: "https://tracker.example/pixel" }',
  'flowchart LR\n A@{ img: "https://x.example/p" }',
  'flowchart LR\n A["<img src=\'https://tracker.example/p.gif\'>"]',
  'flowchart LR\n A --> B\n classDef x background:url(https://tracker.example/p.gif)\n class A x'
]

describe('mermaid render with remote images blocked', () => {
  test('no source makes a remote url reach an image load, and the globals come back afterwards', async () => {
    for (const source of SOURCES) {
      await withRemoteImagesBlocked(() => mermaidRender('id', source))
      expect(recorded).toEqual([])
    }
    expect(mermaidRender).toHaveBeenCalledTimes(SOURCES.length)
    expect(currentGlobals()).toEqual(stubbed)
  })

  test('inline data images still load while remote ones are dropped', async () => {
    const data = 'data:image/png;base64,AAAA'
    await withRemoteImagesBlocked(async () => {
      const probe = new Image()
      probe.src = data
      probe.src = 'https://tracker.example/p'
      probe.src = '  JaVaScRiPt:alert(1)'
      document.createElementNS(SVG_NS, 'image').setAttribute('href', data)
    })
    expect(recorded).toEqual([`Image:${data}`, `setAttribute:href=${data}`])
  })

  test('the globals are restored when the render throws', async () => {
    let failure: unknown
    try {
      await withRemoteImagesBlocked(async () => {
        throw new Error('parse error')
      })
    } catch (error) {
      failure = error
    }
    expect((failure as Error).message).toBe('parse error')
    expect(currentGlobals()).toEqual(stubbed)
  })

  test('overlapping renders keep the guard until the last one finishes', async () => {
    let releaseSlow: () => void = () => {}
    const slow = withRemoteImagesBlocked(() => new Promise<void>((resolve) => { releaseSlow = resolve }))
    await withRemoteImagesBlocked(async () => {})
    new Image().src = 'https://tracker.example/during'
    expect(recorded).toEqual([])
    releaseSlow()
    await slow
    expect(currentGlobals()).toEqual(stubbed)
    new Image().src = 'https://tracker.example/after'
    expect(recorded).toEqual(['Image:https://tracker.example/after'])
  })

  test('a fence the pre-check misses is drawn without any remote load', async () => {
    const container = await mount(`\`\`\`mermaid\n${SOURCES[0]}\n\`\`\``)
    await settle(() => !!container.querySelector('[data-qmd-data="mermaid"] .qmd-figure-body')?.textContent, 'diagram')
    expect(mermaidRender).toHaveBeenCalledTimes(1)
    expect(recorded).toEqual([])
    expect(currentGlobals()).toEqual(stubbed)
  })

  test('an ordinary flowchart still renders', async () => {
    const container = await mount('```mermaid\nflowchart LR\n A-->B\n```')
    await settle(() => !!container.querySelector('[data-qmd-data="mermaid"] .qmd-figure-body')?.textContent, 'diagram')
    expect(container.querySelector('[data-qmd-data="mermaid"] .qmd-figure-body')?.textContent).toBe('drawn')
    expect(recorded).toEqual([])
  })
})
