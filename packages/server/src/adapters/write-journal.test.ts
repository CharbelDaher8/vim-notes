import { assertNotePath as notePath } from '@vim-notes/core'
import { describe, expect, it } from 'vitest'

import { hashContent } from './content-hash'
import { WriteJournal } from './write-journal'

/** A clock the test drives, so nothing here waits on a real timer. */
function clock(start = 1_000) {
  let value = start
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms
    },
  }
}

describe('WriteJournal', () => {
  describe('content claims', () => {
    it('claims a change whose bytes match what the writer recorded', () => {
      const journal = new WriteJournal()
      journal.recordContent(notePath('note.md'), hashContent('v2'))

      expect(journal.claim(notePath('note.md'), hashContent('v2'))).toBe('api')
    })

    it('does not claim different content at the same path', () => {
      // The property the whole design rests on: nvim saving something else in
      // the same window is not the API's write, and must not be labelled 'api'
      // or the client would discard it.
      const journal = new WriteJournal()
      journal.recordContent(notePath('note.md'), hashContent('what the API wrote'))

      expect(journal.claim(notePath('note.md'), hashContent('what nvim wrote'))).toBeNull()
    })

    it('does not claim the same content at a different path', () => {
      const journal = new WriteJournal()
      journal.recordContent(notePath('a.md'), hashContent('same'))

      expect(journal.claim(notePath('b.md'), hashContent('same'))).toBeNull()
    })

    it('is consumed, so a second write of the same bytes is somebody else', () => {
      const journal = new WriteJournal()
      journal.recordContent(notePath('note.md'), hashContent('v2'))

      expect(journal.claim(notePath('note.md'), hashContent('v2'))).toBe('api')
      expect(journal.claim(notePath('note.md'), hashContent('v2'))).toBeNull()
    })

    it('records the origin it is given, not always api', () => {
      // So the terminal adapter can claim nvim's saves if it ever learns of
      // them, and the git adapter its own checkouts.
      const journal = new WriteJournal()
      journal.recordContent(notePath('note.md'), hashContent('v1'), 'terminal')

      expect(journal.claim(notePath('note.md'), hashContent('v1'))).toBe('terminal')
    })
  })

  describe('subtree claims', () => {
    it('claims the path itself and everything under it', () => {
      const journal = new WriteJournal()
      journal.recordSubtree(notePath('work'))

      expect(journal.claim(notePath('work'), null)).toBe('api')
      expect(journal.claim(notePath('work/a.md'), null)).toBe('api')
      expect(journal.claim(notePath('work/deep/b.md'), hashContent('x'))).toBe('api')
    })

    it('is not consumed, because one delete produces many events', () => {
      const journal = new WriteJournal()
      journal.recordSubtree(notePath('work'))

      expect(journal.claim(notePath('work/a.md'), null)).toBe('api')
      expect(journal.claim(notePath('work/b.md'), null)).toBe('api')
      expect(journal.claim(notePath('work/c.md'), null)).toBe('api')
    })

    it('does not claim a sibling that merely shares a prefix', () => {
      const journal = new WriteJournal()
      journal.recordSubtree(notePath('work'))

      expect(journal.claim(notePath('workspace/a.md'), null)).toBeNull()
    })

    it('is what covers deletions, which have no content to match on', () => {
      const journal = new WriteJournal()
      journal.recordContent(notePath('note.md'), hashContent('gone'))

      // A deletion arrives with a null hash, so only a subtree claim can cover
      // it -- the content entry above is no help.
      expect(journal.claim(notePath('note.md'), null)).toBeNull()

      journal.recordSubtree(notePath('note.md'))
      expect(journal.claim(notePath('note.md'), null)).toBe('api')
    })
  })

  describe('expiry', () => {
    it('stops claiming once the window has passed', () => {
      const time = clock()
      const journal = new WriteJournal({ ttlMs: 1_000, now: time.now })

      journal.recordContent(notePath('note.md'), hashContent('v1'))
      journal.recordSubtree(notePath('work'))

      time.advance(999)
      expect(journal.claim(notePath('note.md'), hashContent('v1'))).toBe('api')
      expect(journal.claim(notePath('work/a.md'), null)).toBe('api')

      time.advance(2)
      journal.recordContent(notePath('note.md'), hashContent('v1'))
      time.advance(1_001)

      expect(journal.claim(notePath('note.md'), hashContent('v1'))).toBeNull()
      expect(journal.claim(notePath('work/a.md'), null)).toBeNull()
    })

    it('does not accumulate entries for events that never arrive', () => {
      // Every write records a claim; if the watcher is not running, nothing ever
      // claims them. They have to fall out on their own.
      const time = clock()
      const journal = new WriteJournal({ ttlMs: 1_000, now: time.now })

      for (let i = 0; i < 100; i++) {
        journal.recordContent(notePath(`note-${i}.md`), hashContent(`v${i}`))
      }
      expect(journal.size).toBe(100)

      time.advance(1_001)
      expect(journal.size).toBe(0)
    })
  })

  it('returns null when nobody recorded anything', () => {
    const journal = new WriteJournal()

    expect(journal.claim(notePath('note.md'), hashContent('v1'))).toBeNull()
    expect(journal.claim(notePath('note.md'), null)).toBeNull()
  })
})
