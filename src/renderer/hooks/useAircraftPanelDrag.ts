import { type PointerEvent as ReactPointerEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'

type Offset = { x: number; y: number }

const ANCHOR_INSET_PX = 10

function readPxVar(name: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getTopInset(): number {
  return readPxVar('--topbar-h', 48) + ANCHOR_INSET_PX
}

function getBottomInset(): number {
  return readPxVar('--controls-h', 48) + ANCHOR_INSET_PX
}

/**
 * Drag-to-reposition for the aircraft panel.
 *
 * Adapted from `SettingsModal.tsx:29-158` with three differences:
 * - Pointer events with `setPointerCapture` (not mouse-only) so touch works.
 * - No coarse-pointer disable: persistent panel position matters more on
 *   tablets than a centered modal's drag-to-reposition.
 * - "Offset from anchor" semantics, not "offset from center" — `dockSide`
 *   determines which corner is the anchor; `position.x` is always positive
 *   inward, so flipping `dockSide` mirrors symmetrically without needing
 *   to recompute or reset.
 *
 * Constraint: keeps panel within window bounds minus the topbar/controls
 * insets and a 10px margin, re-clamping on resize.
 *
 * @param panelRef Ref to the panel element — used to read the actual
 *   rendered height (which can differ from `panelHeight` when that is 0).
 */
export function useAircraftPanelDrag(panelRef: RefObject<HTMLDivElement | null>): {
  position: Offset
  isDragging: boolean
  handlers: {
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => void
  }
} {
  const dockSide = useSettingsStore((state) => state.ui.aircraftPanelDockSide)
  const storedPosition = useSettingsStore((state) => state.ui.aircraftPanelPosition)
  const panelWidth = useSettingsStore((state) => state.ui.aircraftPanelWidth)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)

  const [position, setPosition] = useState<Offset>(() => storedPosition ?? { x: 0, y: 0 })
  const [isDragging, setIsDragging] = useState(false)
  const dragStartRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null)

  useEffect(() => {
    setPosition(storedPosition ?? { x: 0, y: 0 })
  }, [storedPosition])

  const constrain = useCallback(
    (offset: Offset): Offset => {
      const w = window.innerWidth
      const h = window.innerHeight
      const panelHeightPx = panelRef.current?.getBoundingClientRect().height ?? 0
      const margin = 10
      const topInset = getTopInset()
      const bottomInset = getBottomInset()

      const maxX = Math.max(0, w - margin - ANCHOR_INSET_PX - panelWidth)
      const maxY = Math.max(0, h - topInset - bottomInset - panelHeightPx)

      return {
        x: Math.max(0, Math.min(maxX, offset.x)),
        y: Math.max(0, Math.min(maxY, offset.y)),
      }
    },
    [panelRef, panelWidth],
  )

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      const target = e.target as HTMLElement
      if (target.closest('button, a, input, select, textarea')) return
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(true)
      dragStartRef.current = {
        px: e.clientX,
        py: e.clientY,
        ox: position.x,
        oy: position.y,
      }
      e.currentTarget.setPointerCapture(e.pointerId)
    },
    [position.x, position.y],
  )

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!dragStartRef.current) return
      const { px, py, ox, oy } = dragStartRef.current
      const dx = e.clientX - px
      const dy = e.clientY - py
      const xDelta = dockSide === 'right' ? -dx : dx
      setPosition(constrain({ x: ox + xDelta, y: oy + dy }))
    },
    [dockSide, constrain],
  )

  const endDrag = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!dragStartRef.current) return
      dragStartRef.current = null
      setIsDragging(false)
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // pointer may already have been released by the browser; ignore
      }
      // Read the latest constrained position synchronously to avoid persisting stale state
      setPosition((latest) => {
        updateUISettings({ aircraftPanelPosition: latest })
        return latest
      })
    },
    [updateUISettings],
  )

  useEffect(() => {
    const handler = () => setPosition((prev) => constrain(prev))
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [constrain])

  useEffect(() => {
    if (!panelRef.current) return
    const observer = new ResizeObserver(() => setPosition((prev) => constrain(prev)))
    observer.observe(panelRef.current)
    return () => observer.disconnect()
  }, [panelRef, constrain])

  return {
    position,
    isDragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  }
}
