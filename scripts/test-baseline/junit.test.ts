import { expect, test } from 'bun:test'
import { parseJunit } from './junit'

const SEP = '\0'
const key = (file: string, classname: string, name: string) => [file, classname, name].join(SEP)
const wrap = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${body}\n</testsuites>`

test('empty and blank input give no results', () => {
  expect(parseJunit('', 'a.test.ts')).toEqual([])
  expect(parseJunit('  \n', 'a.test.ts')).toEqual([])
  expect(parseJunit(wrap(''), 'a.test.ts')).toEqual([])
})

test('reads nested suites with the classname exactly as reported', () => {
  const xml = wrap(`
<testsuite name="a.test.ts">
  <testsuite name="outer">
    <testsuite name="inner">
      <testcase name="deep" classname="inner &gt; outer" time="0" file="a.test.ts" />
    </testsuite>
  </testsuite>
  <testcase name="top" classname="" time="0" file="a.test.ts" line="3" assertions="0" />
</testsuite>`)
  expect(parseJunit(xml, 'a.test.ts')).toEqual([
    { key: key('a.test.ts', 'inner > outer', 'deep'), status: 'passed' },
    { key: key('a.test.ts', '', 'top'), status: 'passed' }
  ])
})

test('maps failure and skipped children to statuses, in both testcase forms', () => {
  const xml = wrap(`
<testsuite name="a.test.ts">
  <testcase name="bad" classname="" file="a.test.ts">
    <failure type="AssertionError" message="Expected: 2&#10;Received: 1">trace</failure>
  </testcase>
  <testcase name="skip" classname="" file="a.test.ts">
    <skipped />
  </testcase>
  <testcase name="todo" classname="" file="a.test.ts">
    <skipped message="TODO" />
  </testcase>
  <testcase name="open" classname="" file="a.test.ts">
  </testcase>
  <testcase name="closed" classname="" file="a.test.ts" />
  <testcase name="closed-tight" classname="" file="a.test.ts"/>
</testsuite>`)
  expect(parseJunit(xml, 'a.test.ts').map((test) => test.status)).toEqual(['failed', 'skipped', 'skipped', 'passed', 'passed', 'passed'])
})

test('a failure after a self-closing testcase belongs to its own testcase', () => {
  const xml = wrap(`
<testcase name="one" classname="" />
<testcase name="two" classname=""><failure message="x" /></testcase>
<testcase name="three" classname="" />`)
  expect(parseJunit(xml, 'f').map((test) => test.status)).toEqual(['passed', 'failed', 'passed'])
})

test('decodes XML entities in names and classnames', () => {
  const xml = wrap(`<testcase name="x &lt;&amp;&gt; &quot;q&quot; &apos;s&apos; &#65;&#x42;" classname="a &amp; b" file="f" />`)
  expect(parseJunit(xml, 'f')).toEqual([{ key: key('f', 'a & b', `x <&> "q" 's' AB`), status: 'passed' }])
})

test('numbers duplicated names within a file in report order', () => {
  const xml = wrap(`
<testcase name="same" classname="" />
<testcase name="same" classname=""><failure message="x" /></testcase>
<testcase name="other" classname="" />
<testcase name="same" classname="" />`)
  expect(parseJunit(xml, 'f')).toEqual([
    { key: key('f', '', 'same'), status: 'passed' },
    { key: `${key('f', '', 'same')}#2`, status: 'failed' },
    { key: key('f', '', 'other'), status: 'passed' },
    { key: `${key('f', '', 'same')}#3`, status: 'passed' }
  ])
})

test('keys use the file passed in, not the report attribute', () => {
  const xml = wrap(`<testcase name="t" classname="" file="other.test.ts" />`)
  expect(parseJunit(xml, 'mine.test.ts')[0].key).toBe(key('mine.test.ts', '', 't'))
})

test('reads a report Bun wrote', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="2">
  <testsuite name="a.test.ts" file="a.test.ts" tests="2">
    <testcase name="bad" classname="inner &gt; outer" time="0.000106" file="a.test.ts" line="2" assertions="1">
      <failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;">AssertionError: expect(received).toBe(expected)&#10;&#10;Expected: 2&#10;Received: 1&#10;&#10;</failure>
    </testcase>
    <testcase name="td" classname="inner &gt; outer" time="0" file="a.test.ts" line="2" assertions="0">
      <skipped message="TODO" />
    </testcase>
  </testsuite>
</testsuites>`
  expect(parseJunit(xml, 'a.test.ts')).toEqual([
    { key: key('a.test.ts', 'inner > outer', 'bad'), status: 'failed' },
    { key: key('a.test.ts', 'inner > outer', 'td'), status: 'skipped' }
  ])
})
