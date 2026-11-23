import { describe, expect, test } from 'vitest'
import { linkifyText } from './text-links'

describe('product description links', () => {
  test('keeps plain text, markup and empty descriptions as text', () => {
    const text = '商品介绍\n<img src=x>  www.example.test'
    expect(linkifyText(text)).toEqual([{ text }])
    expect(linkifyText('')).toEqual([])
  })

  test('identifies an absolute HTTP URL without changing the display text', () => {
    const text = 'http://example.test'
    expect(linkifyText(text)).toEqual([{ text, href: text + '/' }])
  })

  test('keeps queries, fragments, newlines and consecutive links', () => {
    const first = 'https://example.test/manual?q=a%20b&format=pdf#guide'
    const second = 'HTTPS://example.test/help'
    const text = '使用说明：\n' + first + '\n\n更多：' + second + '。'
    const segments = linkifyText(text)
    expect(segments).toEqual([
      { text: '使用说明：\n' },
      { text: first, href: first },
      { text: '\n\n更多：' },
      { text: second, href: 'https://example.test/help' },
      { text: '。' },
    ])
    expect(segments.map((segment) => segment.text).join('')).toBe(text)
  })

  test('keeps Chinese punctuation and enclosing ASCII brackets outside links', () => {
    expect(
      linkifyText(
        '打开（https://example.test/a），或 (https://example.test/foo(bar)).',
      ),
    ).toEqual([
      { text: '打开（' },
      { text: 'https://example.test/a', href: 'https://example.test/a' },
      { text: '），或 (' },
      {
        text: 'https://example.test/foo(bar)',
        href: 'https://example.test/foo(bar)',
      },
      { text: ').' },
    ])
  })

  test('preserves valid brackets in an IPv6 host', () => {
    const url = 'http://[::1]:2345'
    expect(linkifyText(url + '！')).toEqual([
      { text: url, href: url + '/' },
      { text: '！' },
    ])
  })

  test('does not create links from non-HTTP schemes or incomplete URL tokens', () => {
    const text =
      'javascript:alert(1) data:text/plain,https://example.test ' +
      'vbscript:msgbox(1) ftp://example.test //example.test ' +
      'abchttps://example.test https:///invalid https://?invalid'
    expect(linkifyText(text)).toEqual([{ text }])
  })
})
