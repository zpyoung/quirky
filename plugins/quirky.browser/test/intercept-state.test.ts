import { expect, test } from 'bun:test'
import { fetchDomainCommand, InterceptLedger, MAX_HELD_REQUESTS } from '../src/runtime/intercept'

const request = (id: string, networkId?: string) => ({
  id, url: `http://127.0.0.1/${id}`, method: 'GET', headers: { accept: '*/*' }, resourceType: 'Fetch',
  ...(networkId === undefined ? {} : { networkId })
})

test('held requests are pending, oldest first, and duplicate ids do not replace them', () => {
  const ledger = new InterceptLedger()
  expect(ledger.hold(request('first', 'network-first'))).toBe(true)
  expect(ledger.hold(request('second'))).toBe(true)
  expect(ledger.hold({ ...request('first'), url: 'http://127.0.0.1/replacement' })).toBe(false)
  expect(ledger.list()).toEqual([
    { id: 'first', url: 'http://127.0.0.1/first', method: 'GET', headers: { accept: '*/*' }, resourceType: 'Fetch', pending: true },
    { ...request('second'), pending: true }
  ])
  expect(ledger.take()).toEqual(['first', 'second'])
  expect(ledger.list()).toEqual([])
  expect(ledger.take()).toEqual([])
})

test('network failure forgets only the corresponding held request', () => {
  const ledger = new InterceptLedger()
  ledger.hold(request('first', 'network-first'))
  ledger.hold(request('second', 'network-second'))
  ledger.forget('unknown')
  expect(ledger.list().map(({ id }) => id)).toEqual(['first', 'second'])
  ledger.forget('network-first')
  expect(ledger.take()).toEqual(['second'])
  ledger.forget('network-second')
  expect(ledger.hold(request('third', 'network-second'))).toBe(true)
  ledger.forget('network-second')
  expect(ledger.list()).toEqual([])
})

test('the per-page bound rejects overflow and taking requests frees capacity', () => {
  const ledger = new InterceptLedger()
  expect(MAX_HELD_REQUESTS).toBe(1_000)
  for (let i = 0; i < 1_000; i++) expect(ledger.hold(request(String(i)))).toBe(true)
  expect(ledger.hold(request('overflow'))).toBe(false)
  expect(ledger.take()).toEqual(Array.from({ length: 1_000 }, (_, i) => String(i)))
  expect(ledger.hold(request('next'))).toBe(true)
  expect(ledger.list()).toEqual([{ ...request('next'), pending: true }])
})

test('suspension passes new requests through without losing already held requests', () => {
  const ledger = new InterceptLedger()
  ledger.hold(request('held'))
  ledger.suspended = true
  expect(ledger.hold(request('restore'))).toBe(false)
  expect(ledger.take()).toEqual(['held'])
  ledger.suspended = false
  expect(ledger.hold(request('later'))).toBe(true)
})

test('Fetch settings preserve route and authentication behavior on watched and unwatched pages', () => {
  expect(fetchDomainCommand({ routes: [] }, false)).toEqual({ method: 'Fetch.disable', params: {} })
  expect(fetchDomainCommand({ routes: ['**/api/*'] }, false)).toEqual({
    method: 'Fetch.enable', params: { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] }
  })
  expect(fetchDomainCommand({ routes: [], credentials: { user: 'u', pass: 'p' } }, false)).toEqual({
    method: 'Fetch.enable', params: { handleAuthRequests: true }
  })
  expect(fetchDomainCommand({ routes: ['a'] }, true)).toEqual({
    method: 'Fetch.enable', params: { patterns: [{ urlPattern: 'a', requestStage: 'Request' }], handleAuthRequests: true }
  })
  expect(fetchDomainCommand({ routes: [] }, true)).toEqual({ method: 'Fetch.enable', params: { handleAuthRequests: true } })
})
