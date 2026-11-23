export type TextSegment = { text: string; href?: string }

const candidates =
  /(?<![a-z\d_+./@%-])(?:[a-z][a-z\d+.-]*:\/\/|(?:javascript|data|vbscript):)[^\s<>"'，。！？；：、（）【】《》「」『』“”‘’〈〉…]+/gi

function trimUrlEnd(value: string) {
  // Keep balanced brackets in paths and IPv6 addresses; leave surrounding
  // punctuation with the original text.
  let parentheses = 0
  let brackets = 0
  for (const character of value) {
    if (character === '(') parentheses++
    if (character === ')') parentheses--
    if (character === '[') brackets++
    if (character === ']') brackets--
  }
  let end = value.length
  while (end > 0) {
    const last = value[end - 1]!
    if (last === ')' && parentheses < 0) parentheses++
    else if (last === ']' && brackets < 0) brackets++
    else if (!/[.,!?;:]/.test(last)) break
    end--
  }
  return value.slice(0, end)
}

export function linkifyText(value: string): TextSegment[] {
  const segments: TextSegment[] = []
  let offset = 0
  for (const match of value.matchAll(candidates)) {
    const text = trimUrlEnd(match[0])
    if (!/^https?:\/\/[^/\\]/i.test(text)) continue
    let url: URL
    try {
      url = new URL(text)
    } catch {
      continue
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue
    if (offset < match.index)
      segments.push({ text: value.slice(offset, match.index) })
    segments.push({ text, href: url.href })
    offset = match.index + text.length
  }
  if (offset < value.length) segments.push({ text: value.slice(offset) })
  return segments
}
