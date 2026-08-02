import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { buildMarkdownDecorations } from './markdown-decorations'

interface Decorated {
  from: number
  to: number
  classes: string
}

function decorate(source: string): Decorated[] {
  const doc = Text.of(source.split('\n'))
  const set = buildMarkdownDecorations(doc, [{ from: 0, to: doc.length }])
  const found: Decorated[] = []

  set.between(0, doc.length, (from, to, value) => {
    found.push({ from, to, classes: String(value.spec.class ?? '') })
  })

  return found
}

/** The classes applied to line N, so tests can talk about lines not offsets. */
function lineClasses(source: string, lineNumber: number): string[] {
  const doc = Text.of(source.split('\n'))
  const line = doc.line(lineNumber)

  return decorate(source)
    .filter((entry) => entry.from === line.from && entry.to === line.from)
    .flatMap((entry) => entry.classes.split(' '))
}

/** The substrings covered by a given mark class. */
function marked(source: string, className: string): string[] {
  return decorate(source)
    .filter((entry) => entry.classes.split(' ').includes(className) && entry.to > entry.from)
    .map((entry) => source.slice(entry.from, entry.to))
}

describe('headings', () => {
  it('styles each level and dims the hashes', () => {
    expect(lineClasses('# one', 1)).toContain('cm-md-h1')
    expect(lineClasses('### three', 1)).toContain('cm-md-h3')
    expect(lineClasses('###### six', 1)).toContain('cm-md-h6')
    expect(marked('## two', 'cm-md-punct')).toEqual(['## '])
  })

  it('ignores a hash that is not a heading', () => {
    expect(lineClasses('#nospace', 1)).not.toContain('cm-md-h1')
    expect(lineClasses('a # mid-line', 1)).not.toContain('cm-md-h1')
  })
})

describe('code fences', () => {
  const source = ['before', '```ts', 'const x = **not bold**', '```', 'after **bold**'].join('\n')

  it('marks the fence lines and the lines between them', () => {
    expect(lineClasses(source, 2)).toContain('cm-md-fence')
    expect(lineClasses(source, 3)).toContain('cm-md-code-line')
    expect(lineClasses(source, 4)).toContain('cm-md-fence')
  })

  it('does not style markdown inside a fence', () => {
    expect(marked(source, 'cm-md-strong')).toEqual(['bold'])
  })

  it('carries fence state from the top even when the fence is off screen', () => {
    const doc = Text.of(source.split('\n'))
    const insideOnly = [{ from: doc.line(3).from, to: doc.line(3).to }]
    const set = buildMarkdownDecorations(doc, insideOnly)

    const classes: string[] = []
    set.between(0, doc.length, (_from, _to, value) => {
      classes.push(String(value.spec.class ?? ''))
    })

    expect(classes).toEqual(['cm-md-code-line'])
  })

  it('only closes on a matching fence character', () => {
    const mixed = ['```', 'still code', '~~~', 'also code'].join('\n')
    expect(lineClasses(mixed, 4)).toContain('cm-md-code-line')
  })
})

describe('inline marks', () => {
  it('finds bold, italic, strikethrough and code', () => {
    expect(marked('**b** and *i* and ~~s~~ and `c`', 'cm-md-strong')).toEqual(['b'])
    expect(marked('**b** and *i* and ~~s~~ and `c`', 'cm-md-em')).toEqual(['i'])
    expect(marked('**b** and *i* and ~~s~~ and `c`', 'cm-md-strike')).toEqual(['s'])
    expect(marked('**b** and *i* and ~~s~~ and `c`', 'cm-md-code')).toEqual(['c'])
  })

  it('does not read the inner asterisks of bold as italics', () => {
    expect(marked('**bold**', 'cm-md-em')).toEqual([])
  })

  it('leaves markdown inside a code span alone', () => {
    expect(marked('`**not bold**`', 'cm-md-strong')).toEqual([])
    expect(marked('`**not bold**`', 'cm-md-code')).toEqual(['**not bold**'])
  })

  it('separates a link label, its url and the punctuation around both', () => {
    const source = 'see [the docs](https://example.com) now'
    expect(marked(source, 'cm-md-link')).toEqual(['the docs'])
    expect(marked(source, 'cm-md-url')).toEqual(['https://example.com'])
    expect(marked(source, 'cm-md-punct')).toEqual(['[', '](', ')'])
  })

  it('marks a bare url', () => {
    expect(marked('go to https://example.com today', 'cm-md-link')).toEqual(['https://example.com'])
  })
})

describe('lists and quotes', () => {
  it('marks the bullet without the text', () => {
    expect(marked('- an item', 'cm-md-marker')).toEqual(['-'])
    expect(marked('1. an item', 'cm-md-marker')).toEqual(['1.'])
  })

  it('marks a checkbox and dims a completed task', () => {
    expect(marked('- [x] done', 'cm-md-marker')).toEqual(['- ', '[x]'])
    expect(lineClasses('- [x] done', 1)).toContain('cm-md-task-done')
    expect(lineClasses('- [ ] todo', 1)).not.toContain('cm-md-task-done')
  })

  it('marks the quote character at its real offset, not after the indent', () => {
    expect(marked('  > indented quote', 'cm-md-punct')).toEqual(['>'])
    expect(lineClasses('  > indented quote', 1)).toContain('cm-md-quote')
  })

  it('recognises a horizontal rule', () => {
    expect(lineClasses('---', 1)).toContain('cm-md-rule')
    expect(lineClasses('***', 1)).toContain('cm-md-rule')
  })
})

describe('robustness', () => {
  it('produces nothing for blank lines', () => {
    expect(decorate('\n\n   \n')).toEqual([])
  })

  it('never emits an empty mark, which CodeMirror rejects', () => {
    // A zero-length range is only legal for a line decoration, which always
    // sits at offset 0 of its line. Anything else empty is a bug in a regex
    // that matched but captured nothing -- `[](url)` is the usual culprit.
    for (const source of ['[](url)', '****', '``', '- ', '> ', '#### ', '~~~~', '*  *']) {
      const doc = Text.of(source.split('\n'))
      const lineStarts = new Set(Array.from({ length: doc.lines }, (_, i) => doc.line(i + 1).from))

      for (const entry of decorate(source)) {
        if (entry.to > entry.from) continue
        expect(lineStarts.has(entry.from), `empty mark in ${JSON.stringify(source)}`).toBe(true)
      }
    }
  })

  it('emits ranges in ascending order, as Decoration.set requires', () => {
    const source = '# head\n**b** [l](u) `c`\n- [ ] task\n> quote'
    const found = decorate(source)

    for (let i = 1; i < found.length; i += 1) {
      expect(found[i]?.from).toBeGreaterThanOrEqual(found[i - 1]?.from ?? 0)
    }
  })
})
