import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { ROW_H, dropIndex, moveAt, shiftFor } from './layout'
import type { CardLayout, CardRow } from './useCardLayout'
import { EyeIcon, EyeOffIcon, GripIcon } from './icons'

/**
 * Arrange cards.
 *
 * Portaled to document.body by CardStack, so nothing here is a descendant of
 * `main > div` in any state and no snap selector can ever see it. Lazy-loaded,
 * so a user who never taps Arrange never downloads the drag engine — and
 * primitives.tsx, which every tab imports, reaches none of this.
 *
 * The drag is hand-rolled Pointer Events on a grip. Two facts decide its shape:
 *
 *   - `touch-action: none` on the grip is what stops the page panning under the
 *     drag, and every other non-scrolling box in the sheet carries it too, so a
 *     gesture starting on the sheet's chrome cannot pan the document behind it
 *     either. The list is the one exception: it has to be able to pan itself. `preventDefault()` in pointermove does not:
 *     whether the browser may start a compositor pan is decided from
 *     touch-action at gesture start, and once it has started one it fires
 *     pointercancel at you and the drag is dead on move #1. The payments matrix
 *     records the same lesson measured on the other axis. There is no
 *     non-passive touchmove listener anywhere in this file.
 *
 *   - touch-action does NOT stop useTabSwipe, which is passive, reads raw
 *     clientX/clientY, and does not care whether the page moved. A 100px-x,
 *     50px-y drift during a reorder passes all three of its gates.
 *     `data-no-swipe` on the root, matched by that hook's bail selector, is what
 *     does stop it.
 *
 * The move buttons in the footer are not a fallback nobody uses. They are the
 * only mechanism available to switch access, voice control and touch
 * screen-reader users, who navigate by virtual cursor and cannot perform a drag
 * at all.
 */

const FOCUS =
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface'

interface Session {
  pointerId: number
  /** The card being dragged. Indices are a view of a list that can change under
   *  the finger; the id is what the user grabbed. */
  id: string
  from: number
  to: number
  y0: number
  /** The list's scrollTop at lift, so auto-scroll counts toward the travel. */
  top0: number
  rows: HTMLElement[]
  raf: number | null
  y: number
}

export function ArrangeSheet({
  layout,
  onClose,
}: {
  layout: CardLayout
  onClose: () => void
}) {
  const rows = layout.rows
  // Widened to string deliberately: everything below indexes and permutes these
  // as opaque keys, and narrowing them to the CardId union here only makes
  // indexOf reject the very ids it holds.
  const visibleIds = useMemo<string[]>(
    () => rows.filter((r) => !r.hidden).map((r) => r.spec.id),
    [rows],
  )

  const list = useRef<HTMLUListElement | null>(null)
  const dialog = useRef<HTMLDivElement | null>(null)
  const session = useRef<Session | null>(null)
  const [lifted, setLifted] = useState<string | null>(null)
  /** Where a lift started, so Escape can put the card back. */
  const liftOrigin = useRef<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  /** "Reset this tab" is armed and waiting for its second tap. */
  const [armed, setArmed] = useState(false)
  /** Does the list actually have somewhere to scroll? See the effect below. */
  const [listScrolls, setListScrolls] = useState(false)

  /**
   * Polite, never assertive: assertive interrupts VoiceOver mid-word on every
   * arrow press. Some screen readers drop a live-region update that is
   * character-identical to the last one, so a repeat carries a trailing
   * non-breaking space, which is inaudible and forces the re-announcement.
   */
  const say = (text: string) =>
    setMessage((prev) => (prev === text ? `${text} ` : text))

  // Focus the dialog itself, so its label is announced before the list.
  useEffect(() => {
    dialog.current?.focus()
  }, [])

  /*
   * Whether the list is a real scroll container decides whether a drag inside
   * it may pan at all.
   *
   * `overscroll-behavior` only governs CHAINING out of a scroller that scrolls.
   * A scroller with no overflow is not a scroll container for gesture purposes:
   * the browser walks up for the nearest ancestor that can pan, which here is
   * the document — so with a short list, a vertical drag on a row scrolled the
   * page behind the open sheet and the snap points moved it to a card the user
   * never navigated to. Every tab ships between 2 and 7 cards, at 56px a row
   * inside a sheet capped at 85dvh, so the list overflowing is the RARE case,
   * not the common one.
   *
   * So: when it can scroll, let it, and contain the chaining. When it cannot,
   * refuse the pan outright. Measured rather than assumed, because it depends
   * on the card count, the viewport and the safe-area inset.
   */
  useEffect(() => {
    const el = list.current
    if (el === null) return
    const measure = () => setListScrolls(el.scrollHeight > el.clientHeight + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [rows.length])

  // Disarm the reset on its own. An armed destructive button left sitting there
  // is a trap: the user reads "Tap again to reset", does something else, comes
  // back a minute later and their next tap wipes the layout.
  useEffect(() => {
    if (!armed) return
    const t = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(t)
  }, [armed])

  // A belt for aria-modal, which VoiceOver's virtual cursor has historically
  // leaked past. Removed on unmount, which is before focus returns to the
  // Arrange button — a focused element inside an aria-hidden subtree is a worse
  // bug than the one this fixes.
  useEffect(() => {
    const root = document.getElementById('root')
    root?.setAttribute('aria-hidden', 'true')
    return () => root?.removeAttribute('aria-hidden')
  }, [])

  const visibleIndexOf = (id: string) => visibleIds.indexOf(id)

  /**
   * Move the card at visible index `from` to visible index `to`. Hidden rows are
   * listed but are not part of the reorderable sequence: the page cannot show
   * them, so a position among them means nothing.
   */
  const commit = (from: number, to: number) => layout.setOrder(moveAt(visibleIds, from, to))

  // ── Pointer drag ───────────────────────────────────────────────────────────

  const rowNodes = (): HTMLElement[] => [
    ...(list.current?.querySelectorAll<HTMLElement>('[data-row-visible="true"]') ?? []),
  ]

  const onLift = (e: ReactPointerEvent<HTMLButtonElement>, id: string) => {
    // A second pointer is ignored rather than allowed to hijack a live drag,
    // mirroring the pinch bail in the tab-swipe hook.
    if (!e.isPrimary || session.current !== null) return
    const from = visibleIndexOf(id)
    if (from < 0) return
    // Optional call: jsdom has no setPointerCapture, so every UI test would
    // throw on it. Where it exists it retargets every later pointermove, up and
    // cancel to this button — which is why all four handlers are JSX props and
    // NOTHING here binds to window. Nothing can leak, and nothing can collide
    // with the tab-swipe listener.
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const nodes = rowNodes()
    session.current = {
      pointerId: e.pointerId,
      id,
      from,
      to: from,
      y0: e.clientY,
      top0: list.current?.scrollTop ?? 0,
      rows: nodes,
      raf: null,
      y: e.clientY,
    }
    nodes.forEach((n) => (n.style.willChange = 'transform'))
    setLifted(id)
    setSelected(id)
    liftOrigin.current = from
    navigator.vibrate?.(10)
    say(`Reordering ${labelOf(rows, id)}. Position ${from + 1} of ${visibleIds.length}.`)
  }

  const onMove = (e: ReactPointerEvent) => {
    const s = session.current
    if (s === null || e.pointerId !== s.pointerId) return
    s.y = e.clientY
    // One writer per frame. Pointermove fires faster than the compositor on a
    // 120Hz screen, and the announcements below are throttled by the same gate.
    if (s.raf === null) s.raf = requestAnimationFrame(frame)
  }

  const frame = () => {
    const s = session.current
    if (s === null) return
    s.raf = null
    // The visible list can change under the finger — another window writes a
    // layout, or an import lands and a conditional card appears. Once it has,
    // the captured nodes and the captured indices describe a list that is no
    // longer on screen, so stop shifting neighbours rather than animating a
    // move that will be refused at drop.
    if (staleSession(s)) return
    const el = list.current
    const n = s.rows.length

    // Auto-scroll while the pointer sits in the edge band. Whether this runs
    // depends on the tab and the handset: Data and Forecast ship seven cards,
    // which is 392px of rows, and the list gets what is left of 85dvh after the
    // header and the always-present footer — so on a short screen it scrolls
    // and on a tall one it does not. The `listScrolls` measurement above is the
    // same question asked for a different purpose.
    if (el !== null) {
      const box = el.getBoundingClientRect()
      const EDGE = 48
      if (box.height > 0) {
        const fromTop = s.y - box.top
        const fromBottom = box.bottom - s.y
        if (fromTop < EDGE) el.scrollTop -= 12 * ((EDGE - Math.max(0, fromTop)) / EDGE)
        else if (fromBottom < EDGE) el.scrollTop += 12 * ((EDGE - Math.max(0, fromBottom)) / EDGE)
      }
    }

    const raw = s.y - s.y0 + ((el?.scrollTop ?? 0) - s.top0)
    // Clamped to the ends of the list, so the held row never floats off past
    // the first or last slot and leaves the drop index pinned but the finger
    // still travelling.
    const dy = Math.max(-s.from * ROW_H, Math.min((n - 1 - s.from) * ROW_H, raw))
    const held = s.rows[s.from]
    if (held !== undefined) {
      // Written straight to node.style, never through React state: the finger
      // must not wait on a render, and a re-render mid-drag can drop pointer
      // capture.
      held.style.transition = 'none'
      held.style.transform = `translate3d(0,${dy}px,0) scale(1.02)`
    }
    const to = dropIndex(s.from, dy, n)
    if (to !== s.to) {
      s.to = to
      navigator.vibrate?.(5)
      s.rows.forEach((node, i) => {
        if (i === s.from) return
        // Layout never changes during the drag — only transforms do — so this
        // CSS transition IS the reflow animation. No FLIP pass is needed, and
        // the prefers-reduced-motion block in index.css already zeroes its
        // duration.
        node.style.transition = 'transform 180ms cubic-bezier(.2,0,0,1)'
        node.style.transform = `translate3d(0,${shiftFor(i, s.from, to)}px,0)`
      })
    }
  }

  /**
   * Has the list moved on since this drag was measured?
   *
   * The captured node list is the ground truth the transforms were computed
   * against, so a change in its length means the geometry on screen no longer
   * matches the geometry in hand.
   */
  const staleSession = (s: Session): boolean =>
    s.rows.length !== visibleIds.length || visibleIds[s.from] !== s.id

  const clearTransforms = (s: Session) => {
    if (s.raf !== null) cancelAnimationFrame(s.raf)
    s.rows.forEach((n) => {
      n.style.transform = ''
      n.style.transition = ''
      n.style.willChange = ''
    })
  }

  const onDrop = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const s = session.current
    if (s === null || e.pointerId !== s.pointerId) return
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    // Clearing the transforms in the same handler that permutes the array lands
    // the row exactly where its shifted neighbour already sits, so there is no
    // frame in which both are drawn in the same place.
    clearTransforms(s)
    session.current = null
    setLifted(null)
    liftOrigin.current = null

    // Re-derive the source from the ID rather than trusting the index captured
    // at lift. `s.from` and `s.to` address the visible list AS IT WAS when the
    // finger went down, so if anything changed it since — another window's
    // storage event, an import that added a conditional card — committing them
    // would move a card the user never touched, and persist it. Refuse instead:
    // an abandoned drag costs one gesture, a silent wrong move costs trust.
    if (staleSession(s)) {
      say('Reorder cancelled: the list changed.')
      return
    }
    const from = visibleIds.indexOf(s.id)
    if (from < 0) {
      say('Reorder cancelled: the list changed.')
      return
    }
    if (s.to === from) {
      // A tap, not a drag. Selecting the row reveals the move buttons: a grip
      // that does nothing on tap reads as broken, and a thumb taps grips.
      say(`${labelOf(rows, s.id)} selected. Position ${from + 1} of ${visibleIds.length}.`)
      return
    }
    commit(from, s.to)
    navigator.vibrate?.(12)
    say(
      `${labelOf(rows, s.id)} moved from position ${from + 1} to ${s.to + 1} of ${visibleIds.length}.`,
    )
  }

  const onCancelDrag = (e: ReactPointerEvent) => {
    // iOS fires pointercancel when the system steals the gesture: a screen-edge
    // swipe, an incoming call. Animate back and change no state.
    const s = session.current
    if (s === null || e.pointerId !== s.pointerId) return
    settleBack(s)
    session.current = null
    setLifted(null)
    liftOrigin.current = null
    say('Reorder cancelled.')
  }

  /**
   * Animate the rows home, then take the inline styles off.
   *
   * The styles have to go: `will-change: transform` is set on every row at lift,
   * and left behind it keeps a compositor layer per row alive for the rest of
   * the sheet's life. Cleared on `transitionend`, with a timeout as the backstop
   * for the case the event never arrives — a row already at translate(0)
   * transitions nothing and so fires nothing, and under
   * `prefers-reduced-motion` index.css cuts the duration to 0.01ms.
   */
  const settleBack = (s: Session) => {
    if (s.raf !== null) cancelAnimationFrame(s.raf)
    s.rows.forEach((n, i) => {
      n.style.transition = 'transform 180ms cubic-bezier(.2,0,0,1)'
      n.style.transform = i === s.from ? 'translate3d(0,0,0)' : ''
    })
    const strip = () =>
      s.rows.forEach((n) => {
        n.style.transform = ''
        n.style.transition = ''
        n.style.willChange = ''
      })
    const held = s.rows[s.from]
    held?.addEventListener('transitionend', strip, { once: true })
    window.setTimeout(strip, 240)
  }

  // ── Keyboard ───────────────────────────────────────────────────────────────

  const onGripKey = (e: KeyboardEvent, id: string) => {
    const at = visibleIndexOf(id)
    if (at < 0) return
    const n = visibleIds.length
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      if (lifted === id) {
        setLifted(null)
        liftOrigin.current = null
        say(`${labelOf(rows, id)} dropped at position ${at + 1} of ${n}.`)
      } else {
        setLifted(id)
        liftOrigin.current = at
        say(
          `Reordering ${labelOf(rows, id)}. Position ${at + 1} of ${n}. ` +
            'Use the up and down arrow keys to move, space to drop, escape to cancel.',
        )
      }
      return
    }
    if (lifted !== id) return
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Home' || e.key === 'End') {
      // preventDefault, or the dialog scrolls underneath the reorder.
      e.preventDefault()
      const to =
        e.key === 'Home'
          ? 0
          : e.key === 'End'
            ? n - 1
            : Math.max(0, Math.min(n - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))
      if (to === at) return
      commit(at, to)
      say(`Position ${to + 1} of ${n}.`)
    }
  }

  const onDialogKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      // Precedence is explicit: while a card is lifted, Escape puts it back and
      // the dialog stays open. Without this, Escape mid-lift closes the sheet
      // and commits a move the user was in the middle of abandoning.
      if (lifted !== null) {
        // A pointer drag can be live at the same time as `lifted` is set (the
        // finger is down, the keyboard fired Escape). Clearing `lifted` alone
        // left the rAF loop, the transforms and the eventual onDrop commit all
        // running, so the sheet announced a cancel and then performed the move
        // anyway. Kill the session first, so both cancel paths converge.
        const live = session.current
        if (live !== null) {
          session.current = null
          settleBack(live)
        }
        const at = visibleIndexOf(lifted)
        const origin = liftOrigin.current
        if (at >= 0 && origin !== null && at !== origin) commit(at, origin)
        say(
          `Reorder cancelled. ${labelOf(rows, lifted)} back at position ${
            (origin ?? at) + 1
          } of ${visibleIds.length}.`,
        )
        setLifted(null)
        liftOrigin.current = null
        return
      }
      onClose()
      return
    }
    if (e.key === 'Tab') {
      if (lifted !== null) {
        // Tabbing away COMMITS, and says so. It used to announce "cancelled"
        // while keeping every arrow-key move that had already been applied —
        // two exits from a lift, the same words, opposite results. Escape is
        // the one that reverts; leaving is the one that keeps.
        const at = visibleIndexOf(lifted)
        say(
          `${labelOf(rows, lifted)} dropped at position ${at + 1} of ${visibleIds.length}.`,
        )
        setLifted(null)
        liftOrigin.current = null
      }
      // Focus trap: cycle inside the dialog. The scrim is outside this ref on
      // purpose, so Tab never lands on a full-screen "close" target.
      const nodes = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ]
      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      if (first === undefined || last === undefined) return
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      }
    }
  }

  // ── Selected-row actions ───────────────────────────────────────────────────

  const selAt = selected === null ? -1 : visibleIndexOf(selected)
  const nudge = (to: number, keep: 'up' | 'down' | 'top') => {
    if (selected === null || selAt < 0) return
    commit(selAt, to)
    say(`${labelOf(rows, selected)} moved to position ${to + 1} of ${visibleIds.length}.`)
    // Focus follows the ACTION, not the DOM node: pressing Up until the card
    // reaches the top disables the button under the finger, and a disabled
    // control that just took a press strands focus on <body> — outside the
    // dialog, where the focus trap can no longer see it.
    //
    // BOTH ends need compensating, not just the top. At the bottom the pressed
    // Down button disables itself, so the fallback has to be Up. The chain ends
    // on Done, which is always enabled, so focus can never leave the sheet even
    // for a single-card list where all three move buttons are dead.
    requestAnimationFrame(() => {
      const last = visibleIds.length - 1
      const wanted = to === 0 ? 'down' : to === last ? 'up' : keep
      const dlg = dialog.current
      const target =
        dlg?.querySelector<HTMLElement>(`[data-move="${wanted}"]:not([disabled])`) ??
        dlg?.querySelector<HTMLElement>('[data-move]:not([disabled])') ??
        dlg?.querySelector<HTMLElement>('[data-sheet-done]')
      target?.focus()
    })
  }

  return (
    <div data-no-swipe className="fixed inset-0 z-40">
      {/* Scrim.
          `touch-none` here is one part of the page lock, not the whole of it.
          The approach is deliberate: never `html { overflow: hidden }`, which
          would disable the `scroll-snap-type` this app sets on html and which
          iOS answers by dropping the scroll offset, and never
          `body { position: fixed }`, which loses it outright. Instead every box
          in this overlay that is NOT a scroller declares `touch-action: none`,
          so a pan cannot start there and chain to the document behind it.
          The list is the sole exception, because it has to be able to pan
          itself — which is also why `touch-none` must not go on the dialog
          root: the effective touch-action is intersected from the touched
          element up to the element that would scroll, so `none` on an ancestor
          of the list would disable the list.
          A real button, not a div with a click handler, so dismissal is
          keyboard- and screen-reader-reachable. */}
      <button
        type="button"
        aria-label="Close arrange cards"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-[1px] touch-none"
      />

      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="arrange-title"
        aria-describedby="arrange-help"
        tabIndex={-1}
        onKeyDown={onDialogKey}
        // Safe-area insets are re-applied because a fixed element is positioned
        // against the viewport and ignores the env() padding body carries. z-40
        // sits above the z-30 headers and tab bar and below the skip link's
        // focus:z-50. dvh, not vh: on iOS Safari vh is the LARGE viewport, so
        // 85vh overflows the screen while the URL bar is showing.
        className="absolute inset-x-0 bottom-0 max-h-[85dvh] flex flex-col
                   bg-surface border-t border-border rounded-t-2xl
                   pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]
                   sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 sm:bottom-6 sm:w-[28rem]
                   sm:border sm:rounded-2xl
                   animate-[sheet-in_220ms_cubic-bezier(.32,.72,0,1)]"
      >
        {/* Grabber. Decorative — every dismissal route is a real control. */}
        <div aria-hidden className="sm:hidden mx-auto mt-2 h-1 w-9 rounded-full bg-border touch-none" />

        <div className="shrink-0 flex items-start gap-3 px-4 pt-3 pb-3 sm:pt-4 touch-none">
          <div className="min-w-0">
            <h2 id="arrange-title" className="text-sm font-semibold">
              Arrange cards
            </h2>
            <p className="text-xs text-muted mt-0.5">
              Drag a handle to reorder · tap the eye to hide
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            data-sheet-done
            className={`ml-auto shrink-0 min-h-[44px] px-3 text-sm text-accent rounded-lg ${FOCUS}`}
          >
            Done
          </button>
        </div>

        <p id="arrange-help" className="sr-only touch-none">
          Press space on a handle to pick a card up, then use the up and down arrow keys to move
          it, space to drop it, escape to put it back.
        </p>
        {/* Mounted empty on purpose: a live region added at the same time as its
            content is not announced. Inside the fixed dialog, which IS a
            positioned box, so this position:absolute sr-only node cannot escape
            into page layout the way one did on Income. */}
        <p role="status" aria-live="polite" className="sr-only touch-none">
          {message}
        </p>

        {/* The one scroller in here. `overscroll-y-contain`, never Tailwind's
            `overscroll-contain`: containing BOTH axes is the exact mistake this
            codebase has already reverted twice. No overflow-x anywhere below
            this node either — a horizontal strip would be the first
            phone-visible horizontal scroller in the app, and a 45-degree thumb
            drag over one moves the page 0px until the finger lifts. */}
        <ul
          ref={list}
          aria-label="Card order"
          // NO `space-y-*` here, and this is load-bearing: a margin between rows
          // makes the rendered pitch larger than ROW_H, and every piece of drag
          // arithmetic divides by ROW_H. `space-y-1` put the real pitch at 60
          // against a constant of 56, so a drag of four rows landed three and a
          // bit rows down and the neighbours sat 4px out of true, compounding
          // down the list. The 4px gap is now padding INSIDE each 56px row, so
          // the pitch is exactly ROW_H by construction.
          // `overscroll-y-contain` is unconditional and `touch-none` is not:
          // see the measuring effect above. Never Tailwind's bare
          // `overscroll-contain` — containing BOTH axes is the exact mistake
          // this codebase has already reverted twice.
          className={`min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-2 pb-2 ${
            listScrolls ? '' : 'touch-none'
          }`}
        >
          {rows.map((row) => {
            const id = row.spec.id
            const at = visibleIndexOf(id)
            const isLifted = lifted === id
            return (
              <li
                key={id}
                data-row-visible={row.hidden ? 'false' : 'true'}
                style={{ height: ROW_H }}
                className={`relative select-none py-0.5 ${isLifted ? 'z-10' : ''}`}
              >
                <div
                  className={`h-full flex items-center gap-1 rounded-xl border bg-surface px-1.5 ${
                    row.hidden ? 'border-border opacity-60' : 'border-border'
                  } ${isLifted ? 'shadow-lg border-accent ring-2 ring-accent' : ''} ${
                    selected === id && !isLifted ? 'ring-1 ring-accent' : ''
                  }`}
                >
                  <button
                    type="button"
                    disabled={!row.canHide}
                    onClick={() => {
                      layout.setHidden(id, !row.hidden)
                      say(
                        row.hidden
                          ? `${row.spec.label} shown.`
                          : `${row.spec.label} hidden. ${visibleIds.length - 1} shown.`,
                      )
                    }}
                    className={`shrink-0 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg text-muted hover:text-ink disabled:opacity-40 ${FOCUS}`}
                  >
                    {/* Disabled with a reason, rather than absent: an absent
                        control reads as a bug, and the reason is the only place
                        "this is the only way to import a statement" gets said. */}
                    <span className="sr-only">
                      {row.hidden ? `Show ${row.spec.label}` : `Hide ${row.spec.label}`}
                      {row.lockReason === '' ? '' : `. ${row.lockReason}`}
                    </span>
                    {row.hidden ? <EyeOffIcon /> : <EyeIcon />}
                  </button>

                  <button
                    type="button"
                    onClick={() => setSelected(id)}
                    aria-pressed={selected === id}
                    className={`min-w-0 flex-1 min-h-[44px] flex items-center gap-2 text-left px-1 rounded-lg ${FOCUS}`}
                  >
                    <span
                      className={`text-sm truncate ${row.hidden ? 'text-muted line-through' : ''}`}
                    >
                      {row.spec.label}
                    </span>
                    {/* Never colour alone — the house rule. "Moving" is the
                        only cue a keyboard lift gets otherwise: that path
                        applies no transform and no scale, so an accent border
                        and a shadow on a near-black surface were carrying the
                        whole state on their own. */}
                    {isLifted ? (
                      <span className="shrink-0 text-[10px] text-accent font-medium">Moving</span>
                    ) : row.hidden ? (
                      <span className="shrink-0 text-[10px] text-muted">Hidden</span>
                    ) : row.collapsed ? (
                      <span className="shrink-0 text-[10px] text-muted">Collapsed</span>
                    ) : null}
                  </button>

                  {/* Grip on the RIGHT, away from the iOS left-edge back-swipe
                      zone, which steals a drag beginning within about 20px of it
                      and fires pointercancel. `touch-none` is scoped to this
                      44px box so the row and the list still scroll normally; the
                      two -webkit- properties stop Safari injecting its own
                      selection callout and native element drag mid-gesture. */}
                  <button
                    type="button"
                    aria-describedby="arrange-help"
                    // The picked-up state was conveyed by styling only, so a
                    // screen reader had no way to know a card was in hand.
                    aria-pressed={isLifted}
                    disabled={row.hidden}
                    onPointerDown={(e) => onLift(e, id)}
                    onPointerMove={onMove}
                    onPointerUp={onDrop}
                    onPointerCancel={onCancelDrag}
                    onKeyDown={(e) => onGripKey(e, id)}
                    className={`shrink-0 min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg
                                hover:text-ink disabled:opacity-30
                                touch-none select-none [-webkit-touch-callout:none] [-webkit-user-drag:none]
                                ${isLifted ? 'text-ink' : 'text-muted'} ${FOCUS}`}
                  >
                    <span className="sr-only">
                      Reorder {row.spec.label}
                      {at >= 0 ? `, position ${at + 1} of ${visibleIds.length}` : ''}
                    </span>
                    <GripIcon />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>

        {/* Footer, under the thumb. The move buttons live here rather than in
            each row so they sit in one predictable place instead of at whatever
            height the row they belong to happens to occupy. */}
        {/* Footer.
            Its height does NOT depend on whether a row is selected, and that is
            the point. Rendered conditionally, the move row appeared the instant
            a row was tapped and grew the sheet upward by ~64px — more than one
            row pitch — so the whole list jumped under the finger and the
            follow-up tap landed on the wrong card. Always present, disabled
            until there is something to move. */}
        <div className="shrink-0 border-t border-border px-2 pt-2 touch-none">
          <p className="px-2 text-xs text-muted truncate">
            {selected !== null && selAt >= 0 ? (
              <>Selected: {labelOf(rows, selected)}</>
            ) : (
              <span className="text-muted/70">Tap a card to move it with the buttons</span>
            )}
          </p>
          <div className="grid grid-cols-3 gap-2 mt-1">
            <button
              type="button"
              data-move="up"
              disabled={selAt <= 0}
              onClick={() => nudge(selAt - 1, 'up')}
              className={`min-h-[44px] rounded-lg border border-border text-sm disabled:opacity-40 ${FOCUS}`}
            >
              <span aria-hidden>↑</span> Up
            </button>
            <button
              type="button"
              data-move="down"
              disabled={selAt < 0 || selAt === visibleIds.length - 1}
              onClick={() => nudge(selAt + 1, 'down')}
              className={`min-h-[44px] rounded-lg border border-border text-sm disabled:opacity-40 ${FOCUS}`}
            >
              <span aria-hidden>↓</span> Down
            </button>
            <button
              type="button"
              data-move="top"
              disabled={selAt <= 0}
              onClick={() => nudge(0, 'top')}
              className={`min-h-[44px] rounded-lg border border-border text-sm disabled:opacity-40 ${FOCUS}`}
            >
              <span aria-hidden>⤒</span> To top
            </button>
          </div>

          {/* Reset is the one destructive control here, and it used to sit flush
              against "Up" in the same column — 0px of dead space between a move
              and a wipe — and in the screen region the mobile tab bar's first
              item occupies, so a mis-tap was cheap and its consequence was not.
              Now it is pushed right, away from that corridor, separated by real
              space, and it arms before it fires. Two taps, because there is no
              undo: the previous arrangement is gone once this runs. */}
          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="num text-[11px] text-muted px-2">
              {layout.hiddenCount} hidden
            </span>
            <button
              type="button"
              onClick={() => {
                if (!armed) {
                  setArmed(true)
                  return
                }
                setArmed(false)
                layout.resetTab()
                setSelected(null)
                setLifted(null)
                say('Layout reset. Every card is shown, in its original order.')
              }}
              className={`min-h-[44px] px-2 text-xs rounded-lg ${
                armed ? 'text-serious font-medium' : 'text-muted hover:text-ink'
              } ${FOCUS}`}
            >
              {armed ? 'Tap again to reset' : 'Reset this tab'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const labelOf = (rows: readonly CardRow[], id: string): string =>
  rows.find((r) => r.spec.id === id)?.spec.label ?? id
