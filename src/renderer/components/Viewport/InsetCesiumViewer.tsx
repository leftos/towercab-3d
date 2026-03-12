/**
 * InsetCesiumViewer - Renders inset viewport in an isolated iframe
 *
 * This component renders an iframe that loads a separate instance of the app
 * (inset.html) with its own Cesium WebGL context. This isolation is required
 * because Cesium has internal resource sharing bugs that prevent 3D buildings
 * from rendering correctly when multiple viewers exist in the same browsing context.
 *
 * Communication:
 * - Main → Inset: SharedWorker (aircraft data, settings, weather, cesium token)
 * - Inset → Main: postMessage (camera changes, aircraft selection, follow requests)
 *
 * @see docs/plans/iframe-inset-isolation.md for full architecture
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useViewportStore } from '../../stores/viewportStore'
import type { CameraStateUpdate } from '../../types/shared-worker'

interface InsetCesiumViewerProps {
  viewportId: string
}

/**
 * Message types received from inset iframe
 */
interface InsetMessage {
  type: 'inset-ready' | 'inset-focus' | 'camera-change' | 'aircraft-select' | 'follow-request' | 'error' | 'debug-log'
  viewportId: string
  payload?: unknown
  /** When true, manipulation has ended and this is the final state to persist */
  final?: boolean
}

/**
 * Wrapper that renders an inset viewport in an isolated iframe.
 * The iframe loads inset.html which runs a minimal version of the app
 * with its own Cesium/Babylon instances.
 */
function InsetCesiumViewer({ viewportId }: InsetCesiumViewerProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isReady, setIsReady] = useState(false)
  const [iframeReady, setIframeReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Track when we're processing a camera update FROM the inset
  // Used to prevent echoing the same update back to the inset
  const insetCameraUpdateInProgressRef = useRef(false)

  // Build iframe URL with viewport ID and parent origin
  const iframeSrc = useMemo(() => {
    // In dev mode, inset.html is served from the same origin
    // In production, it's in the same directory as index.html
    const base = import.meta.env.DEV ? '/inset.html' : './inset.html'
    const params = new URLSearchParams({
      viewportId,
      parentOrigin: window.location.origin,
    })
    return `${base}?${params.toString()}`
  }, [viewportId])

  // Handle messages from the iframe
  const handleMessage = useCallback(
    (event: MessageEvent<InsetMessage>) => {
      // Verify origin (same origin for security)
      if (event.origin !== window.location.origin) {
        return
      }

      // Verify source is our iframe
      if (event.source !== iframeRef.current?.contentWindow) {
        return
      }

      const { type, viewportId: msgViewportId, payload } = event.data

      // Handle debug-log messages from inset (these don't have viewportId)
      if (type === 'debug-log') {
        // Debug messages are silently ignored in production
        return
      }

      // Ignore messages for other viewports
      if (msgViewportId !== viewportId) {
        return
      }

      switch (type) {
        case 'inset-ready':
          setIframeReady(true)
          break

        case 'inset-focus':
          // User clicked/interacted with the inset - activate this viewport
          useViewportStore.getState().setActiveViewport(viewportId)
          break

        case 'camera-change': {
          // Camera state update from inset
          // - Always update live state (viewports) immediately
          // - Only persist (airportViewportConfigs) when final=true (manipulation ended)
          if (payload && typeof payload === 'object') {
            const cameraUpdate = payload as CameraStateUpdate
            const isFinal = event.data.final === true

            const store = useViewportStore.getState()
            const viewportIndex = store.viewports.findIndex((v) => v.id === viewportId)

            if (viewportIndex >= 0) {
              // Set flag to prevent echoing this update back to the inset
              insetCameraUpdateInProgressRef.current = true

              // Directly update this viewport's cameraState without changing activeViewport
              const updatedViewports = [...store.viewports]
              updatedViewports[viewportIndex] = {
                ...updatedViewports[viewportIndex],
                cameraState: {
                  ...updatedViewports[viewportIndex].cameraState,
                  ...(cameraUpdate.heading !== undefined && { heading: cameraUpdate.heading }),
                  ...(cameraUpdate.pitch !== undefined && { pitch: cameraUpdate.pitch }),
                  ...(cameraUpdate.fov !== undefined && { fov: cameraUpdate.fov }),
                  ...(cameraUpdate.positionOffsetX !== undefined && { positionOffsetX: cameraUpdate.positionOffsetX }),
                  ...(cameraUpdate.positionOffsetY !== undefined && { positionOffsetY: cameraUpdate.positionOffsetY }),
                  ...(cameraUpdate.positionOffsetZ !== undefined && { positionOffsetZ: cameraUpdate.positionOffsetZ }),
                  ...(cameraUpdate.orbitDistance !== undefined && { orbitDistance: cameraUpdate.orbitDistance }),
                  ...(cameraUpdate.orbitHeading !== undefined && { orbitHeading: cameraUpdate.orbitHeading }),
                  ...(cameraUpdate.orbitPitch !== undefined && { orbitPitch: cameraUpdate.orbitPitch }),
                },
              }

              if (isFinal) {
                // Manipulation ended - persist to airportViewportConfigs for global-settings.json sync
                const icao = store.currentAirportIcao
                if (icao) {
                  const airportViewportConfigs = { ...store.airportViewportConfigs }
                  const existingConfig = airportViewportConfigs[icao]
                  airportViewportConfigs[icao] = {
                    ...existingConfig,
                    viewports: updatedViewports.map((v) => ({
                      ...v,
                      cameraState: { ...v.cameraState, followingCallsign: null, preFollowState: null },
                    })),
                    activeViewportId: store.activeViewportId,
                  }
                  useViewportStore.setState({ viewports: updatedViewports, airportViewportConfigs })
                } else {
                  useViewportStore.setState({ viewports: updatedViewports })
                }
              } else {
                // Still manipulating - only update live state, don't persist yet
                useViewportStore.setState({ viewports: updatedViewports })
              }

              // Clear flag after a microtask to allow subscription to check it
              queueMicrotask(() => {
                insetCameraUpdateInProgressRef.current = false
              })
            }
          }
          break
        }

        case 'aircraft-select':
          // Propagate aircraft selection to main app
          // TODO: This should update the selected aircraft in the main UI
          break

        case 'follow-request':
          // Start following aircraft in this viewport
          if (payload && typeof payload === 'object' && 'callsign' in payload) {
            const callsign = (payload as { callsign: string }).callsign
            const store = useViewportStore.getState()
            store.setActiveViewport(viewportId)
            store.followAircraft(callsign)
          }
          break

        case 'error':
          // Handle error from inset
          if (payload && typeof payload === 'object' && 'error' in payload) {
            const errorMsg = (payload as { error: string }).error
            setError(errorMsg)
            console.error(`[InsetCesiumViewer] Error in ${viewportId}:`, errorMsg)
          }
          break
      }
    },
    [viewportId],
  )

  // Listen for postMessage from iframe
  useEffect(() => {
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [handleMessage])

  // Send message to iframe
  const sendToIframe = useCallback(
    (type: string, payload?: unknown) => {
      if (!iframeRef.current?.contentWindow || !iframeReady) {
        return
      }

      try {
        iframeRef.current.contentWindow.postMessage({ type, viewportId, payload }, window.location.origin)
      } catch (err) {
        console.error('[InsetCesiumViewer] Failed to send message to iframe:', err)
      }
    },
    [viewportId, iframeReady],
  )

  // Subscribe to activeViewportId changes and notify iframe of activation state
  useEffect(() => {
    if (!iframeReady) return

    // Send initial activation state
    const initialActive = useViewportStore.getState().activeViewportId === viewportId
    sendToIframe('set-activated', { activated: initialActive })

    // Subscribe to changes
    const unsubscribe = useViewportStore.subscribe(
      (state) => state.activeViewportId,
      (activeId) => {
        const isActive = activeId === viewportId
        sendToIframe('set-activated', { activated: isActive })
      },
    )

    return unsubscribe
  }, [viewportId, iframeReady, sendToIframe])

  // Subscribe to viewport store changes to forward camera updates to iframe
  useEffect(() => {
    if (!iframeReady) return

    // Helper to build camera update payload
    const buildCameraPayload = (
      cameraState: NonNullable<ReturnType<typeof useViewportStore.getState>['viewports'][0]['cameraState']>,
    ) => ({
      heading: cameraState.heading,
      pitch: cameraState.pitch,
      fov: cameraState.fov,
      positionOffsetX: cameraState.positionOffsetX,
      positionOffsetY: cameraState.positionOffsetY,
      positionOffsetZ: cameraState.positionOffsetZ,
      followingCallsign: cameraState.followingCallsign,
      followMode: cameraState.followMode,
      // Forward geographic position for look-at (inset calculates its own heading/pitch)
      pendingLookAtPosition: cameraState.pendingLookAtPosition,
      orbitDistance: cameraState.orbitDistance,
      orbitHeading: cameraState.orbitHeading,
      orbitPitch: cameraState.orbitPitch,
    })

    // Send initial camera state when inset becomes ready
    // This restores saved 6DOF camera position from global settings
    const initialViewport = useViewportStore.getState().viewports.find((v) => v.id === viewportId)
    if (initialViewport?.cameraState) {
      sendToIframe('camera-update', buildCameraPayload(initialViewport.cameraState))
    }

    // Subscribe to future changes
    const unsubscribe = useViewportStore.subscribe(
      (state) => {
        const viewport = state.viewports.find((v) => v.id === viewportId)
        return viewport?.cameraState
      },
      (cameraState) => {
        // Skip if this update originated from the inset itself (prevents feedback loop)
        if (insetCameraUpdateInProgressRef.current) {
          return
        }

        if (cameraState) {
          // Forward camera state to iframe
          // NOTE: We do NOT forward lookAtTarget (heading/pitch) because those are
          // calculated from the main viewport's camera position. Instead we forward
          // pendingLookAtPosition (geographic coordinates) so the inset can calculate
          // its own heading/pitch from its camera position.
          sendToIframe('camera-update', buildCameraPayload(cameraState))
        }
      },
    )

    return unsubscribe
  }, [viewportId, iframeReady, sendToIframe])

  // Re-focus iframe when actions target this viewport from main app UI
  // This handles the case where user clicks on nearby aircraft panel to follow/point-to
  // which takes focus to main window, but the action targets this inset
  useEffect(() => {
    if (!iframeReady) return

    let prevFollowingCallsign: string | null = null
    let prevLookAtPosition: { lat: number; lon: number; altitudeFt: number } | null = null

    const unsubscribe = useViewportStore.subscribe(
      (state) => {
        const viewport = state.viewports.find((v) => v.id === viewportId)
        return {
          followingCallsign: viewport?.cameraState?.followingCallsign ?? null,
          pendingLookAtPosition: viewport?.cameraState?.pendingLookAtPosition ?? null,
          isActive: state.activeViewportId === viewportId,
        }
      },
      ({ followingCallsign, pendingLookAtPosition, isActive }) => {
        // If this inset is active and followingCallsign changed, re-focus the iframe
        // This catches follow/unfollow actions triggered from main app UI
        if (isActive && followingCallsign !== prevFollowingCallsign) {
          sendToIframe('request-focus', {})
        }
        prevFollowingCallsign = followingCallsign

        // If this inset is active and pendingLookAtPosition changed (new look-at action), re-focus
        // This catches "look at aircraft" and "look at runway" actions from main app UI
        const lookAtChanged =
          pendingLookAtPosition !== null &&
          (prevLookAtPosition === null ||
            pendingLookAtPosition.lat !== prevLookAtPosition.lat ||
            pendingLookAtPosition.lon !== prevLookAtPosition.lon)
        if (isActive && lookAtChanged) {
          sendToIframe('request-focus', {})
        }
        prevLookAtPosition = pendingLookAtPosition
      },
    )

    // Initialize previous state
    const viewport = useViewportStore.getState().viewports.find((v) => v.id === viewportId)
    prevFollowingCallsign = viewport?.cameraState?.followingCallsign ?? null
    prevLookAtPosition = viewport?.cameraState?.pendingLookAtPosition ?? null

    return unsubscribe
  }, [viewportId, iframeReady, sendToIframe])

  // Check container dimensions before loading iframe
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const checkDimensions = () => {
      const rect = container.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setIsReady(true)
        return true
      }
      return false
    }

    if (checkDimensions()) return

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

    const rafId = requestAnimationFrame(() => {
      checkDimensions()
    })

    return () => {
      resizeObserver.disconnect()
      cancelAnimationFrame(rafId)
    }
  }, [])

  // Show loading state
  if (!isReady) {
    return (
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#1a1a2e',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#666',
        }}
      >
        Initializing viewport...
      </div>
    )
  }

  // Show error state
  if (error) {
    return (
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '100%',
          backgroundColor: '#1a1a2e',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#ff6b6b',
          padding: '16px',
          textAlign: 'center',
        }}
      >
        Inset Error: {error}
      </div>
    )
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      <iframe
        ref={iframeRef}
        src={iframeSrc}
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          display: 'block',
        }}
        // Security: allow scripts and same-origin access for postMessage
        // Disallow other potentially dangerous capabilities
        sandbox="allow-scripts allow-same-origin"
        title={`Inset viewport ${viewportId}`}
      />
      {/* Loading overlay until iframe reports ready */}
      {!iframeReady && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(26, 26, 46, 0.9)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#888',
          }}
        >
          Loading inset viewer...
        </div>
      )}
    </div>
  )
}

export default InsetCesiumViewer
