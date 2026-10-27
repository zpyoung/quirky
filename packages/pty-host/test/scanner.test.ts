import { describe, expect, test } from 'bun:test'
import { OutputScanner, type ScanFact } from '../src/scanner'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const ESC = '\x1b'
const BEL = '\x07'
const ST = `${ESC}\\`
const MARKER = `${ESC}]777;quirky-shell-ready${BEL}`

function scanAll(chunks: Uint8Array[]): { bytes: Uint8Array; facts: ScanFact[] } {
  const scanner = new OutputScanner()
  const parts: Uint8Array[] = []
  const facts: ScanFact[] = []
  for (const chunk of chunks) {
    const r = scanner.push(chunk)
    parts.push(r.bytes)
    facts.push(...r.facts)
  }
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    bytes.set(p, at)
    at += p.length
  }
  return { bytes, facts }
}

const scan = (s: string) => scanAll([enc(s)])
const byteWise = (input: Uint8Array) => scanAll(Array.from(input, (b) => new Uint8Array([b])))

describe('OutputScanner facts', () => {
  test('bell in ground', () => {
    const r = scan(`a${BEL}b`)
    expect(r.facts).toEqual([{ kind: 'bell' }])
    expect(dec(r.bytes)).toBe(`a${BEL}b`)
  })

  test('BEL that ends an OSC is not a bell', () => {
    const r = scan(`${ESC}]0;hello${BEL}`)
    expect(r.facts).toEqual([{ kind: 'title', title: 'hello' }])
  })

  test('ST-terminated OSC gives its fact and no bell', () => {
    const r = scan(`${ESC}]2;hello${ST}`)
    expect(r.facts).toEqual([{ kind: 'title', title: 'hello' }])
  })

  test('title from OSC 0 and OSC 2, with a multibyte title', () => {
    expect(scan(`${ESC}]0;a${BEL}`).facts).toEqual([{ kind: 'title', title: 'a' }])
    expect(scan(`${ESC}]2;café${BEL}`).facts).toEqual([{ kind: 'title', title: 'café' }])
  })

  test('OSC 1 and unknown OSCs give nothing', () => {
    expect(scan(`${ESC}]1;icon${BEL}${ESC}]52;c;AAAA${BEL}`).facts).toEqual([])
  })

  test('title dedupes against the last reported title', () => {
    const r = scan(`${ESC}]0;a${BEL}${ESC}]2;a${BEL}${ESC}]0;b${BEL}${ESC}]0;a${BEL}`)
    expect(r.facts).toEqual([
      { kind: 'title', title: 'a' },
      { kind: 'title', title: 'b' },
      { kind: 'title', title: 'a' },
    ])
  })

  test('cwd is percent-decoded, host ignored, and deduped', () => {
    const r = scan(
      `${ESC}]7;file://host/tmp/my%20dir${BEL}${ESC}]7;file:///tmp/my%20dir${ST}${ESC}]7;file://h/tmp/other${BEL}`,
    )
    expect(r.facts).toEqual([
      { kind: 'cwd', cwd: '/tmp/my dir' },
      { kind: 'cwd', cwd: '/tmp/other' },
    ])
  })

  test('non-file OSC 7 URLs are ignored', () => {
    expect(scan(`${ESC}]7;http://host/tmp${BEL}`).facts).toEqual([])
  })

  test('command-finished with and without an exit code', () => {
    const r = scan(`${ESC}]133;D;4${BEL}${ESC}]133;D${BEL}${ESC}]133;D;0${ST}`)
    expect(r.facts).toEqual([
      { kind: 'command-finished', exitCode: 4 },
      { kind: 'command-finished', exitCode: null },
      { kind: 'command-finished', exitCode: 0 },
    ])
  })

  test('prompt and command-start marks', () => {
    const r = scan(`${ESC}]133;A${BEL}$ ${ESC}]133;C${BEL}`)
    expect(r.facts).toEqual([{ kind: 'prompt' }, { kind: 'command-start' }])
    expect(dec(r.bytes)).toBe(`${ESC}]133;A${BEL}$ ${ESC}]133;C${BEL}`)
  })

  test('ready marker gives a ready fact and is removed from the output', () => {
    const r = scan(`before${MARKER}after`)
    expect(r.facts).toEqual([{ kind: 'ready' }])
    expect(dec(r.bytes)).toBe('beforeafter')
  })

  test('ST-terminated ready marker is removed too', () => {
    const r = scan(`x${ESC}]777;quirky-shell-ready${ST}y`)
    expect(r.facts).toEqual([{ kind: 'ready' }])
    expect(dec(r.bytes)).toBe('xy')
  })

  test('other OSC 777 payloads pass through untouched', () => {
    const input = `${ESC}]777;quirky-shell-ready-not${BEL}${ESC}]777;notify;t;b${BEL}`
    const r = scan(input)
    expect(r.facts).toEqual([])
    expect(dec(r.bytes)).toBe(input)
  })

  test('an oversized OSC payload gives no fact and passes through', () => {
    const input = `${ESC}]0;${'x'.repeat(5000)}${BEL}${ESC}]0;ok${BEL}`
    const r = scan(input)
    expect(r.facts).toEqual([{ kind: 'title', title: 'ok' }])
    expect(dec(r.bytes)).toBe(input)
  })

  test('a payload of exactly 4096 bytes still gives its fact', () => {
    const title = 'x'.repeat(4096 - 2)
    expect(scan(`${ESC}]0;${title}${BEL}`).facts).toEqual([{ kind: 'title', title }])
    expect(scan(`${ESC}]0;${title}y${BEL}`).facts).toEqual([])
  })

  test('CSI sequences pass through and a BEL-looking parameter is not a bell', () => {
    const input = `${ESC}[31;1mred${ESC}[0m`
    const r = scan(input)
    expect(r.facts).toEqual([])
    expect(dec(r.bytes)).toBe(input)
  })

  test('DCS content is ignored: BEL and embedded ESC ] give no facts', () => {
    const input = `${ESC}Pq#0;2;0;0;0${BEL}${ESC}]0;sneaky${BEL}${ESC}]777;quirky-shell-ready${BEL}${ST}after${BEL}`
    const r = scan(input)
    expect(r.facts).toEqual([{ kind: 'bell' }])
    expect(dec(r.bytes)).toBe(input)
  })

  test('APC, PM and SOS strings are ignored the same way', () => {
    for (const lead of ['_', '^', 'X']) {
      const input = `${ESC}${lead}data${BEL}${ESC}]0;t${BEL}${ST}`
      expect(scan(input).facts).toEqual([])
    }
  })

  test('CAN and SUB abort a sequence back to ground', () => {
    expect(scan(`${ESC}]0;title\x18${BEL}`).facts).toEqual([{ kind: 'bell' }])
    expect(scan(`${ESC}[12\x1a${BEL}`).facts).toEqual([{ kind: 'bell' }])
    expect(scan(`${ESC}Pdata\x18${BEL}`).facts).toEqual([{ kind: 'bell' }])
  })

  test('an ESC inside an OSC that is not ST aborts it and starts a new sequence', () => {
    const r = scan(`${ESC}]0;abc${ESC}]0;real${BEL}`)
    expect(r.facts).toEqual([{ kind: 'title', title: 'real' }])
  })
})

describe('OutputScanner program status (OSC 7501)', () => {
  test('reports the text after 7501; for both terminators and passes the bytes through', () => {
    const r = scan(`${ESC}]7501;v=1;state=working${BEL}x${ESC}]7501;v=1;state=idle${ST}`)
    expect(r.facts).toEqual([
      { kind: 'program-status', body: 'v=1;state=working' },
      { kind: 'program-status', body: 'v=1;state=idle' }
    ])
    expect(dec(r.bytes)).toBe(`${ESC}]7501;v=1;state=working${BEL}x${ESC}]7501;v=1;state=idle${ST}`)
  })

  test('the query body is reported as ?', () => {
    expect(scan(`${ESC}]7501;?${BEL}`).facts).toEqual([{ kind: 'program-status', body: '?' }])
  })

  test('a multibyte body is decoded', () => {
    expect(scan(`${ESC}]7501;msg=café${BEL}`).facts).toEqual([{ kind: 'program-status', body: 'msg=café' }])
  })

  test('a body that is not repeated is reported every time', () => {
    const r = scan(`${ESC}]7501;?${BEL}${ESC}]7501;?${BEL}`)
    expect(r.facts).toHaveLength(2)
  })

  test('an over-cap payload is ignored', () => {
    const r = scan(`${ESC}]7501;${'a'.repeat(5000)}${BEL}`)
    expect(r.facts).toEqual([])
  })

  test('every two-way split and byte-at-a-time scanning give the unsplit facts and bytes', () => {
    const input = enc(`a${ESC}]7501;v=1;state=blocked;kind=permission${BEL}b${ESC}]7501;?${ST}${MARKER}c`)
    const whole = scanAll([input])
    expect(whole.facts).toEqual([
      { kind: 'program-status', body: 'v=1;state=blocked;kind=permission' },
      { kind: 'program-status', body: '?' },
      { kind: 'ready' }
    ])
    for (let i = 0; i <= input.length; i++) {
      const r = scanAll([input.subarray(0, i), input.subarray(i)])
      expect(r.facts).toEqual(whole.facts)
      expect(r.bytes).toEqual(whole.bytes)
    }
    const bytewise = byteWise(input)
    expect(bytewise.facts).toEqual(whole.facts)
    expect(bytewise.bytes).toEqual(whole.bytes)
  })
})

describe('OutputScanner split safety', () => {
  test('the ready marker is removed whole when split at every byte position', () => {
    const input = enc(`pre${MARKER}post`)
    for (let i = 0; i <= input.length; i++) {
      const r = scanAll([input.subarray(0, i), input.subarray(i)])
      expect(dec(r.bytes)).toBe('prepost')
      expect(r.facts).toEqual([{ kind: 'ready' }])
    }
  })

  test('the ST-terminated marker is removed whole at every split position', () => {
    const input = enc(`pre${ESC}]777;quirky-shell-ready${ST}post`)
    for (let i = 0; i <= input.length; i++) {
      const r = scanAll([input.subarray(0, i), input.subarray(i)])
      expect(dec(r.bytes)).toBe('prepost')
      expect(r.facts).toEqual([{ kind: 'ready' }])
    }
  })

  test('a near-marker is released in order at every split position', () => {
    const input = enc(`a${ESC}]777;quirky-shell-readyX${BEL}b`)
    for (let i = 0; i <= input.length; i++) {
      const r = scanAll([input.subarray(0, i), input.subarray(i)])
      expect(r.bytes).toEqual(input)
      expect(r.facts).toEqual([])
    }
  })

  test('an OSC that ends while its payload is a marker prefix passes through in order at every split position', () => {
    const cases: { input: string; facts: ScanFact[] }[] = [
      { input: `${ESC}]7;file://h/tmp${BEL}`, facts: [{ kind: 'cwd', cwd: '/tmp' }] },
      { input: `${ESC}]777${BEL}`, facts: [] },
      { input: `${ESC}]777;quirky${BEL}`, facts: [] },
      { input: `${ESC}]777;quirky${ST}`, facts: [] },
      { input: `${ESC}]7${ST}`, facts: [] },
      { input: `${ESC}]7${BEL}X`, facts: [] },
    ]
    for (const { input, facts } of cases) {
      const bytes = enc(input)
      expect(scanAll([bytes]).bytes).toEqual(bytes)
      for (let i = 0; i <= bytes.length; i++) {
        const r = scanAll([bytes.subarray(0, i), bytes.subarray(i)])
        expect(dec(r.bytes)).toBe(input)
        expect(r.facts).toEqual(facts)
      }
      expect(byteWise(bytes).bytes).toEqual(bytes)
    }
  })

  test('held marker bytes are released in the push that rules out the marker', () => {
    const scanner = new OutputScanner()
    expect(dec(scanner.push(enc(`a${ESC}]777;quirk`)).bytes)).toBe('a')
    expect(dec(scanner.push(enc('z')).bytes)).toBe(`${ESC}]777;quirkz`)
  })

  test('non-marker bytes are returned in the push they arrive in', () => {
    const scanner = new OutputScanner()
    expect(dec(scanner.push(enc('hello')).bytes)).toBe('hello')
    expect(dec(scanner.push(enc(`${ESC}[1`)).bytes)).toBe(`${ESC}[1`)
    expect(dec(scanner.push(enc('mworld')).bytes)).toBe('mworld')
  })

  test('byte-at-a-time input of a mixed stream matches one push', () => {
    const input = enc(
      [
        'plain ',
        BEL,
        `${ESC}[31mred${ESC}[0m`,
        `${ESC}]0;title${BEL}`,
        `${ESC}]0;title${ST}`,
        `${ESC}]7;file://h/tmp/a%20b${BEL}`,
        `${ESC}]133;A${BEL}`,
        `${ESC}]133;C${ST}`,
        `${ESC}]133;D;4${BEL}`,
        `${ESC}Pq${BEL}${ESC}]0;no${BEL}${ST}`,
        `${ESC}(B`,
        MARKER,
        'café ☃ 🎉',
        `${ESC}]777;other${BEL}`,
        BEL,
      ].join(''),
    )
    const whole = scanAll([input])
    const bytewise = byteWise(input)
    expect(bytewise.facts).toEqual(whole.facts)
    expect(bytewise.bytes).toEqual(whole.bytes)
    expect(whole.facts.map((f) => f.kind)).toEqual([
      'bell',
      'title',
      'cwd',
      'prompt',
      'command-start',
      'command-finished',
      'ready',
      'bell',
    ])
  })

  test('every two-way split of a mixed stream gives the same facts and bytes', () => {
    const input = enc(`a${BEL}${ESC}]0;t${BEL}${ESC}]133;D;2${ST}${MARKER}${ESC}Px${BEL}${ST}é`)
    const whole = scanAll([input])
    for (let i = 0; i <= input.length; i++) {
      const r = scanAll([input.subarray(0, i), input.subarray(i)])
      expect(r.facts).toEqual(whole.facts)
      expect(r.bytes).toEqual(whole.bytes)
    }
  })
})

describe('OutputScanner.atBoundary', () => {
  test('true initially and after plain text', () => {
    const scanner = new OutputScanner()
    expect(scanner.atBoundary).toBe(true)
    scanner.push(enc('hello\r\n'))
    expect(scanner.atBoundary).toBe(true)
  })

  test('false mid-CSI, true after the final byte', () => {
    const scanner = new OutputScanner()
    scanner.push(enc(`${ESC}[3`))
    expect(scanner.atBoundary).toBe(false)
    scanner.push(enc('1m'))
    expect(scanner.atBoundary).toBe(true)
  })

  test('false after a lone ESC', () => {
    const scanner = new OutputScanner()
    scanner.push(enc(ESC))
    expect(scanner.atBoundary).toBe(false)
    scanner.push(enc('M'))
    expect(scanner.atBoundary).toBe(true)
  })

  test('false mid-OSC, including a held marker prefix, true after the terminator', () => {
    const scanner = new OutputScanner()
    scanner.push(enc(`${ESC}]0;ti`))
    expect(scanner.atBoundary).toBe(false)
    scanner.push(enc(`tle${BEL}`))
    expect(scanner.atBoundary).toBe(true)
    scanner.push(enc(`${ESC}]777;quirky`))
    expect(scanner.atBoundary).toBe(false)
    scanner.push(enc(`-shell-ready${BEL}`))
    expect(scanner.atBoundary).toBe(true)
  })

  test('false mid-DCS, true after ST', () => {
    const scanner = new OutputScanner()
    scanner.push(enc(`${ESC}Pdata${ESC}`))
    expect(scanner.atBoundary).toBe(false)
    scanner.push(enc('\\'))
    expect(scanner.atBoundary).toBe(true)
  })

  test('false mid-UTF-8, true once the sequence completes', () => {
    const scanner = new OutputScanner()
    const bytes = enc('é')
    scanner.push(bytes.subarray(0, 1))
    expect(scanner.atBoundary).toBe(false)
    scanner.push(bytes.subarray(1))
    expect(scanner.atBoundary).toBe(true)

    const emoji = enc('🎉')
    for (let n = 1; n < emoji.length; n++) {
      scanner.push(emoji.subarray(n - 1, n))
      expect(scanner.atBoundary).toBe(false)
    }
    scanner.push(emoji.subarray(emoji.length - 1))
    expect(scanner.atBoundary).toBe(true)
  })
})
