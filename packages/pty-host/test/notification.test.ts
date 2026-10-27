import { describe, expect, test } from 'bun:test'
import { OutputScanner, type ScanFact } from '../src/scanner'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const ESC = '\x1b'
const BEL = '\x07'
const ST = `${ESC}\\`

type Notification = Extract<ScanFact, { kind: 'notification' }>

function scanAll(chunks: Uint8Array[]): { text: string; facts: ScanFact[] } {
  const scanner = new OutputScanner()
  let text = ''
  const facts: ScanFact[] = []
  for (const chunk of chunks) {
    const r = scanner.push(chunk)
    text += dec(r.bytes)
    facts.push(...r.facts)
  }
  return { text, facts }
}

const scan = (s: string) => scanAll([enc(s)])
const notes = (s: string): Notification[] => scan(s).facts.filter((f): f is Notification => f.kind === 'notification')
const note = (title: string | null, body: string, occasion: Notification['occasion'] = 'always'): Notification => ({
  kind: 'notification',
  title,
  body,
  occasion
})
const osc99 = (meta: string, payload: string, end = ST) => `${ESC}]99;${meta};${payload}${end}`
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')

describe('OSC 777 notify (SC-29)', () => {
  test('title and body', () => {
    expect(notes(`${ESC}]777;notify;Build;done in 4s${BEL}`)).toEqual([note('Build', 'done in 4s')])
  })

  test('the body keeps later semicolons', () => {
    expect(notes(`${ESC}]777;notify;Build;a;b;c${BEL}`)).toEqual([note('Build', 'a;b;c')])
  })

  test('a title alone gives an empty body, a body alone gives no title', () => {
    expect(notes(`${ESC}]777;notify;Build${BEL}`)).toEqual([note('Build', '')])
    expect(notes(`${ESC}]777;notify;;just body${BEL}`)).toEqual([note(null, 'just body')])
  })

  test('empty title and body give nothing', () => {
    expect(notes(`${ESC}]777;notify;;${BEL}`)).toEqual([])
    expect(notes(`${ESC}]777;notify;${BEL}`)).toEqual([])
  })

  test('other 777 payloads give nothing', () => {
    expect(notes(`${ESC}]777;precmd${BEL}${ESC}]777;notifyx;a;b${BEL}${ESC}]777;notify${BEL}`)).toEqual([])
  })

  test('ST terminator and the bytes pass through unchanged', () => {
    const input = `a${ESC}]777;notify;T;B${ST}b`
    const r = scan(input)
    expect(r.facts).toEqual([note('T', 'B')])
    expect(r.text).toBe(input)
  })

  test('byte-wise delivery gives the same fact', () => {
    const input = enc(`${ESC}]777;notify;Build;done${BEL}`)
    const r = scanAll(Array.from(input, (b) => new Uint8Array([b])))
    expect(r.facts).toEqual([note('Build', 'done')])
    expect(r.text).toBe(dec(input))
  })
})

describe('OSC 9 (SC-30)', () => {
  test('plain text is a body with no title', () => {
    expect(notes(`${ESC}]9;Tests passed${ST}`)).toEqual([note(null, 'Tests passed')])
  })

  test('ConEmu subcommands give nothing', () => {
    expect(notes(`${ESC}]9;4;1;50${ST}${ESC}]9;9;/tmp${ST}${ESC}]9;4${ST}${ESC}]9;12${ST}`)).toEqual([])
  })

  test('text that starts with digits but is not a bare subcommand is a notification', () => {
    expect(notes(`${ESC}]9;3 tests failed${ST}`)).toEqual([note(null, '3 tests failed')])
    expect(notes(`${ESC}]9;4x${ST}`)).toEqual([note(null, '4x')])
  })

  test('the three forms in sequence make exactly one fact', () => {
    expect(notes(`${ESC}]9;Tests passed${ST}${ESC}]9;4;1;50${ST}${ESC}]9;9;/tmp${ST}`)).toEqual([note(null, 'Tests passed')])
  })

  test('empty text gives nothing', () => {
    expect(notes(`${ESC}]9;${ST}`)).toEqual([])
    expect(notes(`${ESC}]9;  ${ST}`)).toEqual([])
  })
})

describe('OSC 99 (SC-31, SC-32)', () => {
  test('a plain sequence is a title', () => {
    expect(notes(osc99('', 'Hi'))).toEqual([note('Hi', '')])
  })

  test('chunks with the same id accumulate title and body', () => {
    expect(notes(osc99('i=1:d=0', 'Build') + osc99('i=1:p=body', 'ok'))).toEqual([note('Build', 'ok')])
  })

  test('chunks of one field concatenate', () => {
    const input = osc99('i=7:d=0', 'Bu') + osc99('i=7:d=0', 'ild') + osc99('i=7:p=body:d=0', 'o') + osc99('i=7:p=body', 'k')
    expect(notes(input)).toEqual([note('Build', 'ok')])
  })

  test('nothing is reported until the last chunk', () => {
    const scanner = new OutputScanner()
    expect(scanner.push(enc(osc99('i=1:d=0', 'Build'))).facts).toEqual([])
    expect(scanner.push(enc(osc99('i=1:p=body', 'ok'))).facts).toEqual([note('Build', 'ok')])
  })

  test('ids are independent and a finished id starts fresh', () => {
    const input = osc99('i=1:d=0', 'A') + osc99('i=2:d=0', 'B') + osc99('i=2', 'x') + osc99('i=1:p=body', 'y') + osc99('i=1', 'C')
    expect(notes(input)).toEqual([note('Bx', ''), note('A', 'y'), note('C', '')])
  })

  test('a chunk without an id completes on its own', () => {
    expect(notes(osc99('d=0', 'Solo'))).toEqual([note('Solo', '')])
  })

  test('base64 payloads decode as UTF-8', () => {
    expect(notes(osc99('e=1:p=body', b64('hello')))).toEqual([note(null, 'hello')])
    expect(notes(osc99('e=1', b64('café ✓')))).toEqual([note('café ✓', '')])
  })

  test('invalid base64 drops the chunk and leaves pending text alone', () => {
    expect(notes(osc99('e=1', '!!!not base64!!!'))).toEqual([])
    const input = osc99('i=1:d=0', 'Build') + osc99('i=1:e=1:p=body', '%%%') + osc99('i=1:p=body', 'ok')
    expect(notes(input)).toEqual([note('Build', 'ok')])
  })

  test('other payload types are ignored whole', () => {
    expect(notes(osc99('p=icon', 'x'))).toEqual([])
    expect(notes(osc99('i=3:d=0:p=icon', 'x') + osc99('i=3', 'T'))).toEqual([note('T', '')])
  })

  test('a query gives nothing and writes nothing back', () => {
    const input = osc99('i=2:p=?', '')
    const r = new OutputScanner().push(enc(input))
    expect(r.facts).toEqual([])
    expect(dec(r.bytes)).toBe(input)
  })

  test('the whole SC-31 sequence', () => {
    const input =
      osc99('i=1:d=0', 'Build') + osc99('i=1:p=body', 'ok') + osc99('e=1:p=body', 'aGVsbG8=') + osc99('p=icon', 'x') + osc99('i=2:p=?', '')
    expect(notes(input)).toEqual([note('Build', 'ok'), note(null, 'hello')])
  })

  test('the occasion is carried, and unknown values mean always', () => {
    expect(notes(osc99('o=unfocused', 'Hi'))).toEqual([note('Hi', '', 'unfocused')])
    expect(notes(osc99('o=invisible', 'Hey'))).toEqual([note('Hey', '', 'invisible')])
    expect(notes(osc99('o=always', 'A'))).toEqual([note('A', '', 'always')])
    expect(notes(osc99('o=sometimes', 'A'))).toEqual([note('A', '', 'always')])
  })

  test('the occasion set on an earlier chunk survives to the last', () => {
    expect(notes(osc99('i=1:o=unfocused:d=0', 'T') + osc99('i=1:p=body', 'B'))).toEqual([note('T', 'B', 'unfocused')])
  })

  test('unknown keys are ignored', () => {
    expect(notes(osc99('a=focus:u=2:zz', 'Hi'))).toEqual([note('Hi', '')])
  })

  test('a sequence split at every byte gives the same facts', () => {
    const input = enc(osc99('i=1:d=0', 'Build') + osc99('i=1:p=body:o=unfocused', 'ok'))
    const r = scanAll(Array.from(input, (b) => new Uint8Array([b])))
    expect(r.facts).toEqual([note('Build', 'ok', 'unfocused')])
  })

  test('at most 16 pending ids are kept, oldest dropped', () => {
    let input = ''
    for (let id = 1; id <= 17; id++) input += osc99(`i=${id}:d=0`, `t${id}`)
    input += osc99('i=1:p=body', 'late-1') + osc99('i=2:p=body', 'late-2') + osc99('i=17:p=body', 'late-17')
    const facts = notes(input)
    expect(facts).toEqual([note(null, 'late-1'), note('t2', 'late-2'), note('t17', 'late-17')])
  })

  test('title and body are each capped at 4096 characters as they arrive', () => {
    const scanner = new OutputScanner()
    for (let n = 0; n < 4; n++) scanner.push(enc(osc99('i=1:d=0', 'a'.repeat(3000))))
    for (let n = 0; n < 4; n++) scanner.push(enc(osc99('i=1:p=body:d=0', 'b'.repeat(3000))))
    const [fact] = scanner.push(enc(osc99('i=1:p=body', 'c'.repeat(10)))).facts as Notification[]
    expect(fact!.title).toBe(`${'a'.repeat(255)}…`)
    expect(fact!.body).toBe(`${'b'.repeat(255)}…`)
  })

  test('text past the cap is discarded, not held for later', () => {
    const scanner = new OutputScanner()
    scanner.push(enc(osc99('i=1:d=0', `a${' '.repeat(3000)}`)))
    scanner.push(enc(osc99('i=1:d=0', `${' '.repeat(3000)}END`)))
    const [fact] = scanner.push(enc(osc99('i=1:p=body', 'ok'))).facts as Notification[]
    expect(fact).toEqual(note('a', 'ok'))
  })
})

describe('text cleaning (SC-33)', () => {
  test('controls are removed and whitespace collapses to single spaces', () => {
    const title = `Bu\x01i\u0085ld\tstep\n\n  one \x7f`
    expect(notes(`${ESC}]777;notify;${title};ok${BEL}`)).toEqual([note('Build step one', 'ok')])
  })

  test('a long body is cut to 256 characters ending in an ellipsis', () => {
    const [fact] = notes(`${ESC}]777;notify;T;${'x'.repeat(400)}${BEL}`)
    expect(Array.from(fact!.body)).toHaveLength(256)
    expect(fact!.body).toBe(`${'x'.repeat(255)}…`)
  })

  test('a body of exactly 256 characters is not cut', () => {
    const [fact] = notes(`${ESC}]777;notify;T;${'x'.repeat(256)}${BEL}`)
    expect(fact!.body).toBe('x'.repeat(256))
  })

  test('the cut never splits a surrogate pair', () => {
    const [fact] = notes(`${ESC}]777;notify;T;${'🎉'.repeat(300)}${BEL}`)
    expect(fact!.body).toBe(`${'🎉'.repeat(255)}…`)
    expect(Array.from(fact!.body)).toHaveLength(256)
  })

  test('cleaning applies to OSC 9 and OSC 99 text too', () => {
    expect(notes(`${ESC}]9;a\tb\x01c${ST}`)).toEqual([note(null, 'a bc')])
    expect(notes(osc99('e=1', b64('x\ny')))).toEqual([note('x y', '')])
  })

  test('text that cleans to nothing gives no fact', () => {
    expect(notes(`${ESC}]9;\x01\x02 \t${ST}`)).toEqual([])
    expect(notes(`${ESC}]777;notify;\x01;\x02${BEL}`)).toEqual([])
  })
})

describe('the shell-ready marker (SC-34)', () => {
  test('is still stripped, reported as ready, and raises no notification', () => {
    const r = scan(`a${ESC}]777;quirky-shell-ready${BEL}b`)
    expect(r.facts).toEqual([{ kind: 'ready' }])
    expect(r.text).toBe('ab')
  })

  test('a payload that merely starts like the marker passes through and gives nothing', () => {
    const input = `${ESC}]777;quirky-shell-readyx${BEL}`
    const r = scan(input)
    expect(r.facts).toEqual([])
    expect(r.text).toBe(input)
  })

  test('an oversized OSC payload gives no notification', () => {
    expect(notes(`${ESC}]777;notify;T;${'x'.repeat(5000)}${BEL}`)).toEqual([])
  })
})
