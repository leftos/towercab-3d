import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useAirportStore } from '../../stores/airportStore'
import { useGlobalSettingsStore } from '../../stores/globalSettingsStore'
import { useVnasStore } from '../../stores/vnasStore'
import { useVatsimStore } from '../../stores/vatsimStore'
import type { Airport } from '../../types/airport'
import './AirportSelector.css'

type TabId = 'favorites' | 'recent' | 'popular' | 'vnas'

function AirportSelector() {
  const isOpen = useAirportStore((state) => state.isAirportSelectorOpen)
  const setOpen = useAirportStore((state) => state.setAirportSelectorOpen)
  const airports = useAirportStore((state) => state.airports)
  const searchAirports = useAirportStore((state) => state.searchAirports)
  const selectAirport = useAirportStore((state) => state.selectAirport)
  // Subscribe directly to globalSettingsStore for reactive updates
  const recentAirports = useGlobalSettingsStore((state) => state.airports.recentAirports)
  const vnasState = useVnasStore((state) => state.status.state)
  const sessionFacilitiesRaw = useVnasStore((state) => state.sessionFacilities)
  const sessionFacilities = useMemo(() => sessionFacilitiesRaw ?? [], [sessionFacilitiesRaw])

  // Data source and favorites
  const dataSource = useGlobalSettingsStore((state) => state.realtraffic.dataSource)
  const vatsimFavorites = useGlobalSettingsStore((state) => state.airports.vatsimFavorites ?? [])
  const realtrafficFavorites = useGlobalSettingsStore((state) => state.airports.realtrafficFavorites ?? [])
  const addFavorite = useGlobalSettingsStore((state) => state.addFavorite)
  const removeFavorite = useGlobalSettingsStore((state) => state.removeFavorite)

  // Get favorites based on current data source
  const favorites = dataSource === 'vatsim' ? vatsimFavorites : realtrafficFavorites

  // All pilots for calculating popular airports (VATSIM only)
  const allPilots = useVatsimStore((state) => state.allPilots)

  // Check if vNAS is connected enough to know about session facilities
  // (subscribing or connected means we've joined a session)
  const hasVnasSession = vnasState === 'subscribing' || vnasState === 'connected'

  // Check if a specific airport has 1Hz updates available in current session
  // vNAS facility IDs don't have K prefix for US airports (KSFO -> SFO)
  const hasVnas1Hz = useCallback(
    (icao: string) => {
      if (!hasVnasSession) return false
      const facilityId = icao.startsWith('K') && icao.length === 4 ? icao.slice(1) : icao
      return sessionFacilities.includes(facilityId) || sessionFacilities.includes(icao)
    },
    [hasVnasSession, sessionFacilities],
  )

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Airport[]>([])
  const [activeTab, setActiveTab] = useState<TabId>('recent')
  const inputRef = useRef<HTMLInputElement>(null)

  // Calculate popular airports from VATSIM flight plans
  const popularAirports = useMemo(() => {
    if (dataSource !== 'vatsim' || allPilots.length === 0) {
      return []
    }

    // Count each airport as departure or arrival
    const counts = new Map<string, number>()

    for (const pilot of allPilots) {
      const dep = pilot.flight_plan?.departure?.toUpperCase()
      const arr = pilot.flight_plan?.arrival?.toUpperCase()

      if (dep && dep.length === 4) {
        counts.set(dep, (counts.get(dep) || 0) + 1)
      }
      if (arr && arr.length === 4) {
        counts.set(arr, (counts.get(arr) || 0) + 1)
      }
    }

    // Sort by count, take top 8
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([icao]) => icao)
  }, [dataSource, allPilots])

  // Convert vNAS facility IDs to ICAO codes
  // vNAS uses 3-letter codes for US airports (SFO -> KSFO)
  // Note: airports.size is included to re-run when airport database loads
  const vnasAirports = useMemo(() => {
    if (airports.size === 0 || sessionFacilities.length === 0) return []

    const converted = sessionFacilities
      .map((facilityId) => {
        // If it's a 3-letter code, try adding K prefix for US airports
        if (facilityId.length === 3) {
          const withK = `K${facilityId}`
          if (airports.has(withK)) return withK
        }
        // Otherwise return as-is (international airports use 4-letter codes)
        return facilityId
      })
      .filter((icao) => airports.has(icao))

    console.log(
      '[AirportSelector] vNAS airports:',
      sessionFacilities.length,
      'facilities ->',
      converted.length,
      'airports',
    )
    return converted
  }, [sessionFacilities, airports])

  // Toggle favorite handler
  const toggleFavorite = useCallback(
    (icao: string, e: React.MouseEvent) => {
      e.stopPropagation() // Don't trigger airport selection

      if (favorites.includes(icao)) {
        removeFavorite(icao, dataSource)
      } else {
        addFavorite(icao, dataSource)
      }
    },
    [favorites, dataSource, addFavorite, removeFavorite],
  )

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // Search as user types
  useEffect(() => {
    if (query.trim()) {
      const searchResults = searchAirports(query)
      setResults(searchResults)
    } else {
      setResults([])
    }
  }, [query, searchAirports])

  const handleSelect = useCallback(
    (icao: string) => {
      selectAirport(icao)
      setQuery('')
      setOpen(false)
    },
    [selectAirport, setOpen],
  )

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'Enter') {
      // Select top result from search, or top item from active tab
      if (query.trim() && results.length > 0) {
        handleSelect(results[0].icao)
      } else if (!query.trim()) {
        if (activeTab === 'favorites' && favoriteAirportDetails.length > 0) {
          handleSelect(favoriteAirportDetails[0].icao)
        } else if (activeTab === 'recent' && recentAirportDetails.length > 0) {
          handleSelect(recentAirportDetails[0].icao)
        } else if (activeTab === 'popular' && popularAirports.length > 0) {
          handleSelect(popularAirports[0])
        } else if (activeTab === 'vnas' && vnasAirports.length > 0) {
          handleSelect(vnasAirports[0])
        }
      }
    }
  }

  // Get recent airport details
  const recentAirportDetails = recentAirports
    .map((icao) => airports.get(icao))
    .filter((a): a is Airport => a !== undefined)
    .slice(0, 10)

  // Get favorite airport details
  const favoriteAirportDetails = favorites
    .map((icao) => airports.get(icao))
    .filter((a): a is Airport => a !== undefined)

  // Get vNAS airport details
  const vnasAirportDetails = vnasAirports.map((icao) => airports.get(icao)).filter((a): a is Airport => a !== undefined)

  // Star icon SVG component
  const StarIcon = ({ filled, size = 16 }: { filled: boolean; size?: number }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  )

  // Reusable airport item component
  const AirportItem = ({ airport, showFavoriteToggle = true }: { airport: Airport; showFavoriteToggle?: boolean }) => {
    const isFavorite = favorites.includes(airport.icao)
    return (
      <div
        className="airport-result"
        onClick={() => handleSelect(airport.icao)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && handleSelect(airport.icao)}
      >
        <div className="result-main">
          {hasVnas1Hz(airport.icao) && (
            <span className="vnas-indicator" title="1Hz real-time updates available (vNAS session)">
              <svg width="8" height="8" viewBox="0 0 8 8">
                <circle cx="4" cy="4" r="4" fill="#0c7" />
              </svg>
            </span>
          )}
          <span className="result-icao">{airport.icao}</span>
          {airport.iata && <span className="result-iata">{airport.iata}</span>}
          <span className="result-name">{airport.name}</span>
        </div>
        <div className="result-location">
          {airport.city}, {airport.country}
        </div>
        {showFavoriteToggle && (
          <button
            className={`favorite-toggle ${isFavorite ? 'is-favorite' : ''}`}
            onClick={(e) => toggleFavorite(airport.icao, e)}
            title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          >
            <StarIcon filled={isFavorite} />
          </button>
        )}
      </div>
    )
  }

  if (!isOpen) return null

  return (
    <div className="airport-selector-overlay" onClick={() => setOpen(false)}>
      <div className="airport-selector" onClick={(e) => e.stopPropagation()}>
        <div className="search-container">
          <svg
            className="search-icon"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search by ICAO, name, or city..."
            className="search-input"
          />
        </div>

        <div className="selector-content">
          {query.trim() ? (
            // Search Results
            <div className="results-section">
              {results.length === 0 ? (
                <div className="no-results">No airports found</div>
              ) : (
                <div className="airport-list">
                  {results.map((airport) => (
                    <AirportItem key={airport.icao} airport={airport} />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Tab Bar */}
              <div className="tab-bar">
                <button
                  className={`tab ${activeTab === 'favorites' ? 'active' : ''}`}
                  onClick={() => setActiveTab('favorites')}
                >
                  Favorites
                  {favoriteAirportDetails.length > 0 && (
                    <span className="tab-count">{favoriteAirportDetails.length}</span>
                  )}
                </button>
                <button
                  className={`tab ${activeTab === 'recent' ? 'active' : ''}`}
                  onClick={() => setActiveTab('recent')}
                >
                  Recent
                  {recentAirportDetails.length > 0 && <span className="tab-count">{recentAirportDetails.length}</span>}
                </button>
                {dataSource === 'vatsim' && popularAirports.length > 0 && (
                  <button
                    className={`tab ${activeTab === 'popular' ? 'active' : ''}`}
                    onClick={() => setActiveTab('popular')}
                  >
                    Popular
                    <span className="tab-count">{popularAirports.length}</span>
                  </button>
                )}
                {hasVnasSession && vnasAirports.length > 0 && (
                  <button
                    className={`tab tab-vnas ${activeTab === 'vnas' ? 'active' : ''}`}
                    onClick={() => setActiveTab('vnas')}
                  >
                    <svg width="8" height="8" viewBox="0 0 8 8" className="tab-vnas-dot">
                      <circle cx="4" cy="4" r="4" fill="#0c7" />
                    </svg>
                    vNAS
                    <span className="tab-count">{vnasAirports.length}</span>
                  </button>
                )}
              </div>

              {/* Tab Content */}
              <div className="tab-content">
                {activeTab === 'favorites' && (
                  <div className="tab-panel">
                    {favoriteAirportDetails.length === 0 ? (
                      <div className="empty-tab">
                        <p>No favorite airports</p>
                        <p className="empty-hint">Click the star on any airport to add it to favorites</p>
                      </div>
                    ) : (
                      <div className="airport-list">
                        {favoriteAirportDetails.map((airport) => (
                          <AirportItem key={airport.icao} airport={airport} />
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'recent' && (
                  <div className="tab-panel">
                    {recentAirportDetails.length === 0 ? (
                      <div className="empty-tab">
                        <p>No recent airports</p>
                        <p className="empty-hint">Airports you visit will appear here</p>
                      </div>
                    ) : (
                      <div className="airport-list">
                        {recentAirportDetails.map((airport) => (
                          <AirportItem key={airport.icao} airport={airport} />
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeTab === 'vnas' && hasVnasSession && vnasAirports.length > 0 && (
                  <div className="tab-panel">
                    <div className="airport-list">
                      {vnasAirportDetails.map((airport) => (
                        <AirportItem key={airport.icao} airport={airport} />
                      ))}
                    </div>
                  </div>
                )}

                {activeTab === 'popular' && dataSource === 'vatsim' && (
                  <div className="tab-panel">
                    <div className="airport-list">
                      {popularAirports.map((icao) => {
                        const airport = airports.get(icao)
                        if (!airport) return null
                        return <AirportItem key={airport.icao} airport={airport} />
                      })}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default AirportSelector
