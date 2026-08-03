import { describe, expect, it } from 'vitest'

import { parsePins } from './pin-storage'

describe('parsePins', () => {
  it('reads what writePins writes', () => {
    expect(parsePins({ 'notes/a.md': [10, -20] })).toEqual(
      new Map([['notes/a.md', { x: 10, y: -20 }]]),
    )
  })

  /*
   * Everything below is a shape a *previous release* of this app could have
   * left in localStorage, which is the one place in the client where that is a
   * real event rather than a hypothetical. None of them may throw, because the
   * caller is a module-level read on the path that renders the graph.
   */

  it.each([
    ['not an object', 42],
    ['null', null],
    ['an array', [1, 2]],
  ])('gives up quietly on %s', (_name, value) => {
    expect(parsePins(value).size).toBe(0)
  })

  it.each([
    ['a point that is not a pair', { a: [1] }],
    ['a point that is not an array', { a: { x: 1, y: 2 } }],
    ['a coordinate that is not a number', { a: ['1', 2] }],
  ])('drops %s', (_name, value) => {
    expect(parsePins(value).size).toBe(0)
  })

  /**
   * The one that actually matters. NaN survives every comparison and reaches
   * the SVG transform intact, where it blanks the entire graph and reports
   * nothing -- so it has to be caught at the door rather than downstream.
   */
  it('drops a coordinate that is not finite', () => {
    expect(parsePins({ a: [Number.NaN, 0], b: [0, Number.POSITIVE_INFINITY] }).size).toBe(0)
  })

  it('keeps the good entries alongside a bad one', () => {
    const pins = parsePins({ good: [1, 2], bad: 'nonsense' })

    expect([...pins.keys()]).toEqual(['good'])
  })

  it('stops reading long before storage could fill up', () => {
    const many = Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [`n${i}`, [i, i]] as const),
    )

    expect(parsePins(many).size).toBe(250)
  })
})
