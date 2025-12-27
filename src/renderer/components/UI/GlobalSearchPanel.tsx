import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useVatsimStore } from '../../stores/vatsimStore'
import { useVnasStore } from '../../stores/vnasStore'
import { useActiveViewportCamera } from '../../hooks/useActiveViewportCamera'
import './GlobalSearchPanel.css'

interface SearchResult {
  callsign: string
  aircraftType: string | null
  departure: string | null
  arrival: string | null
  altitude: number
  groundspeed: number
  isLive: boolean
}

function GlobalSearchPanel() {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const allPilots = useVatsimStore((state) => state.allPilots)
  const { followAircraftInOrbit, followingCallsign } = useActiveViewportCamera()

  // vNAS state for live update indicator
  const vnasConnected = useVnasStore((state) => state.status.state === 'connected')
  const vnasAircraftStates = useVnasStore((state) => state.aircraftStates)

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus()
    }
  }, [isOpen])

  // Keyboard shortcut to open search (Ctrl+K or Cmd+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        setIsOpen(true)
      }
      if (e.key === 'Escape' && isOpen) {
        setIsOpen(false)
        setQuery('')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen])

  const searchResults = useMemo((): SearchResult[] => {
    if (!query.trim()) return []

    const searchTerm = query.toLowerCase().trim()
    const results: SearchResult[] = []

    for (const pilot of allPilots) {
      const aircraftType = pilot.flight_plan?.aircraft_short || null
      const departure = pilot.flight_plan?.departure || null
      const arrival = pilot.flight_plan?.arrival || null

      const matchesCallsign = pilot.callsign.toLowerCase().includes(searchTerm)
      const matchesType = aircraftType?.toLowerCase().includes(searchTerm)
      const matchesDeparture = departure?.toLowerCase().includes(searchTerm)
      const matchesArrival = arrival?.toLowerCase().includes(searchTerm)

      if (matchesCallsign || matchesType || matchesDeparture || matchesArrival) {
        results.push({
          callsign: pilot.callsign,
          aircraftType,
          departure,
          arrival,
          altitude: pilot.altitude,  // Keep in METERS
          groundspeed: pilot.groundspeed,
          isLive: vnasAircraftStates.has(pilot.callsign)
        })
      }

      // Limit results for performance
      if (results.length >= 20) break
    }

    // Sort by callsign match first, then alphabetically
    return results.sort((a, b) => {
      const aStartsWithQuery = a.callsign.toLowerCase().startsWith(searchTerm)
      const bStartsWithQuery = b.callsign.toLowerCase().startsWith(searchTerm)
      if (aStartsWithQuery && !bStartsWithQuery) return -1
      if (!aStartsWithQuery && bStartsWithQuery) return 1
      return a.callsign.localeCompare(b.callsign)
    })
  }, [query, allPilots, vnasAircraftStates])

  const handleSelect = useCallback((callsign: string) => {
    followAircraftInOrbit(callsign)
    setIsOpen(false)
    setQuery('')
  }, [followAircraftInOrbit])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && searchResults.length > 0) {
      handleSelect(searchResults[0].callsign)
    }
  }

  const handleOpenSearch = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsOpen(true)
  }

  return (
    <>
      <button
        type="button"
        className="global-search-btn"
        onClick={handleOpenSearch}
        title="Global Aircraft Search (Ctrl+K)"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
        <span className="search-btn-text">Search Flights</span>
        <span className="search-shortcut">Ctrl+K</span>
      </button>

      {isOpen && createPortal(
        <div className="global-search-overlay" onClick={() => setIsOpen(false)}>
          <div className="global-search-modal" onClick={(e) => e.stopPropagation()}>
            <div className="search-header">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                className="global-search-input"
                placeholder="Search all aircraft by callsign, type, or route..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
              />
              <button type="button" className="close-search-btn" onClick={() => setIsOpen(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="search-results">
              {query.trim() === '' ? (
                <div className="search-hint">
                  Start typing to search all {allPilots.length} aircraft on VATSIM
                </div>
              ) : searchResults.length === 0 ? (
                <div className="no-results">No aircraft found matching &quot;{query}&quot;</div>
              ) : (
                searchResults.map((result) => (
                  <button
                    type="button"
                    key={result.callsign}
                    className={`search-result-item ${followingCallsign === result.callsign ? 'following' : ''}`}
                    onClick={() => handleSelect(result.callsign)}
                  >
                    <div className="result-main">
                      {result.isLive && (
                        <span className="live-indicator" title="1Hz live updates">
                          <svg width="6" height="6" viewBox="0 0 6 6">
                            <circle cx="3" cy="3" r="3" fill="#0c7" />
                          </svg>
                        </span>
                      )}
                      <span className="result-callsign">{result.callsign}</span>
                      <span className="result-type">{result.aircraftType || '???'}</span>
                    </div>
                    <div className="result-details">
                      {result.departure || result.arrival ? (
                        <span className="result-route">
                          {result.departure || '????'} → {result.arrival || '????'}
                        </span>
                      ) : null}
                      <span className="result-info">
                        FL{Math.round((result.altitude / 0.3048) / 100).toString().padStart(3, '0')} • {result.groundspeed}kts
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>

            <div className="search-footer">
              <div className="footer-left">
                {vnasConnected ? (
                  <span className="data-source-badge live" title="Receiving 1Hz live updates via vNAS">
                    <svg width="6" height="6" viewBox="0 0 6 6">
                      <circle cx="3" cy="3" r="3" fill="currentColor" />
                    </svg>
                    1s updates
                  </span>
                ) : (
                  <span className="data-source-badge fallback" title="Using 15-second VATSIM polling">
                    15s updates
                  </span>
                )}
              </div>
              <div className="footer-right">
                <span className="footer-hint">Enter to follow</span>
                <span className="footer-hint">Esc to close</span>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

export default GlobalSearchPanel
