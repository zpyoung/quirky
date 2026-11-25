// @vitest-environment happy-dom
/* oxlint-disable anti-slop/no-reflect-get, anti-slop/no-reflect-apply, anti-slop/no-object-parameters -- patches and probes platform image loaders, which have no typed surface */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadsImages, NO_HTML_LABELS, withRemoteImagesBlocked } from './mermaid-safety'
import { sanitizeSvg } from './MermaidBlock'

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'

const recorded: string[] = []
const record = (kind: string, value: unknown): void => {
  recorded.push(`${kind}:${String(value)}`)
}

type Restore = () => void

function findOwner(
  start: object | null,
  key: string
): { owner: object; descriptor: PropertyDescriptor } {
  for (let owner = start; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (descriptor) {
      return { owner, descriptor }
    }
  }
  throw new Error(`no ${key}`)
}

function prototypeOf(name: string): object {
  const prototype: unknown = Reflect.get(Reflect.get(globalThis, name), 'prototype')
  if (typeof prototype !== 'object' || prototype === null) {
    throw new Error(`no ${name}.prototype`)
  }
  return prototype
}

function replaceProperty(owner: object, key: string, descriptor: PropertyDescriptor): Restore {
  const original = Object.getOwnPropertyDescriptor(owner, key)
  Object.defineProperty(owner, key, { configurable: true, ...descriptor })
  return () => {
    if (original) {
      Object.defineProperty(owner, key, original)
    }
  }
}

/** Replaces the platform loaders with recorders, so anything the guard lets through is visible. */
function stubPlatform(): Restore[] {
  const elementPrototype = prototypeOf('Element')
  const src = findOwner(prototypeOf('HTMLImageElement'), 'src')
  const srcset = findOwner(prototypeOf('HTMLImageElement'), 'srcset')
  const setAttribute = Reflect.get(elementPrototype, 'setAttribute')
  const setAttributeNS = Reflect.get(elementPrototype, 'setAttributeNS')
  class RecordingImage {
    set src(value: string) {
      record('Image', value)
    }
  }
  return [
    replaceProperty(globalThis, 'Image', { value: RecordingImage, writable: true }),
    replaceProperty(src.owner, 'src', {
      ...src.descriptor,
      set: (value: string) => record('src', value)
    }),
    replaceProperty(srcset.owner, 'srcset', {
      ...srcset.descriptor,
      set: (value: string) => record('srcset', value)
    }),
    replaceProperty(elementPrototype, 'setAttribute', {
      writable: true,
      value(this: Element, name: string, value: string) {
        if (['img', 'image'].includes(this.localName)) {
          record('setAttribute', `${name}=${value}`)
        }
        return Reflect.apply(setAttribute, this, [name, value])
      }
    }),
    replaceProperty(elementPrototype, 'setAttributeNS', {
      writable: true,
      value(this: Element, namespace: string | null, name: string, value: string) {
        if (['img', 'image'].includes(this.localName)) {
          record('setAttributeNS', `${name}=${value}`)
        }
        return Reflect.apply(setAttributeNS, this, [namespace, name, value])
      }
    })
  ]
}

function platformSnapshot(): unknown[] {
  const elementPrototype = prototypeOf('Element')
  return [
    Reflect.get(globalThis, 'Image'),
    findOwner(prototypeOf('HTMLImageElement'), 'src').descriptor.set,
    findOwner(prototypeOf('HTMLImageElement'), 'srcset').descriptor.set,
    Reflect.get(elementPrototype, 'setAttribute'),
    Reflect.get(elementPrototype, 'setAttributeNS')
  ]
}

let restores: Restore[] = []
let stubbed: unknown[] = []

beforeEach(() => {
  recorded.length = 0
  restores = stubPlatform()
  stubbed = platformSnapshot()
})

afterEach(() => {
  for (const restore of restores.toReversed()) {
    restore()
  }
})

/** Every way mermaid or a library under it could hand a URL to the browser as an image load. */
function attemptImageLoads(source: string): void {
  const url = source.match(/https?:\/\/[^\s"')]+/)?.[0]
  if (!url) {
    return
  }
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

const SOURCES = [
  'flowchart LR\n A@{ label: "}", img: "https://tracker.example/pixel" }',
  'flowchart LR\n A@{ img: "https://x.example/p" }',
  'flowchart LR\n A["<img src=\'https://tracker.example/p.gif\'>"]',
  'flowchart LR\n A --> B\n classDef x background:url(https://tracker.example/p.gif)\n class A x'
]

describe('withRemoteImagesBlocked', () => {
  it('lets no source make a remote url reach an image load, and restores the globals afterwards', async () => {
    for (const source of SOURCES) {
      await withRemoteImagesBlocked(async () => attemptImageLoads(source))
      expect(recorded).toEqual([])
    }
    expect(platformSnapshot()).toEqual(stubbed)
  })

  it('still loads inline data images while remote ones are dropped', async () => {
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

  it('refuses srcset even for a data url', async () => {
    await withRemoteImagesBlocked(async () => {
      const element = document.createElement('img')
      element.srcset = 'data:image/png;base64,AAAA 2x'
    })
    expect(recorded).toEqual([])
  })

  it('restores the globals when the task throws', async () => {
    await expect(
      withRemoteImagesBlocked(async () => {
        throw new Error('parse error')
      })
    ).rejects.toThrow('parse error')
    expect(platformSnapshot()).toEqual(stubbed)
  })

  it('keeps the guard until the last overlapping task finishes', async () => {
    let releaseSlow: () => void = () => {}
    const slow = withRemoteImagesBlocked(
      () =>
        new Promise<void>((resolve) => {
          releaseSlow = resolve
        })
    )
    await withRemoteImagesBlocked(async () => {})
    new Image().src = 'https://tracker.example/during'
    expect(recorded).toEqual([])
    releaseSlow()
    await slow
    expect(platformSnapshot()).toEqual(stubbed)
    new Image().src = 'https://tracker.example/after'
    expect(recorded).toEqual(['Image:https://tracker.example/after'])
  })
})

const HTML_LABEL_SOURCES = [
  'flowchart LR\n A["<table background=\'https://tracker.example/p.png\'>x</table>"] --> B',
  'flowchart LR\n A["<div style=\'background-image:url(https://tracker.example/q.png)\'>x</div>"] --> B',
  'flowchart LR\n A["<input type=image src=\'https://tracker.example/i.png\'>"] --> B',
  'flowchart LR\n A["<video poster=\'https://tracker.example/v.png\'></video>"] --> B',
  'mindmap\n  root((r))\n    a["<table background=\'https://tracker.example/p.png\'>x</table>"]',
  'mindmap\n  root((r))\n    a["<div style=\'background-image:url(https://tracker.example/q.png)\'>x</div>"]'
]

describe('loadsImages', () => {
  // the first source hides its url behind a `}` inside a label, so only the runtime guard stops it
  it.each([...SOURCES.slice(1), ...HTML_LABEL_SOURCES])('refuses %j', (source) => {
    expect(loadsImages(source)).toBe(true)
  })

  it('does not refuse ordinary label text', () => {
    for (const source of [
      'flowchart LR\n A[Start] --> B{Is a < b?}',
      'mindmap\n  root((r))\n    child',
      'flowchart LR\n A["a <b>bold</b>"] --> B'
    ]) {
      expect(loadsImages(source)).toBe(false)
    }
  })

  it('recognizes entity-encoded markup openers', () => {
    expect(loadsImages('flowchart LR\n A["&lt;img src=x&gt;"]')).toBe(true)
  })
})

describe('NO_HTML_LABELS', () => {
  it('turns html labels off for every diagram kind that has them', () => {
    expect(NO_HTML_LABELS.htmlLabels).toBe(false)
    expect(NO_HTML_LABELS.flowchart.htmlLabels).toBe(false)
    expect(NO_HTML_LABELS.class.htmlLabels).toBe(false)
  })
})

describe('sanitizeSvg', () => {
  it('drops scripts and event handlers', () => {
    const clean = sanitizeSvg(
      '<svg viewBox="0 0 10 10"><script>window.__pwned = true</script><text onclick="window.__pwned = true">pwned</text></svg>'
    )
    expect(clean).not.toContain('<script')
    expect(clean).not.toContain('onclick')
  })

  it('strips remote urls from label html a render still emits', () => {
    const clean = sanitizeSvg(
      `<svg viewBox="0 0 10 10"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><table background="https://tracker.example/p.png"><tr><td>x</td></tr></table><div style="background-image:url(https://tracker.example/q.png)">y</div><input type="image" src="https://tracker.example/i.png"><video poster="https://tracker.example/v.png"></video></div></foreignObject><text>drawn</text></svg>`
    )
    expect(clean).not.toContain('tracker.example')
    expect(clean).toContain('drawn')
  })

  it('keeps fragment references', () => {
    const clean = sanitizeSvg(
      '<svg viewBox="0 0 10 10"><defs><marker id="m"></marker></defs><path marker-end="url(#m)" d="M0 0L5 5"/></svg>'
    )
    expect(clean).toContain('url(#m)')
  })
})
