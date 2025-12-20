import { useEffect, useState, useRef } from 'react'
import CesiumViewer from '../CesiumViewer/CesiumViewer'

interface InsetCesiumViewerProps {
  viewportId: string
}

/**
 * Wrapper for CesiumViewer in inset viewports.
 * Delays rendering until the container has non-zero dimensions to prevent
 * WebGL context errors from zero-size framebuffers.
 */
function InsetCesiumViewer({ viewportId }: InsetCesiumViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isReady, setIsReady] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    // Check if container has dimensions
    const checkDimensions = () => {
      const rect = container.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setIsReady(true)
        return true
      }
      return false
    }

    // Check immediately
    if (checkDimensions()) return

    // Use ResizeObserver to wait for dimensions
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0 && entry.contentRect.height > 0) {
          setIsReady(true)
          resizeObserver.disconnect()
          break
        }
      }
    })

    resizeObserver.observe(container)

    // Also check on next animation frame as fallback
    const rafId = requestAnimationFrame(() => {
      checkDimensions()
    })

    return () => {
      resizeObserver.disconnect()
      cancelAnimationFrame(rafId)
    }
  }, [])

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }}>
      {isReady && <CesiumViewer viewportId={viewportId} isInset={true} />}
    </div>
  )
}

export default InsetCesiumViewer
