import { describe, expect, it } from 'vitest'
import {
  collectChartSources,
  collectLocalImageSources,
  endsInOpenFence,
  openFenceAtEnd
} from './fences'

describe('openFenceAtEnd', () => {
  it('finds a fence that has no closing line', () => {
    expect(openFenceAtEnd('Here it is:\n\n```ts\nconst a = 1\nconst b =')).toMatchObject({
      language: 'ts',
      code: 'const a = 1\nconst b ='
    })
  })

  it('is null when the text has no fence or the fence is closed', () => {
    expect(openFenceAtEnd('plain text')).toBeNull()
    expect(openFenceAtEnd('```ts\nconst a = 1\n```')).toBeNull()
    expect(openFenceAtEnd('```ts\nconst a = 1\n```\n\nafter')).toBeNull()
  })

  it.each([
    ['a blockquote', '> ```ts\n> const a = 1'],
    ['a list item', '- item\n  ```ts\n  const a = 1'],
    ['a quote inside a list item', '- > ```ts\n  > const a = 1'],
    ['a list item inside a quote', '> - ```ts\n>   const a = 1'],
    ['nested quotes', '> > ```ts\n> > const a = 1'],
    ['nested list items', '- - ```ts\n    const a = 1'],
    ['a deep mix', '1. > - > ```ts\n   >   > const a = 1']
  ])('finds an open fence inside %s', (_label, text) => {
    expect(openFenceAtEnd(text)).toMatchObject({ language: 'ts', code: 'const a = 1' })
    expect(endsInOpenFence(text)).toBe(true)
  })

  it('is null for a closed fence inside nested containers', () => {
    expect(openFenceAtEnd('- > ```ts\n  > const a = 1\n  > ```\n\nafter')).toBeNull()
  })

  it('singles out the open fence when an earlier closed one has the same language and code', () => {
    const text = '```ts\nconst a = 1\n```\n\nand again\n\n```ts\nconst a = 1'
    const open = openFenceAtEnd(text)
    expect(open).not.toBeNull()
    expect(open?.code).toBe('const a = 1')
  })

  it('differs from a closed fence of the same length by its extent', () => {
    const closed = '```ts\nx\n```'
    const open = openFenceAtEnd(`${closed}\n\`\`\`ts\n123456`)
    expect(open).not.toBeNull()
    expect(open?.code).toBe('123456')
  })
})

describe('collectChartSources', () => {
  it('collects finished csv and tsv fences that carry a title', () => {
    const text = [
      '```csv title=pts',
      'day,ms',
      'mon,3',
      '```',
      '',
      '```tsv title="two words"',
      'a\tb',
      '```',
      '',
      '```csv',
      'untitled,1',
      '```'
    ].join('\n')
    expect(collectChartSources(text)).toEqual({
      pts: { language: 'csv', code: 'day,ms\nmon,3' },
      'two words': { language: 'tsv', code: 'a\tb' }
    })
  })

  it('ignores a fence that is still open and fences of other languages', () => {
    expect(collectChartSources('```csv title=t\na,b')).toEqual({})
    expect(collectChartSources('```json title=t\n{}\n```')).toEqual({})
  })

  it('finds fences inside quotes and list items', () => {
    expect(collectChartSources('> ```csv title=q\n> a,b\n> ```')).toEqual({
      q: { language: 'csv', code: 'a,b' }
    })
    expect(collectChartSources('- ```csv title=l\n  a,b\n  ```')).toEqual({
      l: { language: 'csv', code: 'a,b' }
    })
  })
})

describe('collectLocalImageSources', () => {
  it('reads inline destinations as the parser does', () => {
    const text =
      '![a](docs/shot(1).png) ![b](<my/b.png> "t") ![c](c.png (title)) ![u](docs/a\\_b.png)'
    expect(collectLocalImageSources(text).sort()).toEqual([
      'c.png',
      'docs/a_b.png',
      'docs/shot(1).png',
      'my/b.png'
    ])
  })

  it('resolves reference-style images through their definitions', () => {
    const text =
      '![full][s] and ![s2][] and ![S3]\n\n![none][nope]\n\n[s]: shots/a.png "title"\n[s2]: <shots/b.png>\n[s3]: shots/c.png'
    expect(collectLocalImageSources(text).sort()).toEqual([
      'shots/a.png',
      'shots/b.png',
      'shots/c.png'
    ])
  })

  it('collects a definition whose destination is on the next line', () => {
    expect(collectLocalImageSources('![s][s]\n\n[s]:\n  docs/shot.png')).toEqual(['docs/shot.png'])
  })

  it('never reads images inside code spans, fences or indented code', () => {
    const text =
      '![real](real.png) and `![span](span.png)`\n\n```md\n![fenced](fenced.png)\n```\n\n    ![indented](indented.png)'
    expect(collectLocalImageSources(text)).toEqual(['real.png'])
  })

  it('skips remote, protocol-relative and data sources', () => {
    const text =
      '![a](https://x.io/a.png) ![b](//cdn.io/b.png) ![c](data:image/png;base64,AAAA) ![d](local.png)'
    expect(collectLocalImageSources(text)).toEqual(['local.png'])
  })

  it('returns nothing for text with no image syntax', () => {
    expect(collectLocalImageSources('just text')).toEqual([])
  })
})
