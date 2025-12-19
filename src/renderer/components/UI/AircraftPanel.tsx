import { useMemo } from 'react'
import { useAirportStore } from '../../stores/airportStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useCameraStore } from '../../stores/cameraStore'
import { useAircraftInterpolation } from '../../hooks/useAircraftInterpolation'
import { calculateDistanceNM, calculateBearing } from '../../utils/interpolation'
import { formatAltitude, formatGroundspeed, formatHeading } from '../../utils/towerHeight'
import { getTowerPosition } from '../../utils/towerHeight'
import './AircraftPanel.css'

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

  // Camera store for follow functionality
  const followingCallsign = useCameraStore((state) => state.followingCallsign)
  const followAircraft = useCameraStore((state) => state.followAircraft)
  const stopFollowing = useCameraStore((state) => state.stopFollowing)
  const followMode = useCameraStore((state) => state.followMode)
  const toggleFollowMode = useCameraStore((state) => state.toggleFollowMode)
  const followZoom = useCameraStore((state) => state.followZoom)
  const orbitDistance = useCameraStore((state) => state.orbitDistance)

  const nearbyAircraft = useMemo((): AircraftListItem[] => {
    if (!currentAirport) return []

    const towerPos = getTowerPosition(currentAirport, towerHeight)

    return Array.from(interpolatedStates.values())
      .map((aircraft) => {
        const distance = calculateDistanceNM(
          towerPos.latitude,
          towerPos.longitude,
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude
        )
        const bearing = calculateBearing(
          towerPos.latitude,
          towerPos.longitude,
          aircraft.interpolatedLatitude,
          aircraft.interpolatedLongitude
        )

        return {
          callsign: aircraft.callsign,
          aircraftType: aircraft.aircraftType,
          altitude: aircraft.interpolatedAltitude,
          groundspeed: aircraft.interpolatedGroundspeed,
          heading: aircraft.interpolatedHeading,
          distance,
          bearing,
          departure: aircraft.departure,
          arrival: aircraft.arrival
        }
      })
      .filter((a) => a.distance <= labelVisibilityDistance)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 50)
  }, [interpolatedStates, currentAirport, towerHeight, labelVisibilityDistance])

  const handleFollowClick = (callsign: string) => {
    if (followingCallsign === callsign) {
      stopFollowing()
    } else {
      followAircraft(callsign)
    }
  }

  if (!showAircraftPanel) return null

  return (
    <div className="aircraft-panel">
      <div className="panel-header">
        <h3>Nearby Aircraft</h3>
        <span className="aircraft-count">{nearbyAircraft.length}</span>
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

      <div className="aircraft-list">
        {nearbyAircraft.length === 0 ? (
          <div className="no-aircraft">
            {currentAirport ? 'No aircraft nearby' : 'Select an airport'}
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
    </div>
  )
}

export default AircraftPanel
