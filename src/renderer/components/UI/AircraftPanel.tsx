import { useMemo, useState, useEffect } from 'react'
import { useAirportStore } from '../../stores/airportStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useWeatherStore } from '../../stores/weatherStore'
import { useAircraftInterpolation } from '../../hooks/useAircraftInterpolation'
import { useActiveViewportCamera } from '../../hooks/useActiveViewportCamera'
import { calculateDistanceNM, calculateBearing } from '../../utils/interpolation'
import { formatAltitude, formatGroundspeed, formatHeading } from '../../utils/towerHeight'
import { getTowerPosition } from '../../utils/towerHeight'
import './AircraftPanel.css'

type SortOption = 'distance' | 'callsign' | 'altitude' | 'speed'

interface AircraftListItem {
  callsign: string
  aircraftType: string | null
  altitude: number
  groundspeed: number
  heading: number
  distance: number
  bearing: number
  departure: string | null
  arrival: string | null
}

function AircraftPanel() {
  const interpolatedStates = useAircraftInterpolation()
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const towerHeight = useAirportStore((state) => state.towerHeight)
  const showAircraftPanel = useSettingsStore((state) => state.showAircraftPanel)
  const labelVisibilityDistance = useSettingsStore((state) => state.labelVisibilityDistance)

  // Local state for sorting, searching, filtering, and collapse
  const [sortOption, setSortOption] = useState<SortOption>('distance')
  const [searchQuery, setSearchQuery] = useState('')
  const [isCollapsed, setIsCollapsed] = useState(false)
  const [filterVisible, setFilterVisible] = useState(false) // Only show weather-visible aircraft
  const [filterAirportTraffic, setFilterAirportTraffic] = useState(false) // Only show dep/arr at current airport

  // Weather store for visibility filtering
  const showWeatherEffects = useSettingsStore((state) => state.showWeatherEffects)
  const showCesiumFog = useSettingsStore((state) => state.showCesiumFog)
  const showClouds = useSettingsStore((state) => state.showClouds)
  const cloudLayers = useWeatherStore((state) => state.cloudLayers)
  const currentMetar = useWeatherStore((state) => state.currentMetar)

  // Periodic refresh to update distances/bearings from the mutating interpolated Map
  // The Map is mutated every frame but doesn't trigger re-renders, so we force a refresh every second
  const [refreshTick, setRefreshTick] = useState(0)
  useEffect(() => {
    const interval = setInterval(() => setRefreshTick(t => t + 1), 1000)
    return () => clearInterval(interval)
  }, [])

  // Active viewport camera for follow functionality
  const {
    followingCallsign,
    followAircraft,
    stopFollowing,
    followMode,
    toggleFollowMode,
    followZoom,
    orbitDistance
  } = useActiveViewportCamera()

  // Determine if we're in orbit mode without an airport (following an aircraft globally)
  const isOrbitModeWithoutAirport = followMode === 'orbit' && followingCallsign && !currentAirport

  // Get the followed aircraft data for orbit mode display
  const followedAircraftData = useMemo(() => {
    if (!followingCallsign) return null
    return interpolatedStates.get(followingCallsign) || null
  }, [followingCallsign, interpolatedStates])

  // Check if an aircraft would be visible based on weather conditions
  // Similar logic to useBabylonOverlay.isDatablockVisibleByWeather
  const isVisibleByWeather = (
    cameraAltitudeAGL: number,
    aircraftAltitudeAGL: number,
    distanceMeters: number
  ): boolean => {
    // If weather effects are disabled, always visible
    if (!showWeatherEffects) return true

    // Check visibility range (surface visibility culling)
    if (currentMetar && showCesiumFog) {
      const visibilityMeters = currentMetar.visib * 1609.34 // SM to meters
      if (distanceMeters > visibilityMeters) {
        return false
      }
    }

    // Check cloud ceiling culling (BKN or OVC between camera and aircraft)
    if (showClouds && cloudLayers.length > 0) {
      const lowerAlt = Math.min(cameraAltitudeAGL, aircraftAltitudeAGL)
      const higherAlt = Math.max(cameraAltitudeAGL, aircraftAltitudeAGL)

      for (const layer of cloudLayers) {
        // BKN = 0.75, OVC = 1.0 - these are "ceilings" that block visibility
        if (layer.coverage >= 0.75) {
          if (layer.altitude > lowerAlt && layer.altitude < higherAlt) {
            return false
          }
        }
      }
    }

    return true
  }

  const nearbyAircraft = useMemo((): AircraftListItem[] => {
    // Determine reference point for distance/bearing calculations
    let refLat: number
    let refLon: number
    let groundElevationMeters = 0
    let refAltitudeFeet = 0  // Reference altitude for 3D slant range calculation

    if (isOrbitModeWithoutAirport && followedAircraftData) {
      // In orbit mode without airport, use followed aircraft as reference
      refLat = followedAircraftData.interpolatedLatitude
      refLon = followedAircraftData.interpolatedLongitude
      refAltitudeFeet = followedAircraftData.interpolatedAltitude
    } else if (currentAirport) {
      // Normal mode: use tower position
      const towerPos = getTowerPosition(currentAirport, towerHeight)
      refLat = towerPos.latitude
      refLon = towerPos.longitude
      groundElevationMeters = currentAirport.elevation ? currentAirport.elevation * 0.3048 : 0
      // Tower altitude = ground elevation + tower height (convert tower height from meters to feet)
      refAltitudeFeet = (currentAirport.elevation || 0) + (towerHeight / 0.3048)
    } else {
      // No reference point available
      return []
    }

    // Tower altitude AGL (camera position for visibility check)
    const cameraAltitudeAGL = towerHeight

    const query = searchQuery.toLowerCase().trim()
    const airportIcao = currentAirport?.icao?.toUpperCase()

    const mapped = Array.from(interpolatedStates.values())
      // In orbit mode without airport, exclude the followed aircraft from the "nearby" list
      // (it will be shown separately at the top)
      .filter((aircraft) => !(isOrbitModeWithoutAirport && aircraft.callsign === followingCallsign))
      .map((aircraft) => {
        const distance = calculateDistanceNM(
          refLat,
          refLon,
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude,
          refAltitudeFeet,
          aircraft.interpolatedAltitude
        )
        const bearing = calculateBearing(
          refLat,
          refLon,
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude
        )

        // Calculate altitude AGL in meters for visibility check
        const altitudeMeters = aircraft.interpolatedAltitude * 0.3048
        const altitudeAGL = altitudeMeters - groundElevationMeters

        // Calculate distance in meters for visibility check
        const distanceMeters = distance * 1852 // NM to meters

        return {
          callsign: aircraft.callsign,
          aircraftType: aircraft.aircraftType,
          altitude: aircraft.interpolatedAltitude,
          groundspeed: aircraft.interpolatedGroundspeed,
          heading: aircraft.interpolatedHeading,
          distance,
          bearing,
          departure: aircraft.departure,
          arrival: aircraft.arrival,
          // Extra fields for filtering (not displayed)
          _altitudeAGL: altitudeAGL,
          _distanceMeters: distanceMeters
        }
      })
      .filter((a) => a.distance <= labelVisibilityDistance)

    // Apply weather visibility filter
    let filtered = filterVisible
      ? mapped.filter((a) => isVisibleByWeather(cameraAltitudeAGL, a._altitudeAGL, a._distanceMeters))
      : mapped

    // Apply airport traffic filter (departure or arrival matches current airport)
    if (filterAirportTraffic && airportIcao) {
      filtered = filtered.filter((a) =>
        a.departure?.toUpperCase() === airportIcao ||
        a.arrival?.toUpperCase() === airportIcao
      )
    }

    // Apply search filter
    filtered = query
      ? filtered.filter((a) =>
          a.callsign.toLowerCase().includes(query) ||
          a.aircraftType?.toLowerCase().includes(query) ||
          a.departure?.toLowerCase().includes(query) ||
          a.arrival?.toLowerCase().includes(query)
        )
      : filtered

    // Apply sorting
    const sorted = filtered.sort((a, b) => {
      switch (sortOption) {
        case 'callsign':
          return a.callsign.localeCompare(b.callsign)
        case 'altitude':
          return b.altitude - a.altitude // Highest first
        case 'speed':
          return b.groundspeed - a.groundspeed // Fastest first
        case 'distance':
        default:
          return a.distance - b.distance // Closest first
      }
    })

    return sorted.slice(0, 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interpolatedStates, currentAirport, towerHeight, labelVisibilityDistance, sortOption, searchQuery, isOrbitModeWithoutAirport, followedAircraftData, followingCallsign, refreshTick, filterVisible, filterAirportTraffic, showWeatherEffects, showCesiumFog, showClouds, cloudLayers, currentMetar])

  const handleFollowClick = (callsign: string) => {
    if (followingCallsign === callsign) {
      stopFollowing()
    } else {
      followAircraft(callsign)
    }
  }

  if (!showAircraftPanel) return null

  return (
    <div className={`aircraft-panel ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="panel-header">
        <h3>{isOrbitModeWithoutAirport ? `Near ${followingCallsign}` : 'Nearby Aircraft'}</h3>
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
              placeholder="Search callsign, type, route..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <div className="filter-controls">
              <button
                className={`filter-btn ${filterVisible ? 'active' : ''}`}
                onClick={() => setFilterVisible(!filterVisible)}
                title="Only show aircraft visible through weather (not obscured by clouds or beyond visibility)"
                disabled={!showWeatherEffects}
              >
                Visible
              </button>
              <button
                className={`filter-btn ${filterAirportTraffic ? 'active' : ''}`}
                onClick={() => setFilterAirportTraffic(!filterAirportTraffic)}
                title="Only show aircraft departing from or arriving at this airport"
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
                <option value="distance">Distance</option>
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
          <div className="zoom-control">
            {followMode === 'orbit' ? (
              <span className="zoom-label">Dist: {orbitDistance}m</span>
            ) : (
              <span className="zoom-label">Zoom: {followZoom.toFixed(1)}x</span>
            )}
          </div>
          <button className="stop-following-btn" onClick={stopFollowing}>
            Stop (Esc)
          </button>
        </div>
      )}

      {/* Show detailed info for followed aircraft in orbit mode without airport */}
      {isOrbitModeWithoutAirport && followedAircraftData && (
        <div className="followed-aircraft-details">
          <div className="followed-header">
            <span className="followed-callsign">{followedAircraftData.callsign}</span>
            <span className="followed-type">{followedAircraftData.aircraftType || '???'}</span>
          </div>
          <div className="followed-stats">
            <div className="stat-item">
              <span className="stat-label">ALT</span>
              <span className="stat-value">{formatAltitude(followedAircraftData.interpolatedAltitude)}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">GS</span>
              <span className="stat-value">{formatGroundspeed(followedAircraftData.interpolatedGroundspeed)}</span>
            </div>
            <div className="stat-item">
              <span className="stat-label">HDG</span>
              <span className="stat-value">{formatHeading(followedAircraftData.interpolatedHeading)}</span>
            </div>
          </div>
          {(followedAircraftData.departure || followedAircraftData.arrival) && (
            <div className="followed-route">
              <span className="route-from">{followedAircraftData.departure || '????'}</span>
              <span className="route-arrow">→</span>
              <span className="route-to">{followedAircraftData.arrival || '????'}</span>
            </div>
          )}
        </div>
      )}

      <div className="aircraft-list">
        {nearbyAircraft.length === 0 ? (
          <div className="no-aircraft">
            {isOrbitModeWithoutAirport
              ? 'No other aircraft nearby'
              : currentAirport
                ? 'No aircraft nearby'
                : 'Select an airport or search globally (Ctrl+K)'}
          </div>
        ) : (
          nearbyAircraft.map((aircraft) => {
            const isFollowing = followingCallsign === aircraft.callsign
            return (
              <div
                key={aircraft.callsign}
                className={`aircraft-item ${isFollowing ? 'following' : ''}`}
              >
                <div className="aircraft-header">
                  <span className="callsign">{aircraft.callsign}</span>
                  <div className="aircraft-header-right">
                    <span className="aircraft-type">{aircraft.aircraftType || '???'}</span>
                    <button
                      className={`follow-btn ${isFollowing ? 'active' : ''}`}
                      onClick={() => handleFollowClick(aircraft.callsign)}
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
