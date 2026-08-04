import { describe, expect, it } from 'vitest'

import {
  addPanel,
  DEFAULT_DOCK_WIDTH,
  EMPTY_LAYOUT,
  MAX_DOCK_WIDTH,
  MIN_DOCK_WIDTH,
  MIN_PANEL_SIZE,
  movePanel,
  parseLayout,
  removePanel,
  resizeDock,
  resizePanel,
  togglePanel,
  type DockLayout,
  type DockPanelId,
} from './dock-model'

const ids = (layout: DockLayout): DockPanelId[] => layout.panels.map((panel) => panel.id)
const sizes = (layout: DockLayout): number[] => layout.panels.map((panel) => panel.size)
const total = (layout: DockLayout): number => sizes(layout).reduce((sum, size) => sum + size, 0)

describe('adding and removing', () => {
  it('gives a single panel the whole column', () => {
    const layout = addPanel(EMPTY_LAYOUT, 'graph')

    expect(ids(layout)).toEqual(['graph'])
    expect(sizes(layout)).toEqual([1])
  })

  it('splits evenly as panels arrive', () => {
    const layout = addPanel(addPanel(addPanel(EMPTY_LAYOUT, 'graph'), 'news'), 'terminal')

    expect(ids(layout)).toEqual(['graph', 'news', 'terminal'])
    for (const size of sizes(layout)) expect(size).toBeCloseTo(1 / 3, 10)
  })

  it('inserts where it was dropped', () => {
    const layout = addPanel(addPanel(EMPTY_LAYOUT, 'graph'), 'news', 0)

    expect(ids(layout)).toEqual(['news', 'graph'])
  })

  it('moves rather than duplicates a panel that is already docked', () => {
    const two = addPanel(addPanel(EMPTY_LAYOUT, 'graph'), 'news')
    const layout = addPanel(two, 'graph', 2)

    expect(ids(layout)).toEqual(['news', 'graph'])
  })

  it('gives the room back when a panel closes', () => {
    const three = addPanel(addPanel(addPanel(EMPTY_LAYOUT, 'graph'), 'news'), 'terminal')
    const layout = removePanel(three, 'news')

    expect(ids(layout)).toEqual(['graph', 'terminal'])
    expect(total(layout)).toBeCloseTo(1, 10)
  })

  /** Closing the last panel and opening another should give back your dock. */
  it('keeps the dock width when the last panel goes', () => {
    const wide = resizeDock(addPanel(EMPTY_LAYOUT, 'graph'), 0.45)

    expect(removePanel(wide, 'graph').width).toBe(0.45)
  })

  it('toggles a panel in and out', () => {
    const opened = togglePanel(EMPTY_LAYOUT, 'news')
    expect(ids(opened)).toEqual(['news'])
    expect(ids(togglePanel(opened, 'news'))).toEqual([])
  })

  /**
   * Sizes are floats and every structural change multiplies them. A layout that
   * sums to 0.9999 leaves a sliver at the bottom of the dock which grows every
   * time a panel is opened.
   */
  it('always sums to exactly one', () => {
    let layout = EMPTY_LAYOUT
    for (const id of ['graph', 'news', 'terminal'] as const) layout = addPanel(layout, id)

    layout = resizePanel(layout, 0, 0.12)
    layout = removePanel(layout, 'news')
    layout = addPanel(layout, 'news', 1)
    layout = removePanel(layout, 'graph')

    expect(total(layout)).toBeCloseTo(1, 10)
  })
})

describe('reordering', () => {
  const three = addPanel(addPanel(addPanel(EMPTY_LAYOUT, 'graph'), 'news'), 'terminal')

  it('moves a panel down without changing any size', () => {
    const layout = movePanel(three, 'graph', 2)

    expect(ids(layout)).toEqual(['news', 'graph', 'terminal'])
    expect(total(layout)).toBeCloseTo(1, 10)
  })

  it('moves a panel to the end', () => {
    expect(ids(movePanel(three, 'graph', 3))).toEqual(['news', 'terminal', 'graph'])
  })

  it('moves a panel to the front', () => {
    expect(ids(movePanel(three, 'terminal', 0))).toEqual(['terminal', 'graph', 'news'])
  })

  it('ignores a panel that is not docked', () => {
    const one = addPanel(EMPTY_LAYOUT, 'graph')
    expect(ids(movePanel(one, 'news', 0))).toEqual(['graph'])
  })
})

describe('dragging a divider', () => {
  const two = addPanel(addPanel(EMPTY_LAYOUT, 'graph'), 'news')

  it('takes from one neighbour and gives to the other', () => {
    const layout = resizePanel(two, 0, 0.2)

    expect(sizes(layout)[0]).toBeCloseTo(0.7, 10)
    expect(sizes(layout)[1]).toBeCloseTo(0.3, 10)
  })

  /**
   * The property that makes a dock feel solid. Scaling everything below would
   * mean grabbing one divider moves panels the pointer never touched.
   */
  it('leaves every other panel exactly where it was', () => {
    const three = addPanel(two, 'terminal')
    const before = sizes(three)[2]

    expect(sizes(resizePanel(three, 0, 0.1))[2]).toBe(before)
  })

  it('stops at the floor rather than collapsing a panel', () => {
    const layout = resizePanel(two, 0, 5)

    expect(sizes(layout)[1]).toBeCloseTo(MIN_PANEL_SIZE, 10)
    expect(total(layout)).toBeCloseTo(1, 10)
  })

  it('stops at the floor in the other direction too', () => {
    const layout = resizePanel(two, 0, -5)

    expect(sizes(layout)[0]).toBeCloseTo(MIN_PANEL_SIZE, 10)
  })

  it('does nothing at the last divider, which has no panel below it', () => {
    expect(sizes(resizePanel(two, 1, 0.2))).toEqual(sizes(two))
  })
})

describe('dock width', () => {
  it.each([
    ['too narrow', 0.01, MIN_DOCK_WIDTH],
    ['too wide', 0.99, MAX_DOCK_WIDTH],
    ['not a number', Number.NaN, MIN_DOCK_WIDTH],
  ])('clamps a width that is %s', (_name, given, expected) => {
    expect(resizeDock(EMPTY_LAYOUT, given).width).toBe(expected)
  })
})

describe('parseLayout', () => {
  it('round-trips a layout it wrote', () => {
    const layout = resizeDock(addPanel(addPanel(EMPTY_LAYOUT, 'graph'), 'news'), 0.33)

    expect(parseLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout)
  })

  it.each([
    ['null', null],
    ['a string', 'dock'],
    ['a number', 7],
  ])('gives an empty dock for %s', (_name, value) => {
    expect(parseLayout(value)).toEqual(EMPTY_LAYOUT)
  })

  /**
   * Everything below is a shape a previous release could have left behind. A
   * dock that opens empty is a shrug; one that throws is a blank page where the
   * notes used to be.
   */
  it('drops a panel it does not recognise', () => {
    const parsed = parseLayout({
      width: 0.3,
      panels: [{ id: 'graph', size: 0.5 }, { id: 'tasks' }],
    })

    expect(ids(parsed)).toEqual(['graph'])
    expect(total(parsed)).toBeCloseTo(1, 10)
  })

  it('drops a duplicate rather than mounting a panel twice', () => {
    const parsed = parseLayout({
      panels: [
        { id: 'news', size: 0.5 },
        { id: 'news', size: 0.5 },
      ],
    })

    expect(ids(parsed)).toEqual(['news'])
  })

  it('repairs sizes that do not sum to one', () => {
    const parsed = parseLayout({
      panels: [
        { id: 'graph', size: 3 },
        { id: 'news', size: 1 },
      ],
    })

    expect(total(parsed)).toBeCloseTo(1, 10)
    expect(sizes(parsed)[0]).toBeCloseTo(0.75, 10)
  })

  it('replaces a size that is not a usable number', () => {
    const parsed = parseLayout({ panels: [{ id: 'graph', size: Number.NaN }] })

    expect(Number.isFinite(sizes(parsed)[0])).toBe(true)
  })

  it('falls back to the default width when none was stored', () => {
    expect(parseLayout({ panels: [] }).width).toBe(DEFAULT_DOCK_WIDTH)
  })
})
