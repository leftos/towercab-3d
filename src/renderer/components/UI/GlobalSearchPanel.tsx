import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useVatsimStore } from '../../stores/vatsimStore'
import { useActiveViewportCamera } from '../../hooks/useActiveViewportCamera'
import './GlobalSearchPanel.css'

interface SearchResult {
  callsign: string
  aircraftType: string | null
  departure: string | null
  arrival: string | null
  altitude: number
  groundspeed: number
}

function GlobalSearchPanel() {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const allPilots = useVatsimStore((state) => state.allPilots)
  const { followAircraftInOrbit, followingCallsign } = useActiveViewportCamera()

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
          groundspeed: pilot.groundspeed
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
  }, [query, allPilots])

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
        <span className="search-btn-text">Search All</span>
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
              <span className="footer-hint">Press Enter to follow in orbit mode</span>
              <span className="footer-hint">Esc to close</span>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  )
}

export default GlobalSearchPanel
