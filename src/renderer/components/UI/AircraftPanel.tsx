import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import { useAirportStore } from '../../stores/airportStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useAircraftFilterStore } from '../../stores/aircraftFilterStore'
import { useRunwayStore } from '../../stores/runwayStore'
import { useVnasStore } from '../../stores/vnasStore'
import { useActiveViewportCamera } from '../../hooks/useActiveViewportCamera'
import { useAircraftInterpolation } from '../../hooks/useAircraftInterpolation'
import { useAircraftFiltering } from '../../hooks/useAircraftFiltering'
import { calculateBearing, calculateDistanceNM } from '../../utils/interpolation'
import { formatAltitude, formatGroundspeed, formatHeading, getTowerPosition } from '../../utils/towerHeight'
import { applyPositionOffsets, calculatePitchToTarget } from '../../utils/cameraGeometry'
import {
  calculateSmartSort,
  clearPhaseHistory,
  getPhaseLabel,
  getTierClass,
  type FlightPhase,
  type PriorityTier,
  type SmartSortContext
} from '../../utils/smartSort'
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
  // Data source indicator
  isLive: boolean // True if receiving 1Hz vNAS updates
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

  // Panel dimensions from settings
  const panelWidth = useSettingsStore((state) => state.ui.aircraftPanelWidth)
  const panelHeight = useSettingsStore((state) => state.ui.aircraftPanelHeight)
  const updateUISettings = useSettingsStore((state) => state.updateUISettings)

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

  // vNAS state for live update indicator
  const vnasConnected = useVnasStore((state) => state.status.state === 'connected')
  const vnasAircraftStates = useVnasStore((state) => state.aircraftStates)

  // Local state for sorting and collapse (UI-only, doesn't affect filtering)
  const [sortOption, setSortOption] = useState<SortOption>('smart')
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Resize state
  const [isResizing, setIsResizing] = useState<'width' | 'height' | 'corner' | null>(null)
  const resizeStartRef = useRef<{ startX: number; startY: number; startWidth: number; startHeight: number } | null>(null)

  // Resize handlers using pointer events (works for both mouse and touch)
  const handleResizeStart = useCallback((
    e: React.PointerEvent,
    direction: 'width' | 'height' | 'corner'
  ) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(direction)
    resizeStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startWidth: panelWidth,
      startHeight: panelHeight || 400 // Use 400 as default if height is 0 (auto)
    }
    // Capture pointer to continue receiving events even if pointer leaves element
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }, [panelWidth, panelHeight])

  const handleResizeMove = useCallback((e: React.PointerEvent) => {
    if (!isResizing || !resizeStartRef.current) return

    const { startX, startY, startWidth, startHeight } = resizeStartRef.current
    const deltaX = startX - e.clientX // Inverted because dragging left should increase width
    const deltaY = e.clientY - startY

    if (isResizing === 'width' || isResizing === 'corner') {
      const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, startWidth + deltaX))
      updateUISettings({ aircraftPanelWidth: newWidth })
    }

    if (isResizing === 'height' || isResizing === 'corner') {
      const newHeight = Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, startHeight + deltaY))
      updateUISettings({ aircraftPanelHeight: newHeight })
    }
  }, [isResizing, updateUISettings])

  const handleResizeEnd = useCallback((e: React.PointerEvent) => {
    if (isResizing) {
      ;(e.target as HTMLElement).releasePointerCapture(e.pointerId)
      setIsResizing(null)
      resizeStartRef.current = null
    }
  }, [isResizing])

  // Periodic refresh to update distances/bearings (UI updates automatically via hook reactivity)
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    const interval = setInterval(() => setRefreshTick(t => t + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  // Clear phase history when airport changes to prevent memory leaks
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
    setLookAtTarget,
    positionOffsetX,
    positionOffsetY,
    positionOffsetZ
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
      icao: currentAirport.icao
    }
  }, [currentAirport, runwaysLoaded, getRunwaysWithCoordinates])

  // Calculate bearing and convert to AircraftListItem format with sorting
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
        { x: positionOffsetX, y: positionOffsetY, z: positionOffsetZ }
      )
      cameraLat = cameraPos.latitude
      cameraLon = cameraPos.longitude
      cameraAltMeters = cameraPos.height
    }

    // Always calculate flight phase data when airport context available
    // (phase info is useful regardless of sort mode)
    const smartSortMap = new Map<string, { phase: FlightPhase; tier: PriorityTier; runway: string | null; score: number }>()
    if (smartSortContext) {
      const smartResults = calculateSmartSort(filtered, smartSortContext)
      for (const result of smartResults) {
        smartSortMap.set(result.callsign, {
          phase: result.phase,
          tier: result.tier,
          runway: result.runway,
          score: result.score
        })
      }
    }

    const withBearing = filtered.map((aircraft) => {
      const smartData = smartSortMap.get(aircraft.callsign)
      return {
        callsign: aircraft.callsign,
        aircraftType: aircraft.aircraftType,
        altitude: aircraft.interpolatedAltitude,  // Keep in METERS (formatAltitude handles conversion)
        groundspeed: aircraft.interpolatedGroundspeed,
        heading: aircraft.interpolatedHeading,
        distance: aircraft.distance,
        cameraDistance: calculateDistanceNM(
          cameraLat,
          cameraLon,
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude,
          cameraAltMeters,
          aircraft.interpolatedAltitude
        ),
        bearing: calculateBearing(
          referencePoint.lat,
          referencePoint.lon,
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude
        ),
        departure: aircraft.departure,
        arrival: aircraft.arrival,
        phase: smartData?.phase || null,
        tier: smartData?.tier || null,
        runway: smartData?.runway || null,
        score: smartData?.score || 0,
        isLive: vnasAircraftStates.has(aircraft.callsign)
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
        case 'distance':
        default:
          return a.distance - b.distance // Closest to airport first
      }
    })

    return sorted.slice(0, 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshTick intentionally forces periodic recalculation of distances/bearings
  }, [filtered, referencePoint, followingCallsign, sortOption, refreshTick, smartSortContext, pinFollowedAircraftToTop, currentAirport, towerHeight, customTowerPosition, positionOffsetX, positionOffsetY, positionOffsetZ, vnasAircraftStates])


  const handleFollowClick = (callsign: string) => {
    if (followingCallsign === callsign) {
      stopFollowing()
    } else {
      followAircraft(callsign)
    }
  }

  /**
   * Look at an aircraft without engaging follow mode.
   * Smoothly animates the camera heading and pitch to center the aircraft on screen.
   * Uses the actual camera position (tower + WASD offsets) to calculate accurate bearing.
   */
  const handleLookAt = (aircraft: AircraftListItem) => {
    if (!currentAirport) return

    // Get the aircraft's current interpolated position (real-time, not cached)
    const currentAircraft = interpolatedAircraft.get(aircraft.callsign)
    if (!currentAircraft) return

    // Calculate actual camera position (tower + WASD offsets)
    // This matches how useCesiumCamera calculates the camera position
    const towerPos = getTowerPosition(currentAirport, towerHeight, customTowerPosition ?? undefined)
    const cameraPos = applyPositionOffsets(
      { latitude: towerPos.latitude, longitude: towerPos.longitude, height: towerPos.height },
      { x: positionOffsetX, y: positionOffsetY, z: positionOffsetZ }
    )

    // Calculate bearing from actual camera position to aircraft
    const bearing = calculateBearing(
      cameraPos.latitude,
      cameraPos.longitude,
      currentAircraft.interpolatedLatitude,
      currentAircraft.interpolatedLongitude
    )

    // Calculate pitch using the same function as follow mode
    // This properly calculates horizontal distance from camera to aircraft
    const pitch = calculatePitchToTarget(
      cameraPos.latitude,
      cameraPos.longitude,
      cameraPos.height,
      currentAircraft.interpolatedLatitude,
      currentAircraft.interpolatedLongitude,
      currentAircraft.interpolatedAltitude
    )

    // Clamp pitch to reasonable range
    const clampedPitch = Math.max(-60, Math.min(60, pitch))

    // Set the look-at target for smooth animation
    setLookAtTarget(bearing, clampedPitch)
  }

  if (!showAircraftPanel) return null

  // Calculate panel style with dynamic dimensions
  const panelStyle: React.CSSProperties = {
    width: panelWidth,
    ...(panelHeight > 0 && !isCollapsed ? { height: panelHeight, maxHeight: 'none' } : {})
  }

  return (
    <div
      className={`aircraft-panel ${isCollapsed ? 'collapsed' : ''} ${isResizing ? 'resizing' : ''}`}
      style={panelStyle}
    >
      {/* Left edge resize handle (for width) */}
      <div
        className="resize-handle resize-handle-left"
        onPointerDown={(e) => handleResizeStart(e, 'width')}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
        title="Drag to resize width"
      />

      {/* Bottom edge resize handle (for height) */}
      {!isCollapsed && (
        <div
          className="resize-handle resize-handle-bottom"
          onPointerDown={(e) => handleResizeStart(e, 'height')}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          title="Drag to resize height"
        />
      )}

      {/* Bottom-left corner resize handle (for both) */}
      {!isCollapsed && (
        <div
          className="resize-handle resize-handle-corner"
          onPointerDown={(e) => handleResizeStart(e, 'corner')}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          title="Drag to resize"
        />
      )}

      <div className="panel-header">
        <div className="header-left">
          <h3>Nearby Aircraft</h3>
          {vnasConnected && (
            <span className="data-source-badge live" title="Receiving 1Hz live updates via vNAS">
              <svg width="6" height="6" viewBox="0 0 6 6">
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
          <button
            className="collapse-btn"
            onClick={() => setIsCollapsed(!isCollapsed)}
            title={isCollapsed ? 'Expand panel' : 'Collapse panel'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              {isCollapsed ? (
                <polyline points="6 9 12 15 18 9" />
              ) : (
                <polyline points="18 15 12 9 6 15" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {!isCollapsed && (
        <>
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
                className={`filter-btn ${filterWeatherVisibility ? 'active' : ''}`}
                onClick={() => setFilterWeatherVisibility(!filterWeatherVisibility)}
                title="Only show aircraft visible through weather (affects both list and map)"
                disabled={!showWeatherEffects}
              >
                Visible
              </button>
              <button
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
            className={`follow-mode-btn ${followMode}`}
            onClick={toggleFollowMode}
            title="Toggle follow mode (O)"
          >
            {followMode === 'tower' ? 'Tower' : 'Orbit'}
          </button>
          <button className="stop-following-btn" onClick={() => stopFollowing()}>
            Stop (Esc)
          </button>
        </div>
      )}

      <div className="aircraft-list">
        {nearbyAircraft.length === 0 ? (
          <div className="no-aircraft">
            {currentAirport
              ? 'No aircraft nearby'
              : 'Select an airport or search globally (Ctrl+K)'}
          </div>
        ) : (
          nearbyAircraft.map((aircraft) => {
            const isFollowing = followingCallsign === aircraft.callsign
            const phaseLabel = aircraft.phase ? getPhaseLabel(aircraft.phase) : null
            const tierClass = aircraft.tier ? getTierClass(aircraft.tier) : ''
            return (
              <div
                key={aircraft.callsign}
                className={`aircraft-item ${isFollowing ? 'following' : ''} ${tierClass} clickable`}
                onClick={() => handleLookAt(aircraft)}
                title="Click to look at aircraft"
              >
                <div className="aircraft-header">
                  <div className="callsign-group">
                    {aircraft.isLive && (
                      <span className="live-indicator" title="1Hz live updates">
                        <svg width="6" height="6" viewBox="0 0 6 6">
                          <circle cx="3" cy="3" r="3" fill="#0c7" />
                        </svg>
                      </span>
                    )}
                    <span className="callsign">{aircraft.callsign}</span>
                    {phaseLabel && (
                      <span className={`phase-badge ${tierClass}`}>
                        {phaseLabel}
                        {aircraft.runway && <span className="runway-ident"> {aircraft.runway}</span>}
                      </span>
                    )}
                  </div>
                  <div className="aircraft-header-right">
                    <span className="aircraft-type">{aircraft.aircraftType || '???'}</span>
                    <button
                      className={`follow-btn ${isFollowing ? 'active' : ''}`}
                      onClick={(e) => {
                        e.stopPropagation() // Don't trigger look-at
                        handleFollowClick(aircraft.callsign)
                      }}
                      title={isFollowing ? 'Stop following' : 'Follow aircraft'}
                    >
                      {isFollowing ? (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="12" cy="12" r="10" />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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

                {(aircraft.departure || aircraft.arrival) && (
                  <div className="aircraft-route">
                    <span className="route-from">{aircraft.departure || '????'}</span>
                    <span className="route-arrow">→</span>
                    <span className="route-to">{aircraft.arrival || '????'}</span>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
        </>
      )}
    </div>
  )
}

export default AircraftPanel
