/**
 * Hook to determine if compact/mobile layout should be used
 *
 * Returns true when:
 * - Window width is below the compact breakpoint (1200px)
 * - OR device is a touch device
 *
 * This hook responds to window resize events, so the layout
 * will update dynamically when the window is resized.
 */

import { useState, useEffect } from 'react'
import { isTouchDevice } from '../utils/deviceDetection'

const COMPACT_BREAKPOINT = 1200

export function useIsMobileLayout(): boolean {
  const [isCompact, setIsCompact] = useState(() => {
    // Initial check - use window width or touch device detection
    if (typeof window === 'undefined') return false
    return window.innerWidth < COMPACT_BREAKPOINT || isTouchDevice()
  })

  useEffect(() => {
    const checkCompact = () => {
      const isSmallWindow = window.innerWidth < COMPACT_BREAKPOINT
      const isTouch = isTouchDevice()
      setIsCompact(isSmallWindow || isTouch)
    }

    // Check on mount
    checkCompact()

    // Listen for resize events
    window.addEventListener('resize', checkCompact)

    return () => {
      window.removeEventListener('resize', checkCompact)
    }
  }, [])

  return isCompact
}

/**
 * Hook to get current window dimensions
 * Useful for more granular responsive behavior
 */
export function useWindowSize(): { width: number; height: number } {
  const [size, setSize] = useState(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1920,
    height: typeof window !== 'undefined' ? window.innerHeight : 1080
  }))

  useEffect(() => {
    const handleResize = () => {
      setSize({
        width: window.innerWidth,
        height: window.innerHeight
      })
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  return size
}
