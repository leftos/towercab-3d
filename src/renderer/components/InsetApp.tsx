/**
 * Minimal React app for inset iframes
 *
 * This component renders an isolated CesiumViewer that receives data from
 * the main app via SharedWorker and communicates camera changes back via
 * postMessage.
 *
 * Features:
 * - CesiumViewer with isInset=true (reduced quality settings)
 * - Receives aircraft, settings, weather, token from SharedWorker
 * - Sends camera state changes to parent via postMessage
 * - Handles follow mode and aircraft selection
 * - No UI chrome (no settings panels, command input, etc.)
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useInsetStoreSync } from '../hooks/useInsetStoreSync'
import { enableObservationAutoFeed, useSharedWorkerConsumer } from '../hooks/useSharedWorkerConsumer'
import { useViewportStore } from '../stores/viewportStore'
import type { CameraStateUpdate } from '../types/shared-worker'
import CesiumViewer from './CesiumViewer/CesiumViewer'

// Enable automatic feeding of observations to the timeline store
// This allows the inset to interpolate aircraft positions locally
enableObservationAutoFeed()

interface InsetAppProps {
  viewportId: string
  parentOrigin: string
}

/**
 * Message types sent from inset to parent
 */
interface InsetToParentMessage {
  type: 'inset-ready' | 'inset-focus' | 'camera-change' | 'aircraft-select' | 'follow-request' | 'error'
  viewportId: string
  payload?: unknown
  /** When true, manipulation has ended and this is the final state to persist */
  final?: boolean
}

/**
 * Message types received from parent
 */
interface ParentToInsetMessage {
  type: 'camera-update' | 'follow-aircraft' | 'stop-following' | 'settings-override' | 'set-activated' | 'request-focus'
  viewportId: string
  payload?: unknown
}

function InsetApp({ viewportId, parentOrigin }: InsetAppProps) {
  const [error, setError] = useState<string | null>(null)
  const [cesiumReady, setCesiumReady] = useState(false)
  // Track whether this inset is the activated viewport in the parent
  // Only process camera input when activated
  const [isActivatedByParent, setIsActivatedByParent] = useState(false)

  // Get settings/weather/token/airport/imagery from SharedWorker
  // Aircraft observations are automatically fed to the timeline store via enableObservationAutoFeed()
  const { settings, weather, cesiumToken, imagery, airport, connected } = useSharedWorkerConsumer(viewportId)

  // Sync SharedWorker data to local stores (settings, weather, airport, imagery)
  // Aircraft data is handled by useSharedWorkerConsumer -> timeline store
  const { isReady: storesReady } = useInsetStoreSync({
    settings,
    weather,
    cesiumToken,
    imagery,
    airport,
  })

  // Track if we've initialized the viewport
  const viewportInitializedRef = useRef(false)
  // Track last sent camera state to avoid redundant updates
  const lastSentCameraRef = useRef<string>('')
  // Track mouse/pointer button state for manipulation detection
  const isManipulatingRef = useRef(false)
  // Store pending camera update to send when manipulation ends
  const pendingCameraUpdateRef = useRef<CameraStateUpdate | null>(null)

  // Send messages to parent window via postMessage
  const sendToParent = useCallback(
    (message: InsetToParentMessage) => {
      try {
        window.parent.postMessage(message, parentOrigin)
      } catch (err) {
        console.error('[InsetApp] Failed to post message to parent:', err)
      }
    },
    [parentOrigin],
  )

  // Initialize viewport in local viewportStore when component mounts
  // The inset's viewportStore may have rehydrated state from localStorage (shared with main app)
  // so we need to ensure our viewport exists and is active
  useEffect(() => {
    if (viewportInitializedRef.current) return

    // Check if viewport already exists
    const existingViewports = useViewportStore.getState().viewports
    const hasViewport = existingViewports.some((v) => v.id === viewportId)

    if (!hasViewport) {
      // Create a viewport entry for this inset
      // We use setState directly to avoid the addViewport logic which generates new IDs
      useViewportStore.setState((state) => ({
        viewports: [
          ...state.viewports,
          {
            id: viewportId,
            layout: { x: 0, y: 0, width: 1, height: 1, zIndex: 0 },
            cameraState: {
              viewMode: '3d' as const,
              heading: 0,
              pitch: -15,
              fov: 60,
              positionOffsetX: 0,
              positionOffsetY: 0,
              positionOffsetZ: 0,
              topdownAltitude: 5000,
              followingCallsign: null,
              followMode: 'tower' as const,
              followZoom: 1,
              preFollowState: null,
              orbitDistance: 500,
              orbitHeading: 0,
              orbitPitch: -20,
              lookAtTarget: null,
              pendingLookAtPosition: null,
              cameraVersion: 0,
              savedMode3dState: null,
              savedMode2dState: null,
            },
            label: `Inset ${viewportId.slice(0, 8)}`,
          },
        ],
        activeViewportId: viewportId,
      }))
    } else {
      // Viewport exists (from rehydrated state), just ensure it's active
      useViewportStore.setState({ activeViewportId: viewportId })
    }

    viewportInitializedRef.current = true
  }, [viewportId])

  // Keep this viewport active - the inset's viewportStore may get state updates
  // from rehydration or other effects that could change activeViewportId
  // This ensures keyboard events always work in this inset
  useEffect(() => {
    const unsubscribe = useViewportStore.subscribe(
      (state) => state.activeViewportId,
      (activeId) => {
        // If activeViewportId changed to something else, reset it to this viewport
        if (activeId !== viewportId) {
          useViewportStore.setState({ activeViewportId: viewportId })
        }
      },
    )
    return unsubscribe
  }, [viewportId])

  // Track manipulation state via document-level mouse/pointer events
  useEffect(() => {
    const handlePointerDown = () => {
      isManipulatingRef.current = true
    }

    const handlePointerUp = () => {
      isManipulatingRef.current = false
      // Send any pending camera update as final when manipulation ends
      if (pendingCameraUpdateRef.current) {
        sendToParent({
          type: 'camera-change',
          viewportId,
          payload: pendingCameraUpdateRef.current,
          final: true,
        })
        pendingCameraUpdateRef.current = null
      }
    }

    // Use capture phase to catch events before Cesium
    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('pointerup', handlePointerUp, true)
    document.addEventListener('pointercancel', handlePointerUp, true)
    // Also handle mouse events as fallback
    document.addEventListener('mousedown', handlePointerDown, true)
    document.addEventListener('mouseup', handlePointerUp, true)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('pointerup', handlePointerUp, true)
      document.removeEventListener('pointercancel', handlePointerUp, true)
      document.removeEventListener('mousedown', handlePointerDown, true)
      document.removeEventListener('mouseup', handlePointerUp, true)
    }
  }, [viewportId, sendToParent])

  // Subscribe to camera state changes and send to main app
  useEffect(() => {
    const unsubscribe = useViewportStore.subscribe((state, prevState) => {
      // Find this viewport's camera state
      const viewport = state.viewports.find((v) => v.id === viewportId)
      const prevViewport = prevState.viewports.find((v) => v.id === viewportId)

      if (!viewport || !prevViewport) return

      const camera = viewport.cameraState
      const prevCamera = prevViewport.cameraState

      // Check if camera state actually changed
      const cameraKey = JSON.stringify({
        heading: camera.heading,
        pitch: camera.pitch,
        fov: camera.fov,
        positionOffsetX: camera.positionOffsetX,
        positionOffsetY: camera.positionOffsetY,
        positionOffsetZ: camera.positionOffsetZ,
        followingCallsign: camera.followingCallsign,
        followMode: camera.followMode,
        orbitDistance: camera.orbitDistance,
        orbitHeading: camera.orbitHeading,
        orbitPitch: camera.orbitPitch,
      })

      if (cameraKey === lastSentCameraRef.current) return
      lastSentCameraRef.current = cameraKey

      // Build update object with only changed fields
      const updates: CameraStateUpdate = {}
      if (camera.heading !== prevCamera.heading) updates.heading = camera.heading
      if (camera.pitch !== prevCamera.pitch) updates.pitch = camera.pitch
      if (camera.fov !== prevCamera.fov) updates.fov = camera.fov
      if (camera.positionOffsetX !== prevCamera.positionOffsetX) updates.positionOffsetX = camera.positionOffsetX
      if (camera.positionOffsetY !== prevCamera.positionOffsetY) updates.positionOffsetY = camera.positionOffsetY
      if (camera.positionOffsetZ !== prevCamera.positionOffsetZ) updates.positionOffsetZ = camera.positionOffsetZ
      if (camera.followingCallsign !== prevCamera.followingCallsign)
        updates.followingCallsign = camera.followingCallsign
      if (camera.orbitDistance !== prevCamera.orbitDistance) updates.orbitDistance = camera.orbitDistance
      if (camera.orbitHeading !== prevCamera.orbitHeading) updates.orbitHeading = camera.orbitHeading
      if (camera.orbitPitch !== prevCamera.orbitPitch) updates.orbitPitch = camera.orbitPitch

      // Only send if there are actual changes
      if (Object.keys(updates).length > 0) {
        if (isManipulatingRef.current) {
          // During manipulation, store update but don't mark as final
          pendingCameraUpdateRef.current = { ...pendingCameraUpdateRef.current, ...updates }
          sendToParent({
            type: 'camera-change',
            viewportId,
            payload: updates,
            final: false,
          })
        } else {
          // Not manipulating (e.g., keyboard input, follow mode) - send as final immediately
          sendToParent({
            type: 'camera-change',
            viewportId,
            payload: updates,
            final: true,
          })
        }
      }
    })

    return () => unsubscribe()
  }, [viewportId, sendToParent])

  // Handle aircraft selection in this inset (for future use)
  const _handleAircraftSelect = useCallback(
    (callsign: string) => {
      sendToParent({
        type: 'aircraft-select',
        viewportId,
        payload: { callsign },
      })
    },
    [viewportId, sendToParent],
  )

  // Handle follow request - updates viewportStore which triggers camera sync
  const _handleFollowRequest = useCallback(
    (callsign: string) => {
      useViewportStore.getState().followAircraft(callsign)
      sendToParent({
        type: 'follow-request',
        viewportId,
        payload: { callsign },
      })
    },
    [viewportId, sendToParent],
  )

  // Listen for messages from parent
  useEffect(() => {
    const handleMessage = (event: MessageEvent<ParentToInsetMessage>) => {
      // Verify origin
      if (event.origin !== parentOrigin) return

      const { type, viewportId: msgViewportId, payload } = event.data

      // Ignore messages for other viewports
      if (msgViewportId !== viewportId) return

      const store = useViewportStore.getState()

      switch (type) {
        case 'camera-update':
          // Parent is updating our camera state (e.g., loading bookmark, follow aircraft, look at runway)
          if (payload && typeof payload === 'object') {
            const updates = payload as CameraStateUpdate & {
              followingCallsign?: string | null
              followMode?: 'tower' | 'orbit'
              pendingLookAtPosition?: { lat: number; lon: number; altitudeFt: number } | null
              orbitDistance?: number
              orbitHeading?: number
              orbitPitch?: number
            }

            // Handle following state changes
            if ('followingCallsign' in updates) {
              if (updates.followingCallsign) {
                // Start following - use followMode if specified
                if (updates.followMode === 'orbit') {
                  store.followAircraftInOrbit(updates.followingCallsign)
                } else {
                  store.followAircraft(updates.followingCallsign)
                }
              } else {
                // Stop following
                store.stopFollowing()
              }
            }

            // Handle look-at position - the inset calculates its own heading/pitch
            // from the geographic coordinates based on its camera position
            let hasLookAtPosition = false
            if ('pendingLookAtPosition' in updates) {
              if (updates.pendingLookAtPosition) {
                const { lat, lon, altitudeFt } = updates.pendingLookAtPosition
                store.lookAtPosition(lat, lon, altitudeFt)
                hasLookAtPosition = true
              } else {
                store.clearLookAtTarget()
              }
            }

            // Handle basic camera parameters
            // Skip heading/pitch when processing a look-at position - the inset calculates
            // its own heading/pitch from the geographic coordinates, so we don't want to
            // overwrite them with the main app's values (which might be stale/different)
            if (!hasLookAtPosition) {
              if (updates.heading !== undefined) store.setHeading(updates.heading)
              if (updates.pitch !== undefined) store.setPitch(updates.pitch)
            }
            if (updates.fov !== undefined) store.setFov(updates.fov)

            // Handle position offsets (camera 6DOF position)
            if (updates.positionOffsetX !== undefined) store.setPositionOffsetX(updates.positionOffsetX)
            if (updates.positionOffsetY !== undefined) store.setPositionOffsetY(updates.positionOffsetY)
            if (updates.positionOffsetZ !== undefined) store.setPositionOffsetZ(updates.positionOffsetZ)

            // Handle orbit parameters
            if (updates.orbitDistance !== undefined) store.setOrbitDistance(updates.orbitDistance)
            if (updates.orbitHeading !== undefined) store.setOrbitHeading(updates.orbitHeading)
            if (updates.orbitPitch !== undefined) store.setOrbitPitch(updates.orbitPitch)
          }
          break

        case 'follow-aircraft':
          // Parent wants us to follow an aircraft
          if (payload && typeof payload === 'object' && 'callsign' in payload) {
            store.followAircraft((payload as { callsign: string }).callsign)
          }
          break

        case 'stop-following':
          // Parent wants us to stop following
          store.stopFollowing()
          break

        case 'set-activated':
          // Parent is telling us whether we're the activated viewport
          if (payload && typeof payload === 'object' && 'activated' in payload) {
            const activated = (payload as { activated: boolean }).activated
            setIsActivatedByParent(activated)
            // Ensure this iframe has keyboard focus when activated
            if (activated) {
              window.focus()
            }
          }
          break

        case 'request-focus':
          // Parent is requesting we focus this iframe (e.g., after a UI action targeted this inset)
          window.focus()
          break
      }
    }

    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [viewportId, parentOrigin])

  // Report errors to parent
  useEffect(() => {
    if (error) {
      sendToParent({
        type: 'error',
        viewportId,
        payload: { error },
      })
    }
  }, [error, viewportId, sendToParent])

  // Notify parent when viewer is ready (with guard against duplicate calls)
  const viewerReadyRef = useRef(false)
  const handleViewerReady = useCallback(() => {
    if (viewerReadyRef.current) return
    viewerReadyRef.current = true
    setCesiumReady(true)
    sendToParent({
      type: 'inset-ready',
      viewportId,
    })
  }, [viewportId, sendToParent])

  // Handle errors from CesiumViewer
  // TODO: Wire up to CesiumViewer error events when error callback is added
  const _handleViewerError = useCallback((errorMsg: string) => {
    setError(errorMsg)
  }, [])

  // Notify parent when user interacts with the inset (for activation)
  const handleFocus = useCallback(() => {
    sendToParent({
      type: 'inset-focus',
      viewportId,
    })
  }, [viewportId, sendToParent])

  // Document-level focus detection - captures ALL interactions including Cesium canvas
  // This is needed because Cesium captures mouse events on its canvas
  useEffect(() => {
    // Send focus on any mousedown/touchstart in the document
    const handleDocumentInteraction = (_e: Event) => {
      // Always send focus when user interacts - the parent will debounce if needed
      // Don't skip based on hasSentFocusRef since that prevents re-activation after clicking elsewhere
      sendToParent({
        type: 'inset-focus',
        viewportId,
      })
    }

    // Listen for any interaction on the document using capture phase
    document.addEventListener('mousedown', handleDocumentInteraction, true)
    document.addEventListener('touchstart', handleDocumentInteraction, true)
    // Also listen for pointerdown which Cesium might use
    document.addEventListener('pointerdown', handleDocumentInteraction, true)

    return () => {
      document.removeEventListener('mousedown', handleDocumentInteraction, true)
      document.removeEventListener('touchstart', handleDocumentInteraction, true)
      document.removeEventListener('pointerdown', handleDocumentInteraction, true)
    }
  }, [viewportId, sendToParent])

  // Show loading state while waiting for SharedWorker connection and Cesium token
  if (!connected) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#1a1a2e',
          color: '#666',
        }}
      >
        Connecting to main app...
      </div>
    )
  }

  if (!cesiumToken) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#1a1a2e',
          color: '#666',
        }}
      >
        Waiting for Cesium token...
      </div>
    )
  }

  if (error) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#1a1a2e',
          color: '#ff6b6b',
        }}
      >
        Error: {error}
      </div>
    )
  }

  // Wait for stores to be synced before rendering CesiumViewer
  if (!storesReady) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: '#1a1a2e',
          color: '#666',
        }}
      >
        Initializing stores...
      </div>
    )
  }

  // Render the isolated CesiumViewer
  // The viewer uses local stores that are populated from SharedWorker data
  // Aircraft observations are received via SharedWorker and interpolated locally
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
      }}
      onMouseDown={handleFocus}
      onTouchStart={handleFocus}
    >
      <CesiumViewer
        viewportId={viewportId}
        isInset={true}
        isActivated={isActivatedByParent}
        onViewerReady={handleViewerReady}
      />
      {/* Loading overlay until Cesium is ready */}
      {!cesiumReady && (
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
          Loading Cesium viewer...
        </div>
      )}
    </div>
  )
}

export default InsetApp
