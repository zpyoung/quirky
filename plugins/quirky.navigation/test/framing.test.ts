import { expect, test } from 'bun:test'
import { MessageReader } from '../src/framing'

function frame(value: unknown, headers = ''): Buffer {
  const body = Buffer.from(JSON.stringify(value))
  return Buffer.concat([Buffer.from(`${headers}Content-Length: ${body.length}\r\n\r\n`), body])
}

test('decodes split headers, bodies and UTF-8 characters without losing bytes', () => {
  const value = { text: 'héllo 🙂' }
  const bytes = frame(value)
  for (let split = 1; split < bytes.length; split++) {
    const reader = new MessageReader()
    expect(reader.push(bytes.subarray(0, split))).toEqual([])
    expect(reader.push(bytes.subarray(split))).toEqual([value])
  }
  const reader = new MessageReader()
  const result = [...bytes].flatMap((byte) => reader.push(Uint8Array.of(byte)))
  expect(result).toEqual([value])
})

test('reads multiple frames with LSP headers and case-insensitive length', () => {
  const reader = new MessageReader()
  const first = frame({ first: true }, 'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n')
  const second = frame({ second: 2 }).toString().replace('Content-Length', 'content-length')
  expect(reader.push(Buffer.concat([first, Buffer.from(second)]))).toEqual([{ first: true }, { second: 2 }])
})

test('does not decode a Unicode body until its full byte length arrives', () => {
  const reader = new MessageReader()
  const body = Buffer.from(JSON.stringify({ text: '🙂' }))
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`)
  const characterLength = JSON.stringify({ text: '🙂' }).length
  expect(reader.push(Buffer.concat([header, body.subarray(0, characterLength)]))).toEqual([])
  expect(reader.push(body.subarray(characterLength))).toEqual([{ text: '🙂' }])
})
