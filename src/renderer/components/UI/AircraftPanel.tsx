import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useActiveViewportCamera } from '../../hooks/useActiveViewportCamera'
import { useAircraftFiltering } from '../../hooks/useAircraftFiltering'
import { useAircraftInterpolation } from '../../hooks/useAircraftInterpolation'
import { useAircraftPanelDrag } from '../../hooks/useAircraftPanelDrag'
import { markAircraftPanelDockUserOverride } from '../../hooks/useTabletDockBehavior'
import { geoidService } from '../../services/GeoidService'
import { useAircraftFilterStore } from '../../stores/aircraftFilterStore'
import { useAirportStore } from '../../stores/airportStore'
import { useRunwayStore } from '../../stores/runwayStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useVnasStore } from '../../stores/vnasStore'
import { applyPositionOffsets } from '../../utils/cameraGeometry'
import { calculateBearing, calculateDistanceNM } from '../../utils/geoMath'
import {
  calculateSmartSort,
  clearPhaseHistory,
  type FlightPhase,
  getPhaseLabel,
  getTierClass,
  type PriorityTier,
  type SmartSortContext,
} from '../../utils/smartSort'
import { formatAltitude, formatGroundspeed, formatHeading, getTowerPosition } from '../../utils/towerHeight'
import './AircraftPanel.css'

type SortOption = 'smart' | 'distance' | 'cameraDistance' | 'callsign' | 'altitude' | 'speed'

interface AircraftListItem {
  callsign: string
  aircraftType: string | null
  altitude: number
  groundspeed: number
  heading: number
  distance: number
  cameraDistance: number // Distance from camera position (includes WASD offsets)
  bearing: number
  departure: string | null
  arrival: string | null
  // Smart sort fields
  phase: FlightPhase | null
  tier: PriorityTier | null
  runway: string | null
  score: number
  // Display delay in milliseconds
  displayDelay: number
}

// Minimum and maximum panel dimensions
const MIN_PANEL_WIDTH = 180
const MAX_PANEL_WIDTH = 500
const MIN_PANEL_HEIGHT = 200
const MAX_PANEL_HEIGHT = 1200

function AircraftPanel() {
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const showAircraftPanel = useSettingsStore((state) => state.ui.showAircraftPanel)
  const showWeatherEffects = useSettingsStore((state) => state.weather.showWeatherEffects)
  const pinFollowedAircraftToTop = useSettingsStore((state) => state.aircraft.pinFollowedAircraftToTop)

  // Panel dimensions and dock state from settings
  const panelWidth = useSettingsStore((state) => state.ui.aircraftPanelWidth)
  const panelHeight = useSettingsStore((state) => state.ui.aircraftPanelHeight)
  const dockSide = useSettingsStore((state) => state.ui.aircraftPanelDockSide)
  const edgeDocked = useSettingsStore((state) => state.ui.aircraftPanelEdgeDocked)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)

  // Ref needed by the drag hook for height clamping
  const panelRef = useRef<HTMLDivElement>(null)

  // Panel filter state from store (affects both list and datablocks)
  const searchQuery = useAircraftFilterStore((state) => state.searchQuery)
  const setSearchQuery = useAircraftFilterStore((state) => state.setSearchQuery)
  const filterWeatherVisibility = useAircraftFilterStore((state) => state.filterWeatherVisibility)
  const setFilterWeatherVisibility = useAircraftFilterStore((state) => state.setFilterWeatherVisibility)
  const filterAirportTraffic = useAircraftFilterStore((state) => state.filterAirportTraffic)
  const setFilterAirportTraffic = useAircraftFilterStore((state) => state.setFilterAirportTraffic)

  // Runway data for smart sort
  const getRunwaysWithCoordinates = useRunwayStore((state) => state.getRunwaysWithCoordinates)
  const runwaysLoaded = useRunwayStore((state) => state.isLoaded)

  // vNAS state for header badge
  const vnasConnected = useVnasStore((state) => state.status.state === 'connected')

  // Local state for sorting (UI-only, doesn't affect filtering). The
  // expand/collapse state moved to settingsStore.aircraftPanelEdgeDocked
  // so the dock strip and panel can share a single source of truth.
  const [sortOption, setSortOption] = useState<SortOption>('smart')

  // Drag-to-reposition (works on touch as well as mouse)
  const { position: dragPosition, isDragging, handlers: dragHandlers } = useAircraftPanelDrag(panelRef)

  // Resize state
  const [isResizing, setIsResizing] = useState<'width' | 'height' | 'corner' | null>(null)
  const resizeStartRef = useRef<{ startX: number; startY: number; startWidth: number; startHeight: number } | null>(
    null,
  )

  // Resize handlers using pointer events (works for both mouse and touch)
  const handleResizeStart = useCallback(
    (e: React.PointerEvent, direction: 'width' | 'height' | 'corner') => {
      e.preventDefault()
      e.stopPropagation()
      setIsResizing(direction)
      resizeStartRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        startWidth: panelWidth,
        startHeight: panelHeight || 400, // Use 400 as default if height is 0 (auto)
      }
      // Capture pointer to continue receiving events even if pointer leaves element
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    },
    [panelWidth, panelHeight],
  )

  const handleResizeMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isResizing || !resizeStartRef.current) return

      const { startX, startY, startWidth, startHeight } = resizeStartRef.current
      // The width-resize handle lives on the inner edge: left of the panel
      // when right-docked, right of the panel when left-docked. Dragging the
      // handle inward (toward the center of the screen) should always grow
      // the panel — invert the cursor-delta sign on left-dock to match.
      const deltaX = dockSide === 'right' ? startX - e.clientX : e.clientX - startX
      const deltaY = e.clientY - startY

      if (isResizing === 'width' || isResizing === 'corner') {
        const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, startWidth + deltaX))
        updateUISettings({ aircraftPanelWidth: newWidth })
      }

      if (isResizing === 'height' || isResizing === 'corner') {
        const newHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, startHeight + deltaY))
        updateUISettings({ aircraftPanelHeight: newHeight })
      }
    },
    [isResizing, updateUISettings, dockSide],
  )

  const handleResizeEnd = useCallback(
    (e: React.PointerEvent) => {
      if (isResizing) {
        ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
        setIsResizing(null)
        resizeStartRef.current = null
      }
    },
    [isResizing],
  )

  // Periodic refresh to update distances/bearings every second.
  // refreshTick is read in the nearbyAircraft useMemo deps below — it forces re-sort against
  // freshly-interpolated aircraft positions even when no Zustand-tracked input changed.
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    const interval = setInterval(() => setRefreshTick((t) => t + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  // Clear phase history when airport changes to prevent memory leaks.
  // The phase history is a module-level Map in flightPhaseDetector.ts that grows unbounded
  // as aircraft come and go; without this clear, switching airports leaks the prior airport's history.
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentAirport?.icao is the trigger for the side-effect, not read by the body
  useEffect(() => {
    clearPhaseHistory()
  }, [currentAirport?.icao])

  // Tower height for look-at pitch calculation
  const towerHeight = useAirportStore((state) => state.towerHeight)

  // Active viewport camera for follow functionality and look-at
  const {
    followingCallsign,
    followAircraft,
    stopFollowing,
    followMode,
    toggleFollowMode,
    lookAtPosition,
    positionOffsetX,
    positionOffsetY,
    positionOffsetZ,
  } = useActiveViewportCamera()

  // Custom tower position for bearing calculation
  const customTowerPosition = useAirportStore((state) => state.customTowerPosition)

  // Get interpolated aircraft data (shared single source)
  const interpolatedAircraft = useAircraftInterpolation()

  // Use shared filtering hook (affects both list and datablocks)
  const { filtered, referencePoint } = useAircraftFiltering(interpolatedAircraft)

  // Build smart sort context when airport is selected
  const smartSortContext = useMemo((): SmartSortContext | null => {
    if (!currentAirport || !runwaysLoaded) return null
    const runways = getRunwaysWithCoordinates(currentAirport.icao)
    return {
      airportLat: currentAirport.lat,
      airportLon: currentAirport.lon,
      airportElevationFt: currentAirport.elevation,
      runways,
      icao: currentAirport.icao,
    }
  }, [currentAirport, runwaysLoaded, getRunwaysWithCoordinates])

  // Calculate bearing and convert to AircraftListItem format with sorting.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshTick is bumped every 1s to force re-evaluation against freshly-interpolated positions even when no upstream Zustand state changed
  const nearbyAircraft = useMemo((): AircraftListItem[] => {
    if (!referencePoint) return []

    // Calculate camera position (tower + WASD offsets) for camera distance sorting
    let cameraLat = referencePoint.lat
    let cameraLon = referencePoint.lon
    let cameraAltMeters = referencePoint.elevationMeters + towerHeight
    if (currentAirport) {
      const towerPos = getTowerPosition(currentAirport, towerHeight, customTowerPosition ?? undefined)
      const cameraPos = applyPositionOffsets(
        { latitude: towerPos.latitude, longitude: towerPos.longitude, height: towerPos.height },
        { x: positionOffsetX, y: positionOffsetY, z: positionOffsetZ },
      )
      cameraLat = cameraPos.latitude
      cameraLon = cameraPos.longitude
      cameraAltMeters = cameraPos.height
    }

    // Always calculate flight phase data when airport context available
    // (phase info is useful regardless of sort mode)
    const smartSortMap = new Map<
      string,
      { phase: FlightPhase; tier: PriorityTier; runway: string | null; score: number }
    >()
    if (smartSortContext) {
      const smartResults = calculateSmartSort(filtered, smartSortContext)
      for (const result of smartResults) {
        smartSortMap.set(result.callsign, {
          phase: result.phase,
          tier: result.tier,
          runway: result.runway,
          score: result.score,
        })
      }
    }

    const withBearing = filtered.map((aircraft) => {
      const smartData = smartSortMap.get(aircraft.callsign)
      // Convert ellipsoidal altitude to MSL for display (formatAltitude expects MSL meters)
      const altitudeMsl = geoidService.ellipsoidalToMsl(
        aircraft.interpolatedLatitude,
        aircraft.interpolatedLongitude,
        aircraft.interpolatedAltitude,
      )
      return {
        callsign: aircraft.callsign,
        aircraftType: aircraft.aircraftType,
        altitude: altitudeMsl, // MSL in METERS (formatAltitude handles conversion to feet)
        groundspeed: aircraft.interpolatedGroundspeed,
        heading: aircraft.interpolatedHeading,
        distance: aircraft.distance,
        cameraDistance: calculateDistanceNM(
          cameraLat,
          cameraLon,
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude,
          cameraAltMeters,
          aircraft.interpolatedAltitude,
        ),
        bearing: calculateBearing(
          referencePoint.lat,
          referencePoint.lon,
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude,
        ),
        departure: aircraft.departure,
        arrival: aircraft.arrival,
        phase: smartData?.phase || null,
        tier: smartData?.tier || null,
        runway: smartData?.runway || null,
        score: smartData?.score || 0,
        displayDelay: aircraft.displayDelay,
      }
    })

    // Apply sorting (UI-only, doesn't affect filtering)
    const sorted = withBearing.sort((a, b) => {
      // Pin followed aircraft to the top (if enabled)
      if (pinFollowedAircraftToTop) {
        if (a.callsign === followingCallsign) return -1
        if (b.callsign === followingCallsign) return 1
      }

      // Apply normal sorting for non-followed aircraft
      switch (sortOption) {
        case 'smart':
          return b.score - a.score // Highest priority first
        case 'callsign':
          return a.callsign.localeCompare(b.callsign)
        case 'altitude':
          return b.altitude - a.altitude // Highest first
        case 'speed':
          return b.groundspeed - a.groundspeed // Fastest first
        case 'cameraDistance':
          return a.cameraDistance - b.cameraDistance // Closest to camera first
        default:
          return a.distance - b.distance // Closest to airport first
      }
    })

    return sorted.slice(0, 50)
  }, [
    filtered,
    referencePoint,
    followingCallsign,
    sortOption,
    refreshTick,
    smartSortContext,
    pinFollowedAircraftToTop,
    currentAirport,
    towerHeight,
    customTowerPosition,
    positionOffsetX,
    positionOffsetY,
    positionOffsetZ,
  ])

  const handleFollowClick = (callsign: string) => {
    if (followingCallsign === callsign) {
      stopFollowing()
    } else {
      followAircraft(callsign)
    }
  }

  // Long-press on a row toggles follow on touch devices. Tap continues to
  // trigger look-at via the existing onClick handler. We track timer state
  // and finger movement so the long-press only fires on a sustained, stationary
  // touch, and we suppress the synthesized click that would otherwise still
  // trigger look-at after the user lifted their finger.
  const longPressTimerRef = useRef<number | null>(null)
  const longPressFiredRef = useRef(false)
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null)

  const cancelLongPressTimer = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  useEffect(
    () => () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
    },
    [],
  )

  const handleRowTouchStart = (e: React.TouchEvent<HTMLButtonElement>, callsign: string) => {
    if (e.touches.length !== 1) {
      cancelLongPressTimer()
      return
    }
    cancelLongPressTimer()
    const touch = e.touches[0]
    touchStartPosRef.current = { x: touch.clientX, y: touch.clientY }
    longPressFiredRef.current = false
    longPressTimerRef.current = window.setTimeout(() => {
      longPressFiredRef.current = true
      navigator.vibrate?.(10)
      handleFollowClick(callsign)
    }, 500)
  }

  const handleRowTouchMove = (e: React.TouchEvent<HTMLButtonElement>) => {
    if (!touchStartPosRef.current || longPressTimerRef.current === null) return
    const touch = e.touches[0]
    const dx = touch.clientX - touchStartPosRef.current.x
    const dy = touch.clientY - touchStartPosRef.current.y
    if (Math.hypot(dx, dy) > 10) {
      cancelLongPressTimer()
    }
  }

  const handleRowTouchEnd = (e: React.TouchEvent<HTMLButtonElement>) => {
    cancelLongPressTimer()
    if (longPressFiredRef.current) {
      e.preventDefault()
      longPressFiredRef.current = false
    }
    touchStartPosRef.current = null
  }

  /**
   * Look at an aircraft without engaging follow mode.
   * Smoothly animates the camera heading and pitch to center the aircraft on screen.
   * Uses lookAtPosition() which calculates heading/pitch from the active viewport's
   * actual camera position (tower + WASD offsets), enabling proper inset support.
   */
  const handleLookAt = (aircraft: AircraftListItem) => {
    // Get the aircraft's current interpolated position (real-time, not cached)
    const currentAircraft = interpolatedAircraft.get(aircraft.callsign)
    if (!currentAircraft) return

    // Use lookAtPosition with geographic coordinates - it will:
    // 1. Calculate heading/pitch from the active viewport's camera position (including offsets)
    // 2. Set pendingLookAtPosition so insets can calculate their own heading/pitch
    lookAtPosition(
      currentAircraft.interpolatedLatitude,
      currentAircraft.interpolatedLongitude,
      currentAircraft.interpolatedAltitude * 3.28084, // Convert meters to feet
    )
  }

  if (!showAircraftPanel || edgeDocked) return null

  // Compute anchor offset CSS. Position values are offsets from the panel's
  // docked anchor corner — positive x is always inward (away from the docked
  // edge), so the same value mirrors symmetrically when dockSide flips.
  const anchorTop = `calc(var(--topbar-h) + 10px + ${dragPosition.y}px)`
  const anchorEdgePx = 10 + dragPosition.x
  const panelStyle: React.CSSProperties = {
    width: panelWidth,
    top: anchorTop,
    ...(dockSide === 'right' ? { right: anchorEdgePx, left: 'auto' } : { left: anchorEdgePx, right: 'auto' }),
    ...(panelHeight > 0 ? { height: panelHeight, maxHeight: 'none' } : {}),
  }

  const dockToEdge = () => {
    markAircraftPanelDockUserOverride()
    updateUISettings({ aircraftPanelEdgeDocked: true })
  }

  return (
    <div
      ref={panelRef}
      className={`aircraft-panel ${isResizing ? 'resizing' : ''} ${isDragging ? 'dragging' : ''}`}
      data-dock-side={dockSide}
      style={panelStyle}
    >
      {/* Width-resize handle on the inner edge (left of right-docked, right of left-docked) */}
      <div
        className="resize-handle resize-handle-width"
        onPointerDown={(e) => handleResizeStart(e, 'width')}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        title="Drag to resize width"
      />

      {/* Bottom edge resize handle (for height) */}
      <div
        className="resize-handle resize-handle-bottom"
        onPointerDown={(e) => handleResizeStart(e, 'height')}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        title="Drag to resize height"
      />

      {/* Bottom-inner corner resize handle (for both) */}
      <div
        className="resize-handle resize-handle-corner"
        onPointerDown={(e) => handleResizeStart(e, 'corner')}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        title="Drag to resize"
      />

      <div
        className="panel-header"
        onPointerDown={dragHandlers.onPointerDown}
        onPointerMove={dragHandlers.onPointerMove}
        onPointerUp={dragHandlers.onPointerUp}
        onPointerCancel={dragHandlers.onPointerCancel}
      >
        <div className="header-left">
          <h3>Nearby Aircraft</h3>
          {vnasConnected && (
            <span className="data-source-badge live" title="Receiving 1Hz live updates via vNAS">
              <svg aria-hidden="true" width="6" height="6" viewBox="0 0 6 6">
                <circle cx="3" cy="3" r="3" fill="currentColor" />
              </svg>
              1s
            </span>
          )}
          {!vnasConnected && (
            <span className="data-source-badge fallback" title="Using 15-second VATSIM polling">
              15s
            </span>
          )}
        </div>
        <div className="header-right">
          <span className="aircraft-count">{nearbyAircraft.length}</span>
          <button type="button" className="collapse-btn" onClick={dockToEdge} title="Dock to edge">
            <svg
              aria-hidden="true"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              {dockSide === 'right' ? <polyline points="9 18 15 12 9 6" /> : <polyline points="15 18 9 12 15 6" />}
            </svg>
          </button>
        </div>
      </div>

      <div className="panel-controls">
        <input
          type="text"
          className="search-input"
          placeholder="Search callsign, type, route (affects map)..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <div className="filter-controls">
          <button
            type="button"
            className={`filter-btn ${filterWeatherVisibility ? 'active' : ''}`}
            onClick={() => setFilterWeatherVisibility(!filterWeatherVisibility)}
            title="Only show aircraft visible through weather (affects both list and map)"
            disabled={!showWeatherEffects}
          >
            Visible
          </button>
          <button
            type="button"
            className={`filter-btn ${filterAirportTraffic ? 'active' : ''}`}
            onClick={() => setFilterAirportTraffic(!filterAirportTraffic)}
            title="Only show aircraft departing from or arriving at this airport (affects both list and map)"
            disabled={!currentAirport}
          >
            {currentAirport?.icao || 'Airport'}
          </button>
        </div>
        <div className="sort-controls">
          <span className="sort-label">Sort:</span>
          <select
            className="sort-select"
            value={sortOption}
            onChange={(e) => setSortOption(e.target.value as SortOption)}
          >
            <option value="smart">Smart</option>
            <option value="distance">Distance (Airport)</option>
            <option value="cameraDistance">Distance (Camera)</option>
            <option value="callsign">Callsign</option>
            <option value="altitude">Altitude</option>
            <option value="speed">Speed</option>
          </select>
        </div>
      </div>

      {followingCallsign && (
        <div className="following-indicator">
          <div className="following-info">
            <span className="following-label">Following</span>
            <span className="following-callsign">{followingCallsign}</span>
          </div>
          <button
            type="button"
            className={`follow-mode-btn ${followMode}`}
            onClick={toggleFollowMode}
            title="Toggle follow mode (O)"
          >
            {followMode === 'tower' ? 'Tower' : 'Orbit'}
          </button>
          <button type="button" className="stop-following-btn" onClick={() => stopFollowing()}>
            Stop (Esc)
          </button>
        </div>
      )}

      <div className="aircraft-list">
        {nearbyAircraft.length === 0 ? (
          <div className="no-aircraft">
            {currentAirport ? 'No aircraft nearby' : 'Select an airport or search globally (Ctrl+K)'}
          </div>
        ) : (
          nearbyAircraft.map((aircraft) => {
            const isFollowing = followingCallsign === aircraft.callsign
            const phaseLabel = aircraft.phase ? getPhaseLabel(aircraft.phase) : null
            const tierClass = aircraft.tier ? getTierClass(aircraft.tier) : ''
            return (
              <button
                type="button"
                key={aircraft.callsign}
                className={`aircraft-item ${isFollowing ? 'following' : ''} ${tierClass} clickable`}
                onClick={() => handleLookAt(aircraft)}
                onTouchStart={(e) => handleRowTouchStart(e, aircraft.callsign)}
                onTouchMove={handleRowTouchMove}
                onTouchEnd={handleRowTouchEnd}
                onTouchCancel={handleRowTouchEnd}
                title="Tap to look at aircraft · long-press to toggle follow"
              >
                <div className="aircraft-header">
                  <div className="callsign-group">
                    <span
                      className="live-indicator"
                      title={`Display delay: ${(aircraft.displayDelay / 1000).toFixed(1)}s`}
                    >
                      <svg aria-hidden="true" width="6" height="6" viewBox="0 0 6 6">
                        <circle cx="3" cy="3" r="3" fill={aircraft.displayDelay < 3000 ? '#0c7' : '#fc0'} />
                      </svg>
                    </span>
                    <span className="callsign">{aircraft.callsign}</span>
                    <span className="aircraft-type">{aircraft.aircraftType || '???'}</span>
                    {phaseLabel && (
                      <span className={`phase-badge ${tierClass}`}>
                        {phaseLabel}
                        {aircraft.runway && <span className="runway-ident"> {aircraft.runway}</span>}
                      </span>
                    )}
                  </div>
                  <div className="aircraft-header-right">
                    <button
                      type="button"
                      className={`follow-btn ${isFollowing ? 'active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation() // Don't trigger look-at
                        handleFollowClick(aircraft.callsign)
                      }}
                      title={isFollowing ? 'Stop following' : 'Follow aircraft'}
                    >
                      {isFollowing ? (
                        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="12" cy="12" r="10" />
                        </svg>
                      ) : (
                        <svg
                          aria-hidden="true"
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <circle cx="12" cy="12" r="10" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                      )}
                    </button>
                  </div>
                </div>

                <div className="aircraft-details">
                  <div className="detail-row">
                    <span className="label">ALT</span>
                    <span className="value">{formatAltitude(aircraft.altitude)}</span>
                  </div>
                  <div className="detail-row">
                    <span className="label">GS</span>
                    <span className="value">{formatGroundspeed(aircraft.groundspeed)}</span>
                  </div>
                  <div className="detail-row">
                    <span className="label">HDG</span>
                    <span className="value">{formatHeading(aircraft.heading)}</span>
                  </div>
                </div>

                <div className="aircraft-position">
                  <span className="distance">{aircraft.distance.toFixed(1)} nm</span>
                  <span className="bearing">{Math.round(aircraft.bearing).toString().padStart(3, '0')}°</span>
                </div>

                {(aircraft.departure && aircraft.departure !== 'null') ||
                (aircraft.arrival && aircraft.arrival !== 'null') ? (
                  <div className="aircraft-route">
                    <span className="route-from">
                      {aircraft.departure && aircraft.departure !== 'null' ? aircraft.departure : '????'}
                    </span>
                    <span className="route-arrow">→</span>
                    <span className="route-to">
                      {aircraft.arrival && aircraft.arrival !== 'null' ? aircraft.arrival : '????'}
                    </span>
                  </div>
                ) : null}
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}

export default AircraftPanel
