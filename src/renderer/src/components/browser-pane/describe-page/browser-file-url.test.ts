import { describe, expect, it } from 'vitest'
import { getLocalBrowserHtmlFile } from './browser-file-url'

describe('browser file url', () => {
  it('recognizes local HTML URLs across path flavors', () => {
    expect(getLocalBrowserHtmlFile('file:///tmp/Design%20Review.html')).toEqual({
      fileName: 'Design Review.html',
      filePath: '/tmp/Design Review.html'
    })
    expect(getLocalBrowserHtmlFile('file:///C:/repo/report.HTM')).toEqual({
      fileName: 'report.HTM',
      filePath: 'C:\\repo\\report.HTM'
    })
    expect(getLocalBrowserHtmlFile('file://server/share/report.html')).toEqual({
      fileName: 'report.html',
      filePath: '\\\\server\\share\\report.html'
    })
    expect(getLocalBrowserHtmlFile('https://example.com/report.html')).toBeNull()
    expect(getLocalBrowserHtmlFile('file:///tmp/report.md')).toBeNull()
  })
})
