const ASSET_KEY = /@\{[^}]*?["']?\b(?:img|image|icon)["']?\s*:/i
const MARKUP_OPEN = '(?:<|&lt;|&#0*60;|&#x0*3c;|#60;|#lt;)'
const IMAGE_MARKUP = new RegExp(
  `${MARKUP_OPEN}\\s*/?\\s*(?:img|image|picture|source|video|audio|svg|object|embed|iframe|link|style|use|foreignobject)\\b`,
  'i'
)
const URL_ATTRIBUTE = new RegExp(
  `${MARKUP_OPEN}\\s*[a-z][^>]*?[\\s"'/;](?:background|poster|formaction|href|xlink:href|srcset|action|ping|data)\\s*=`,
  'i'
)
const STYLE_URL = new RegExp(
  `${MARKUP_OPEN}\\s*[a-z][^>]*?\\bstyle\\s*=[^>]*(?:url|image-set)\\s*\\(`,
  'i'
)
const CSS_FETCH = /url\s*\(|image-set\s*\(|@import|themeCSS|\bsrc\s*=/i

/** Labels render as SVG text, so mermaid never parses label HTML and attributes like `poster` or `background` have nothing to act on. */
export const NO_HTML_LABELS = {
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  class: { htmlLabels: false }
} as const

/**
 * True when mermaid source can make mermaid fetch something: `img:`/`icon:` node shapes, image markup or
 * raw HTML tags with URL-bearing attributes in labels, or CSS that loads a URL. Mermaid assigns such URLs to an `Image` before the svg can be
 * sanitised, so the source has to be refused before it is handed over.
 */
export function loadsImages(source: string): boolean {
  return (
    ASSET_KEY.test(source) ||
    URL_ATTRIBUTE.test(source) ||
    STYLE_URL.test(source) ||
    IMAGE_MARKUP.test(source) ||
    CSS_FETCH.test(source)
  )
}

const GUARDED_ELEMENTS = new Set(['img', 'image'])
const GUARDED_ATTRIBUTES = new Set(['src', 'srcset', 'href', 'xlink:href'])

/** Only inline `data:` images (and clearing the value) never touch the network. */
function isInlineImage(value: unknown): boolean {
  const text = Array.from(String(value))
    .filter((char) => char.charCodeAt(0) > 32)
    .join('')
  return text === '' || /^data:/i.test(text)
}

/** `srcset` is refused outright: it can list several URLs and mermaid has no use for it. */
const allowsImageValue = (attribute: string, value: unknown) =>
  attribute === 'srcset' ? String(value).trim() === '' : isInlineImage(value)

function localNameOf(element: unknown): string {
  return typeof element === 'object' &&
    element !== null &&
    'localName' in element &&
    typeof element.localName === 'string'
    ? element.localName
    : ''
}

function prototypeOf(constructor: unknown): object | undefined {
  const prototype: unknown =
    typeof constructor === 'function' ? Reflect.get(constructor, 'prototype') : undefined
  return typeof prototype === 'object' && prototype !== null ? prototype : undefined
}

function guardsAttribute(element: unknown, name: unknown): string | null {
  const tag = localNameOf(element).toLowerCase()
  if (!GUARDED_ELEMENTS.has(tag)) {
    return null
  }
  const attribute = String(name).toLowerCase()
  const bare = attribute.includes(':') ? attribute.slice(attribute.lastIndexOf(':') + 1) : attribute
  return GUARDED_ATTRIBUTES.has(attribute) || GUARDED_ATTRIBUTES.has(bare) ? bare : null
}

type Restore = () => void

function findDescriptor(
  target: object | null | undefined,
  key: string
): { owner: object; descriptor: PropertyDescriptor } | null {
  for (let owner = target ?? null; owner; owner = Object.getPrototypeOf(owner)) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key)
    if (descriptor) {
      return { owner, descriptor }
    }
  }
  return null
}

/** Replaces a property on the object that owns it and returns what puts the original back. */
function patchProperty(
  target: object | null | undefined,
  key: string,
  wrap: (original: PropertyDescriptor) => PropertyDescriptor
): Restore | null {
  const found = findDescriptor(target, key)
  if (!found) {
    return null
  }
  const { owner, descriptor } = found
  Object.defineProperty(owner, key, { ...wrap(descriptor), configurable: true })
  return () => {
    Object.defineProperty(owner, key, descriptor)
  }
}

/** Wraps an element so assignments to `src`/`srcset` are dropped unless they are inline images. */
function guardInstance<T extends object>(instance: T): T {
  return new Proxy(instance, {
    get(target, key) {
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
    set(target, key, value) {
      if ((key === 'src' || key === 'srcset') && !allowsImageValue(key, value)) {
        return true
      }
      return Reflect.set(target, key, value, target)
    }
  })
}

function installImageGuards(): Restore[] {
  const restores: Restore[] = []
  const add = (restore: Restore | null) => {
    if (restore) {
      restores.push(restore)
    }
  }
  const imagePrototype = prototypeOf(Reflect.get(globalThis, 'HTMLImageElement'))
  const elementPrototype = prototypeOf(Reflect.get(globalThis, 'Element'))

  add(
    patchProperty(globalThis, 'Image', (original) => {
      const Original = original.value
      if (typeof Original !== 'function') {
        return original
      }
      const Guarded = function (...args: unknown[]) {
        const instance: unknown = Reflect.construct(Original, args)
        return typeof instance === 'object' && instance !== null
          ? guardInstance(instance)
          : instance
      }
      Guarded.prototype = Original.prototype
      return { ...original, value: Guarded }
    })
  )

  for (const key of ['src', 'srcset']) {
    add(
      patchProperty(imagePrototype, key, (original) => {
        if (!original.set) {
          return original
        }
        const set = original.set
        return {
          ...original,
          set(this: unknown, value: unknown) {
            if (allowsImageValue(key, value)) {
              set.call(this, value)
            }
          }
        }
      })
    )
  }

  add(
    patchProperty(elementPrototype, 'setAttribute', (original) => {
      const setAttribute = original.value
      if (typeof setAttribute !== 'function') {
        return original
      }
      return {
        ...original,
        value(this: unknown, name: string, value: string) {
          const attribute = guardsAttribute(this, name)
          if (attribute && !allowsImageValue(attribute, value)) {
            return
          }
          return Reflect.apply(setAttribute, this, [name, value])
        }
      }
    })
  )

  add(
    patchProperty(elementPrototype, 'setAttributeNS', (original) => {
      const setAttributeNS = original.value
      if (typeof setAttributeNS !== 'function') {
        return original
      }
      return {
        ...original,
        value(this: unknown, namespace: string | null, name: string, value: string) {
          const attribute = guardsAttribute(this, name)
          if (attribute && !allowsImageValue(attribute, value)) {
            return
          }
          return Reflect.apply(setAttributeNS, this, [namespace, name, value])
        }
      }
    })
  )

  return restores
}

let activeGuards = 0
let restoreGuards: Restore[] = []

/**
 * Runs `task` with every non-`data:` image load blocked, whatever mermaid source triggered it, so
 * correctness does not depend on recognising the syntax in `loadsImages`. Overlapping calls share one
 * set of patches and the last one out restores the originals, including when a task throws.
 */
export async function withRemoteImagesBlocked<T>(task: () => Promise<T>): Promise<T> {
  if (activeGuards === 0) {
    restoreGuards = installImageGuards()
  }
  activeGuards += 1
  try {
    return await task()
  } finally {
    activeGuards -= 1
    if (activeGuards === 0) {
      for (const restore of restoreGuards.toReversed()) {
        restore()
      }
      restoreGuards = []
    }
  }
}
