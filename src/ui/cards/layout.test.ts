import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TabId } from '../../App'
import {
  CARDS,
  EMPTY_STORE,
  ROW_H,
  STORE_KEY,
  dropIndex,
  mergeOrder,
  moveAt,
  policyOf,
  readStore,
  resolveHidden,
  resolveSpec,
  shiftFor,
  spliceOrder,
  writeStore,
} from './layout'
import type { CardId, CardSpec, ResolvedCard, Stored } from './layout'

/**
 * This file runs under the NODE environment (vitest sends `*.test.ts` to node
 * and only `*.test.tsx` to jsdom), which is the whole point: the drag arithmetic
 * and the reconciliation are the parts that a DOM test cannot check, because
 * jsdom reports every rect as zeros. The price is that there is no
 * `localStorage` here at all, so the storage tests install their own.
 */
function fakeStorage(init: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(init))
  const store = {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, v),
  }
  return store as unknown as Storage
}

const original = Reflect.getOwnPropertyDescriptor(globalThis, 'localStorage')

function install(storage: Storage): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}

/** Put a blob in the store the way a previous release would have left it. */
const seed = (blob: unknown): void => install(fakeStorage({ [STORE_KEY]: JSON.stringify(blob) }))

describe('mergeOrder', () => {
  it('returns the code order untouched when this device has stored nothing', () => {
    expect(mergeOrder(['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c'])
  })

  it('lands a card shipped in a later release beside the sibling its author put it next to', () => {
    // The user has already dragged c to the top and finished arranging. A new
    // card declared between b and c must not be exiled to the bottom of that
    // arrangement — it belongs after b, wherever b now is.
    expect(mergeOrder(['a', 'b', 'NEW', 'c'], ['c', 'a', 'b'])).toEqual(['c', 'a', 'b', 'NEW'])
  })

  it('anchors a new FIRST card at the top rather than after nothing', () => {
    // A card declared first has no earlier sibling to anchor to, so the fallback
    // has to be index 0. Appending instead would put the new hero card last.
    expect(mergeOrder(['NEW', 'a', 'b'], ['b', 'a'])).toEqual(['NEW', 'b', 'a'])
  })

  it('keeps an id the code does not declare this render, at exactly the index the user put it', () => {
    // Overview's Data quality card renders only when there are issues to report.
    // Between two imports it is simply absent, and the merge must not treat that
    // as a retirement: the user's explicit placement has to survive the round
    // trip so the card comes back where they left it.
    const stored = ['portfolio-value', 'key-figures', 'data-quality', 'allocation-holding']
    const withoutIt = mergeOrder(['portfolio-value', 'key-figures', 'allocation-holding'], stored)
    const withIt = mergeOrder(
      ['portfolio-value', 'key-figures', 'allocation-holding', 'data-quality'],
      stored,
    )
    expect(withoutIt.indexOf('data-quality')).toBe(2)
    expect(withIt.indexOf('data-quality')).toBe(2)
    expect(withoutIt).toEqual(withIt)
  })

  it('never emits a duplicate, whatever a hand-edited store said', () => {
    // Two rows with the same id in the arrange sheet would give React duplicate
    // keys and the user two eyes for one card.
    const out = mergeOrder(['a', 'b'], ['a', 'b', 'a'])
    expect(out).toEqual(['a', 'b'])
    expect(new Set(out).size).toBe(out.length)
  })

  it('is idempotent, so a render that re-merges its own output cannot drift', () => {
    const declared = ['a', 'b', 'NEW', 'c', 'ALSO-NEW']
    const once = mergeOrder(declared, ['c', 'a', 'b', 'offstage'])
    expect(mergeOrder(declared, once)).toEqual(once)
  })
})

describe('spliceOrder', () => {
  it('refills only the visible slots, leaving an offstage card between its stored neighbours', () => {
    // Income's FX warning renders only when a payment could not be converted.
    // Reordering the tab while it is absent must not migrate it away from the
    // tiles it explains.
    expect(spliceOrder(['tiles', 'fx-warning', 'chart'], ['chart', 'tiles'])).toEqual([
      'chart',
      'fx-warning',
      'tiles',
    ])
  })

  it('changes nothing when `next` is not a permutation of the visible projection', () => {
    // A caller bug. Inventing a position for the difference would write a
    // corrupt order to disk; refusing costs the user one lost drag.
    expect(spliceOrder(['a', 'b', 'c'], ['a', 'unknown'])).toEqual(['a', 'b', 'c'])
    expect(spliceOrder(['a', 'b', 'c'], ['a', 'a', 'b'])).toEqual(['a', 'b', 'c'])
  })

  it('round-trips a drag of a card the store has never seen', () => {
    // The case that matters: NEW exists only in the merged order, not in the
    // stored one. If the splice keyed off the stored ids instead of the merged
    // ones, the very first drag of a freshly shipped card would silently do
    // nothing, forever.
    const full = mergeOrder(['a', 'b', 'NEW'], ['a', 'b'])
    expect(spliceOrder(full, ['NEW', 'a', 'b'])).toEqual(['NEW', 'a', 'b'])
  })
})

describe('dropIndex', () => {
  it('flips at exactly half a row of travel, and flips exactly once', () => {
    // Measured against the row's original static slot, so there is one boundary
    // and no oscillation when the lifted row overlaps the neighbour it passed.
    expect(dropIndex(2, 27, 6)).toBe(2)
    expect(dropIndex(2, ROW_H / 2, 6)).toBe(3)
    expect(dropIndex(2, 29, 6)).toBe(3)
    expect(dropIndex(2, 85, 6)).toBe(4)
    // Symmetric upwards.
    expect(dropIndex(2, -27, 6)).toBe(2)
    expect(dropIndex(2, -29, 6)).toBe(1)
    expect(dropIndex(2, -85, 6)).toBe(0)
  })

  it('clamps to both ends, so a flung row lands on a real slot', () => {
    expect(dropIndex(0, -1000, 5)).toBe(0)
    expect(dropIndex(4, 1000, 5)).toBe(4)
    expect(dropIndex(0, 0, 1)).toBe(0)
  })
})

describe('shiftFor', () => {
  /** [row, from, to, expected pitch] */
  const cases: Array<[number, number, number, number]> = [
    // Dragging row 1 down to row 3: only 2 and 3 step up, by one pitch each.
    [0, 1, 3, 0],
    [1, 1, 3, 0],
    [2, 1, 3, -ROW_H],
    [3, 1, 3, -ROW_H],
    [4, 1, 3, 0],
    // Dragging row 3 up to row 1: only 1 and 2 step down.
    [0, 3, 1, 0],
    [1, 3, 1, ROW_H],
    [2, 3, 1, ROW_H],
    [3, 3, 1, 0],
    [4, 3, 1, 0],
    // Held over its own slot: nothing moves.
    [0, 2, 2, 0],
    [2, 2, 2, 0],
    [3, 2, 2, 0],
  ]

  it.each(cases)('row %i for a %i -> %i drag shifts by %i', (i, from, to, expected) => {
    expect(shiftFor(i, from, to)).toBe(expected)
  })

  it('never shifts a row by more than one pitch, over every pair in a 7-row sheet', () => {
    for (let from = 0; from < 7; from++) {
      for (let to = 0; to < 7; to++) {
        for (let i = 0; i < 7; i++) {
          expect(Math.abs(shiftFor(i, from, to))).toBeLessThanOrEqual(ROW_H)
        }
      }
    }
  })
})

/**
 * A seeded LCG rather than Math.random: a property test that cannot be
 * reproduced from its failure message is a flake, not a test.
 */
function lcg(seedValue: number): () => number {
  let s = seedValue >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

describe('moveAt', () => {
  const ORDER = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

  it('is a permutation for ~100 pseudo-random moves, including out-of-range drops', () => {
    // Losing or duplicating an id here would lose a card from the tab, so the
    // invariant worth asserting is the multiset, not any particular position.
    const rand = lcg(0x9e3779b9)
    const sorted = [...ORDER].sort().join(',')
    for (let n = 0; n < 100; n++) {
      const from = Math.floor(rand() * ORDER.length)
      // Deliberately overshoots both ends: `to` comes from clamped drag
      // geometry, but moveAt has to be total on its own.
      const to = Math.floor(rand() * (ORDER.length + 5)) - 2
      const out = moveAt(ORDER, from, to)
      expect(out.length, `from=${from} to=${to}`).toBe(ORDER.length)
      expect([...out].sort().join(','), `from=${from} to=${to}`).toBe(sorted)
    }
  })

  it('is the identity when a card is dropped on its own index', () => {
    for (let i = 0; i < ORDER.length; i++) {
      expect(moveAt(ORDER, i, i)).toEqual(ORDER)
    }
  })

  it('is a no-op for an index that is not in the array', () => {
    expect(moveAt(ORDER, -1, 0)).toEqual(ORDER)
    expect(moveAt(ORDER, ORDER.length, 0)).toEqual(ORDER)
    expect(moveAt([], 0, 0)).toEqual([])
  })
})

describe('readStore', () => {
  afterEach(() => {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
    else Object.defineProperty(globalThis, 'localStorage', original)
  })

  it('returns the default layout for a half-written blob rather than throwing during render', () => {
    install(fakeStorage({ [STORE_KEY]: '{oops' }))
    expect(readStore()).toEqual(EMPTY_STORE)
  })

  it('discards a blob from another schema version instead of half-reading it', () => {
    // An installed older build can still be running when a newer one ships; a
    // wrong arrangement is a two-tap fix, a throw is a white screen.
    seed({ v: 2, tabs: { overview: { order: ['key-figures'], collapsed: [], hidden: {} } } })
    expect(readStore()).toEqual(EMPTY_STORE)
  })

  it('discards a tab entry of the wrong shape, keeping the tabs that parsed', () => {
    seed({
      v: 1,
      tabs: { overview: 7, income: { order: ['income-tiles'], collapsed: [], hidden: {} } },
    })
    const out = readStore()
    expect(out.tabs.overview).toBeUndefined()
    expect(out.tabs.income?.order).toEqual(['income-tiles'])
  })

  it('caps the remembered id arrays so a hand-edited blob cannot become a rendering cost', () => {
    const many = Array.from({ length: 200 }, (_, i) => `id-${i}`)
    seed({ v: 1, tabs: { overview: { order: many, collapsed: many, hidden: {} } } })
    const tab = readStore().tabs.overview
    expect(tab?.order).toHaveLength(64)
    expect(tab?.collapsed).toHaveLength(64)
    expect(tab?.order[0]).toBe('id-0')
  })

  it('drops a non-string signature from the hidden map', () => {
    // Signatures are compared with ===, so a number here would mean a dismissal
    // that can never be matched and never expires.
    seed({
      v: 1,
      tabs: { overview: { order: [], collapsed: [], hidden: { 'key-figures': 'sig', 'data-quality': 3 } } },
    })
    expect(readStore().tabs.overview?.hidden).toEqual({ 'key-figures': 'sig' })
  })

  it('survives a getItem that throws — Safari in private mode does exactly that', () => {
    install({
      ...fakeStorage(),
      getItem: () => {
        throw new DOMException('SecurityError')
      },
    } as unknown as Storage)
    expect(readStore()).toEqual(EMPTY_STORE)
  })

  it('round-trips what writeStore wrote', () => {
    install(fakeStorage())
    const next: Stored = {
      v: 1,
      tabs: { holdings: { order: ['positions', 'holdings-kpis'], collapsed: ['positions'], hidden: {} } },
    }
    writeStore(next)
    expect(readStore()).toEqual(next)
  })
})

describe('writeStore', () => {
  afterEach(() => {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
    else Object.defineProperty(globalThis, 'localStorage', original)
  })

  it('does not throw when setItem does — the arrangement still works for this session', () => {
    install({
      ...fakeStorage(),
      setItem: () => {
        throw new DOMException('QuotaExceededError')
      },
    } as unknown as Storage)
    expect(() => writeStore(EMPTY_STORE)).not.toThrow()
  })
})

describe('resolveHidden', () => {
  const spec = (id: CardId, signature?: string): ResolvedCard => {
    const s: CardSpec = { id, render: () => null }
    return resolveSpec(signature === undefined ? s : { ...s, signature })
  }

  it('shows a hidden card anyway when policy says it is not hideable, without forgetting the wish', () => {
    // The FX warning says every figure on the screen is understated, so policy
    // wins over storage — but only at render time. Mutating the stored map here
    // would throw away an intent that becomes valid again the moment the card
    // goes back to being optional.
    const stored = { 'income-fx-warning': '', 'income-tiles': '' }
    const hidden = resolveHidden(stored, [spec('income-fx-warning'), spec('income-tiles')])
    expect([...hidden]).toEqual(['income-tiles'])
    expect(stored).toEqual({ 'income-fx-warning': '', 'income-tiles': '' })
  })

  it('re-shows a dismissed card once its signature changes, and leaves it hidden while it does not', () => {
    const stored = { 'income-irregular-note': 'sig-a' }
    expect([...resolveHidden(stored, [spec('income-irregular-note', 'sig-a')])]).toEqual([
      'income-irregular-note',
    ])
    // New specials to report: this is a different note, not the one dismissed.
    expect([...resolveHidden(stored, [spec('income-irregular-note', 'sig-b')])]).toEqual([])
  })

  it('keeps a dismissal for a card the code does not declare this render', () => {
    // Data quality is absent until the next import turns up an issue. Dropping
    // the dismissal would make it reappear then, which is the opposite of what
    // dismissing it asked for.
    const hidden = resolveHidden({ 'data-quality': 'sig' }, [spec('key-figures')])
    expect(hidden.has('data-quality')).toBe(true)
  })
})

/**
 * The policy table is the design's safety net, and every one of these is an
 * invariant the arrange sheet relies on but cannot check for itself.
 */
describe('CARDS policy invariants', () => {
  const ids = Object.keys(CARDS) as CardId[]
  // Written out rather than imported from App.tsx, which would drag React,
  // Dexie and every tab into a node test. `satisfies` keeps it honest: adding a
  // sixth tab without listing it here is a compile error.
  const TAB_IDS = Object.keys({
    overview: true,
    income: true,
    forecast: true,
    holdings: true,
    data: true,
  } satisfies Record<TabId, true>) as TabId[]

  it.each(TAB_IDS)('tab %s ships at least one card that cannot be hidden at all', (tab) => {
    // "I hid everything and now the tab is blank" has to be structurally
    // unreachable, not merely something the store happens not to remember.
    const anchors = ids.filter((id) => policyOf(id).tab === tab && policyOf(id).hideable !== true)
    expect(anchors.length).toBeGreaterThanOrEqual(1)
  })

  it.each(TAB_IDS)('tab %s has no two cards with the same label', (tab) => {
    // The sheet lists cards by label alone, so a duplicate is two identical
    // rows with no way to tell which eye belongs to which card.
    const labels = ids.filter((id) => policyOf(id).tab === tab).map((id) => policyOf(id).label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('assigns every card to one of the five real tabs', () => {
    const strays = ids.filter((id) => !TAB_IDS.includes(policyOf(id).tab))
    expect(strays).toEqual([])
  })

  it('never sets keepMounted on a card that cannot collapse', () => {
    // keepMounted only decides how a COLLAPSED body is hidden. On a card that
    // can never collapse it is dead flag, and reads as a promise the renderer
    // does not keep.
    const bad = ids.filter((id) => policyOf(id).keepMounted === true && policyOf(id).collapsible !== true)
    expect(bad).toEqual([])
  })
})

// Guard the fixture itself: an `install` that silently failed would make every
// storage test above pass against the real (absent) localStorage.
describe('the localStorage shim', () => {
  beforeEach(() => install(fakeStorage()))
  afterEach(() => {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'localStorage')
    else Object.defineProperty(globalThis, 'localStorage', original)
  })

  it('is actually in place, and is torn down again afterwards', () => {
    localStorage.setItem('probe', '1')
    expect(localStorage.getItem('probe')).toBe('1')
  })
})
