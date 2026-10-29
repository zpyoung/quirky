import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { readFileSync } from 'node:fs'

beforeAll(() => {
  GlobalRegistrator.register()
  const style = document.createElement('style')
  style.textContent = [
    '../src/design-system/accounts.css',
    '../src/design-system/terminal-tools.css'
  ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')
  document.head.appendChild(style)
})

afterEach(() => {
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

test('an accessory without rendered content cannot cover terminal output', () => {
  const host = document.createElement('div')
  host.className = 'qt-pane-accessory accounts-mount-root accounts-mount-root--accessory'
  document.body.appendChild(host)

  expect(getComputedStyle(host).display).toBe('none')

  const control = document.createElement('button')
  control.textContent = 'Switch account'
  host.appendChild(control)
  expect(getComputedStyle(host).display).not.toBe('none')

  host.replaceChildren()
  expect(getComputedStyle(host).display).toBe('none')
})
