import { describe, expect, test } from 'bun:test'
import { escapeLooseDollars } from '../src/markdown/math-dollars'

describe('escapeLooseDollars', () => {
  test('prices stay text', () => {
    expect(escapeLooseDollars('costs $5 and $10')).toBe('costs \\$5 and \\$10')
  })

  test('a lone dollar is escaped', () => {
    expect(escapeLooseDollars('pay $5')).toBe('pay \\$5')
  })

  test('inline code is never touched', () => {
    expect(escapeLooseDollars('run `echo $HOME` then `$PATH and $HOME`')).toBe('run `echo $HOME` then `$PATH and $HOME`')
  })

  test('a tight pair is math', () => {
    expect(escapeLooseDollars('complexity $O(n)$ here')).toBe('complexity $O(n)$ here')
  })

  test('a pair with a space inside the opening dollar is not math', () => {
    expect(escapeLooseDollars('a $ x$ b')).toBe('a \\$ x\\$ b')
  })

  test('a pair with a space before the closing dollar is not math', () => {
    expect(escapeLooseDollars('a $x $ b')).toBe('a \\$x \\$ b')
  })

  test('a closing dollar followed by a digit is not math', () => {
    expect(escapeLooseDollars('$x$5')).toBe('\\$x\\$5')
  })

  test('a price before real math keeps the math', () => {
    expect(escapeLooseDollars('costs $5, and $x+1$ holds')).toBe('costs \\$5, and $x+1$ holds')
  })

  test('double dollars are left alone', () => {
    expect(escapeLooseDollars('$$T = \\sum c_i$$')).toBe('$$T = \\sum c_i$$')
    expect(escapeLooseDollars('before\n\n$$\nT = \\sum c_i\n$$\n\nafter $5')).toBe('before\n\n$$\nT = \\sum c_i\n$$\n\nafter \\$5')
  })

  test('paren and bracket delimiters become dollars', () => {
    expect(escapeLooseDollars('so \\(x^2\\) holds')).toBe('so $x^2$ holds')
    expect(escapeLooseDollars('so \\[x^2\\] holds')).toBe('so $$x^2$$ holds')
    expect(escapeLooseDollars('\\[\nx^2\n\\]')).toBe('$$\nx^2\n$$')
  })

  test('an already escaped dollar is kept', () => {
    expect(escapeLooseDollars('it is \\$5')).toBe('it is \\$5')
  })

  test('fenced code is untouched', () => {
    const fenced = 'before $5\n\n```sh\necho $HOME and $PATH\n```\n\nafter $7'
    expect(escapeLooseDollars(fenced)).toBe('before \\$5\n\n```sh\necho $HOME and $PATH\n```\n\nafter \\$7')
    const tilde = '~~~\n$a and $b\n~~~'
    expect(escapeLooseDollars(tilde)).toBe(tilde)
  })

  test('fenced code nested in a blockquote is untouched, for both fence characters', () => {
    const backtick = '> ```sh\n> echo $HOME and $PATH\n> ```\n\nafter $7'
    expect(escapeLooseDollars(backtick)).toBe('> ```sh\n> echo $HOME and $PATH\n> ```\n\nafter \\$7')
    const tilde = '> ~~~sh\n> echo $HOME and $PATH\n> ~~~\n\nafter $7'
    expect(escapeLooseDollars(tilde)).toBe('> ~~~sh\n> echo $HOME and $PATH\n> ~~~\n\nafter \\$7')
  })

  test('a blockquote fence ends with the quote, so prose after an unclosed one is still rewritten', () => {
    expect(escapeLooseDollars('> ```sh\n> echo $HOME\n\ncosts $5')).toBe('> ```sh\n> echo $HOME\n\ncosts \\$5')
  })

  test('fenced code nested in a list item is untouched, however deep it is indented', () => {
    const marker = '- ```sh\n  echo $HOME\n  ```\n- costs $5'
    expect(escapeLooseDollars(marker)).toBe('- ```sh\n  echo $HOME\n  ```\n- costs \\$5')
    const own = '1. step $5\n\n   ~~~sh\n   echo $HOME\n   ~~~\n\nafter $7'
    expect(escapeLooseDollars(own)).toBe('1. step \\$5\n\n   ~~~sh\n   echo $HOME\n   ~~~\n\nafter \\$7')
    const deep = '- item\n\n    ```sh\n    echo $HOME\n    ```\n\nafter $7'
    expect(escapeLooseDollars(deep)).toBe('- item\n\n    ```sh\n    echo $HOME\n    ```\n\nafter \\$7')
  })

  test('a fence inside a quoted list item is untouched', () => {
    expect(escapeLooseDollars('> - ~~~sh\n>   echo $HOME\n>   ~~~')).toBe('> - ~~~sh\n>   echo $HOME\n>   ~~~')
  })

  test('an open fence is untouched to the end', () => {
    expect(escapeLooseDollars('```sh\necho $HOME and $PATH')).toBe('```sh\necho $HOME and $PATH')
  })

  test('indented code is untouched', () => {
    expect(escapeLooseDollars('text\n\n    echo $HOME and $PATH\n\nmore $5')).toBe('text\n\n    echo $HOME and $PATH\n\nmore \\$5')
  })

  test('a pair never spans a blank line', () => {
    expect(escapeLooseDollars('a $x\n\ny$ b')).toBe('a \\$x\n\ny\\$ b')
  })

  test('is idempotent', () => {
    const once = escapeLooseDollars('costs $5 and $10, $O(n)$, \\(x\\)')
    expect(escapeLooseDollars(once)).toBe(once)
  })
})
