import { useState, useEffect, useRef, useCallback } from 'react'
import { useAirportStore } from '../../stores/airportStore'
import type { Airport } from '../../types/airport'
import './AirportSelector.css'

function AirportSelector() {
  const isOpen = useAirportStore((state) => state.isAirportSelectorOpen)
  const setOpen = useAirportStore((state) => state.setAirportSelectorOpen)
  const airports = useAirportStore((state) => state.airports)
  const searchAirports = useAirportStore((state) => state.searchAirports)
  const selectAirport = useAirportStore((state) => state.selectAirport)
  const recentAirports = useAirportStore((state) => state.recentAirports)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Airport[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

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

  const handleSelect = useCallback((icao: string) => {
    selectAirport(icao)
    setQuery('')
    setOpen(false)
  }, [selectAirport, setOpen])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  // Get recent airport details
  const recentAirportDetails = recentAirports
    .map((icao) => airports.get(icao))
    .filter((a): a is Airport => a !== undefined)
    .slice(0, 5)

  if (!isOpen) return null

  return (
    <div className="airport-selector-overlay" onClick={() => setOpen(false)}>
      <div className="airport-selector" onClick={(e) => e.stopPropagation()}>
        <div className="search-container">
          <svg className="search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
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
                    <button
                      key={airport.icao}
                      className="airport-result"
                      onClick={() => handleSelect(airport.icao)}
                    >
                      <div className="result-main">
                        <span className="result-icao">{airport.icao}</span>
                        {airport.iata && <span className="result-iata">{airport.iata}</span>}
                        <span className="result-name">{airport.name}</span>
                      </div>
                      <div className="result-location">
                        {airport.city}, {airport.country}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            // Recent Airports
            <div className="recent-section">
              <h3>Recent Airports</h3>
              {recentAirportDetails.length === 0 ? (
                <div className="no-recent">No recent airports</div>
              ) : (
                <div className="airport-list">
                  {recentAirportDetails.map((airport) => (
                    <button
                      key={airport.icao}
                      className="airport-result"
                      onClick={() => handleSelect(airport.icao)}
                    >
                      <div className="result-main">
                        <span className="result-icao">{airport.icao}</span>
                        {airport.iata && <span className="result-iata">{airport.iata}</span>}
                        <span className="result-name">{airport.name}</span>
                      </div>
                      <div className="result-location">
                        {airport.city}, {airport.country}
                      </div>
                    </button>
                  ))}
                </div>
              )}

              <div className="popular-section">
                <h3>Popular Airports</h3>
                <div className="quick-airports">
                  {['KJFK', 'KLAX', 'EGLL', 'EDDF', 'LFPG', 'RJTT', 'VHHH', 'YSSY'].map((icao) => {
                    const airport = airports.get(icao)
                    if (!airport) return null
                    return (
                      <button
                        key={icao}
                        className="quick-airport"
                        onClick={() => handleSelect(icao)}
                      >
                        {icao}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default AirportSelector
