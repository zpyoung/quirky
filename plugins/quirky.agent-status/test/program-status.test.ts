import { describe, expect, test } from 'bun:test'
import {
  PROGRAM_STATUS_MAX_RECORDS,
  PROGRAM_STATUS_REPLY,
  ProgramStatusRecords,
  parseProgramStatusBody,
  projectRoot,
  type ProgramStatusReport,
} from '../src/program-status'

const b64 = (text: string) => Buffer.from(text).toString('base64')

function reportOf(body: string): ProgramStatusReport {
  const message = parseProgramStatusBody(body)
  if (message?.type !== 'report') throw new Error(`not a report: ${body}`)
  return message.report
}

describe('PROGRAM_STATUS_REPLY', () => {
  test('is the exact probe answer', () => {
    expect(PROGRAM_STATUS_REPLY).toBe('\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\')
  })
})

describe('parseProgramStatusBody', () => {
  test.each([
    ['?', { type: 'query' }],
    [' ? ', { type: 'query' }],
  ])('probe %j', (body, expected) => {
    expect(parseProgramStatusBody(body)).toEqual(expected as never)
  })

  test.each([
    ['state=working', { id: null, state: 'working' }],
    ['state=working:progress=40', { id: null, state: 'working', progress: 40 }],
    ['state=working:progress=100', { id: null, state: 'working', progress: 100 }],
    ['state=blocked:progress=5:kind=permission', { id: null, state: 'blocked', kind: 'permission', progress: 5 }],
    ['state=blocked:kind=auth', { id: null, state: 'blocked', kind: 'auth' }],
    ['state=done', { id: null, state: 'done' }],
    ['state=error', { id: null, state: 'error' }],
    ['state=idle', { id: null, state: 'idle' }],
    ['state=clear', { id: null, state: 'clear' }],
    ['state=working:id=a/b.c:app=claude-code', { id: 'a/b.c', state: 'working', app: 'claude-code' }],
    ['state=working:msg=SW5kZXhpbmc=', { id: null, state: 'working', msg: 'Indexing' }],
    ['state=working:msg=SW5kZXhpbmc', { id: null, state: 'working', msg: 'Indexing' }],
    ['state=working:title=VGl0bGU=', { id: null, state: 'working', title: 'Title' }],
  ])('report %j', (body, expected) => {
    expect(reportOf(body)).toEqual(expected as ProgramStatusReport)
  })

  test('kind applies only to blocked; unknown kind is dropped', () => {
    expect(reportOf('state=working:kind=permission').kind).toBeUndefined()
    expect(reportOf('state=blocked:kind=nope').kind).toBeUndefined()
  })

  test('progress applies only to working and blocked, and only 0..100 digits', () => {
    expect(reportOf('state=done:progress=40').progress).toBeUndefined()
    expect(reportOf('state=idle:progress=40').progress).toBeUndefined()
    expect(reportOf('state=working:progress=101').progress).toBeUndefined()
    expect(reportOf('state=working:progress=1000').progress).toBeUndefined()
    expect(reportOf('state=working:progress=x').progress).toBeUndefined()
    expect(reportOf('state=working:progress=0').progress).toBe(0)
  })

  test('a msg outside the value alphabet is skipped like any malformed pair', () => {
    expect(reportOf('state=working:msg=@@@@')).toEqual({ id: null, state: 'working' })
  })

  test('malformed pairs are skipped and the rest still applies', () => {
    expect(reportOf('state=working:junk:BAD=1:progress=7')).toEqual({ id: null, state: 'working', progress: 7 })
    expect(reportOf('state=working:note=has space')).toEqual({ id: null, state: 'working' })
  })

  test('an invalid app is dropped, an over-long one voids the report', () => {
    expect(reportOf('state=working:app=bad!').app).toBeUndefined()
    expect(parseProgramStatusBody(`state=working:app=${'a'.repeat(33)}`)).toBeNull()
    expect(reportOf(`state=working:app=${'a'.repeat(32)}`).app).toBe('a'.repeat(32))
  })

  test.each([
    ['no state', 'progress=40'],
    ['empty body', ''],
    ['bad state', 'state=sleeping'],
    ['uppercase state', 'state=WORKING'],
    ['base64 msg with url-safe characters', 'state=working:msg=a-b_'],
    ['base64 msg of impossible length', 'state=working:msg=abcde'],
    ['msg with a control character', `state=working:msg=${b64('a\nb')}`],
    ['msg with a C1 control', `state=working:msg=${b64('a\u0085b')}`],
    ['msg that is not UTF-8', `state=working:msg=${Buffer.from([0xff, 0xfe]).toString('base64')}`],
    ['msg over the decoded cap', `state=working:msg=${b64('a'.repeat(2049))}`],
    ['msg over the encoded cap', `state=working:msg=${'A'.repeat(2733)}`],
    ['title over the decoded cap', `state=working:title=${b64('a'.repeat(193))}`],
    ['bad id segment', 'state=working:id=a//b'],
    ['id with a bad character', 'state=working:id=a b'],
    ['id too deep', `state=working:id=${Array(9).fill('a').join('/')}`],
    ['id too long', `state=working:id=${'a'.repeat(129)}`],
    ['id segment too long', `state=working:id=${'a'.repeat(33)}`],
    ['key too long', `state=working:${'k'.repeat(17)}=1`],
    ['body over 4096', `state=working:msg=${'A'.repeat(4096)}`],
  ])('ignored: %s', (_name, body) => {
    expect(parseProgramStatusBody(body)).toBeNull()
  })

  test('a bad id in a duplicate voids the report even after a good one', () => {
    expect(parseProgramStatusBody('state=working:id=ok:id=a b')).toBeNull()
  })

  test('an over-limit msg voids the report even when a valid duplicate follows', () => {
    expect(parseProgramStatusBody(`state=working:msg=${b64('a'.repeat(2049))}:msg=${b64('ok')}`)).toBeNull()
  })

  test('the id depth limit allows eight segments', () => {
    expect(reportOf(`state=working:id=${Array(8).fill('a').join('/')}`).id).toBe('a/a/a/a/a/a/a/a')
  })
})

describe('ProgramStatusRecords', () => {
  const apply = (records: ProgramStatusRecords, body: string) => records.apply(reportOf(body))

  test('each report replaces its record whole', () => {
    const records = new ProgramStatusRecords()
    apply(records, 'state=working:progress=40:msg=SW5kZXhpbmc=')
    apply(records, 'state=working')
    expect(records.root()).toEqual({ id: null, state: 'working' })
  })

  test('a subtree clear removes the id and its descendants but not siblings or the root', () => {
    const records = new ProgramStatusRecords()
    for (const id of ['a', 'a/b', 'a/b/c', 'ab', 'z']) apply(records, `state=working:id=${id}`)
    apply(records, 'state=working')
    expect(apply(records, 'state=clear:id=a')).toBe(true)
    expect(records.size).toBe(3)
    expect(records.root()?.state).toBe('working')
    expect(apply(records, 'state=clear:id=a')).toBe(false)
  })

  test('a root clear resets everything', () => {
    const records = new ProgramStatusRecords()
    apply(records, 'state=working')
    apply(records, 'state=working:id=a')
    expect(apply(records, 'state=clear')).toBe(true)
    expect(records.size).toBe(0)
    expect(records.root()).toBeUndefined()
    expect(apply(records, 'state=clear')).toBe(false)
  })

  test('endProgram drops working, blocked and idle, keeps done and error', () => {
    const records = new ProgramStatusRecords()
    apply(records, 'state=working')
    apply(records, 'state=blocked:id=b')
    apply(records, 'state=idle:id=i')
    apply(records, 'state=done:id=d')
    apply(records, 'state=error:id=e')
    expect(records.endProgram()).toBe(true)
    expect(records.size).toBe(2)
    expect(records.root()).toBeUndefined()
    expect(records.endProgram()).toBe(false)
  })

  test('endProgram keeps a done root', () => {
    const records = new ProgramStatusRecords()
    apply(records, 'state=done')
    records.endProgram()
    expect(records.root()?.state).toBe('done')
  })

  test('holds at most 256 records and evicts the least recently updated', () => {
    const records = new ProgramStatusRecords()
    for (let i = 0; i < PROGRAM_STATUS_MAX_RECORDS; i++) apply(records, `state=working:id=n${i}`)
    apply(records, 'state=working:id=n0')
    apply(records, 'state=working:id=extra')
    expect(records.size).toBe(PROGRAM_STATUS_MAX_RECORDS)
    apply(records, 'state=clear:id=n0')
    apply(records, 'state=clear:id=n1')
    expect(records.size).toBe(PROGRAM_STATUS_MAX_RECORDS - 1)
  })
})

describe('projectRoot', () => {
  const project = (body: string) => {
    const records = new ProgramStatusRecords()
    apply(records, body)
    return projectRoot(records.root())
  }
  const apply = (records: ProgramStatusRecords, body: string) => records.apply(reportOf(body))

  test.each([
    ['state=working', { state: 'working' }],
    ['state=blocked:kind=permission', { state: 'waiting' }],
    ['state=blocked:kind=question', { state: 'waiting' }],
    ['state=blocked:kind=auth', { state: 'blocked' }],
    ['state=blocked', { state: 'blocked' }],
    ['state=done', { state: 'done', outcome: 'success' }],
    ['state=error', { state: 'done', outcome: 'failure' }],
    ['state=idle', { state: 'done', sessionBoundary: true }],
  ])('%s', (body, expected) => {
    expect(project(body)).toEqual(expected as never)
  })

  test('no root record projects to null', () => {
    expect(projectRoot(undefined)).toBeNull()
  })

  test('SC-22: the report sequence projects working, waiting, blocked, done, failed, then no row', () => {
    const records = new ProgramStatusRecords()
    const bodies = [
      '?',
      `state=working:progress=40:msg=${b64('Indexing')}`,
      'state=blocked:kind=permission',
      'state=blocked:kind=auth',
      'state=done',
      'state=error',
      'state=clear',
    ]
    const seen: unknown[] = []
    for (const body of bodies) {
      const message = parseProgramStatusBody(body)
      if (message?.type === 'query') {
        seen.push('probe')
        continue
      }
      if (message?.type !== 'report') throw new Error(body)
      records.apply(message.report)
      const root = records.root()
      seen.push([projectRoot(root), root?.progress, root?.msg])
    }
    expect(seen).toEqual([
      'probe',
      [{ state: 'working' }, 40, 'Indexing'],
      [{ state: 'waiting' }, undefined, undefined],
      [{ state: 'blocked' }, undefined, undefined],
      [{ state: 'done', outcome: 'success' }, undefined, undefined],
      [{ state: 'done', outcome: 'failure' }, undefined, undefined],
      [null, undefined, undefined],
    ])
  })

  test('SC-22: invalid reports leave the records untouched', () => {
    const records = new ProgramStatusRecords()
    records.apply(reportOf('state=working'))
    for (const bad of ['state=nope', 'state=working:msg=a-b_', `state=done:msg=${'A'.repeat(5000)}`]) {
      expect(parseProgramStatusBody(bad)).toBeNull()
    }
    expect(projectRoot(records.root())).toEqual({ state: 'working' })
  })

  test('SC-22: a prompt mark drops working and blocked but keeps done and error', () => {
    const records = new ProgramStatusRecords()
    records.apply(reportOf('state=working'))
    records.endProgram()
    expect(projectRoot(records.root())).toBeNull()
    records.apply(reportOf('state=error'))
    records.endProgram()
    expect(projectRoot(records.root())).toEqual({ state: 'done', outcome: 'failure' })
  })
})
