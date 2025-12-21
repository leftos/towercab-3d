import { useMemo, useState, useEffect } from 'react'
import { useAirportStore } from '../../stores/airportStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useAircraftFilterStore } from '../../stores/aircraftFilterStore'
import { useActiveViewportCamera } from '../../hooks/useActiveViewportCamera'
import { useAircraftInterpolation } from '../../hooks/useAircraftInterpolation'
import { useAircraftFiltering } from '../../hooks/useAircraftFiltering'
import { calculateBearing } from '../../utils/interpolation'
import { formatAltitude, formatGroundspeed, formatHeading } from '../../utils/towerHeight'
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
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const showAircraftPanel = useSettingsStore((state) => state.showAircraftPanel)
  const showWeatherEffects = useSettingsStore((state) => state.showWeatherEffects)

  // Panel filter state from store (affects both list and datablocks)
  const searchQuery = useAircraftFilterStore((state) => state.searchQuery)
  const setSearchQuery = useAircraftFilterStore((state) => state.setSearchQuery)
  const filterWeatherVisibility = useAircraftFilterStore((state) => state.filterWeatherVisibility)
  const setFilterWeatherVisibility = useAircraftFilterStore((state) => state.setFilterWeatherVisibility)
  const filterAirportTraffic = useAircraftFilterStore((state) => state.filterAirportTraffic)
  const setFilterAirportTraffic = useAircraftFilterStore((state) => state.setFilterAirportTraffic)

  // Local state for sorting and collapse (UI-only, doesn't affect filtering)
  const [sortOption, setSortOption] = useState<SortOption>('distance')
  const [isCollapsed, setIsCollapsed] = useState(false)

  // Periodic refresh to update distances/bearings (UI updates automatically via hook reactivity)
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

  // Get interpolated aircraft data (shared single source)
  const interpolatedAircraft = useAircraftInterpolation()

  // Use shared filtering hook (affects both list and datablocks)
  const { filtered, referencePoint, isOrbitModeWithoutAirport } = useAircraftFiltering(interpolatedAircraft)

  // Calculate bearing and convert to AircraftListItem format with sorting
  const nearbyAircraft = useMemo((): AircraftListItem[] => {
    if (!referencePoint) return []

    // In orbit mode without airport, exclude the followed aircraft from the "nearby" list
    // (it will be shown separately at the top)
    const aircraftToShow = isOrbitModeWithoutAirport
      ? filtered.filter((aircraft) => aircraft.callsign !== followingCallsign)
      : filtered

    const withBearing = aircraftToShow.map((aircraft) => ({
      callsign: aircraft.callsign,
      aircraftType: aircraft.aircraftType,
      altitude: aircraft.interpolatedAltitude,
      groundspeed: aircraft.interpolatedGroundspeed,
      heading: aircraft.interpolatedHeading,
      distance: aircraft.distance,
      bearing: calculateBearing(
        referencePoint.lat,
        referencePoint.lon,
        aircraft.interpolatedLatitude,
        aircraft.interpolatedLongitude
      ),
      departure: aircraft.departure,
      arrival: aircraft.arrival
    }))

    // Apply sorting (UI-only, doesn't affect filtering)
    const sorted = withBearing.sort((a, b) => {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshTick intentionally forces periodic recalculation of distances/bearings
  }, [filtered, referencePoint, followingCallsign, isOrbitModeWithoutAirport, sortOption, refreshTick])

  // Get the followed aircraft data for orbit mode display
  const followedAircraftData = useMemo(() => {
    if (!followingCallsign) return null
    // Find in filtered list or use the first match from filtered aircraft
    return filtered.find((a) => a.callsign === followingCallsign) || null
  }, [followingCallsign, filtered])

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
          <button className="stop-following-btn" onClick={() => stopFollowing()}>
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
