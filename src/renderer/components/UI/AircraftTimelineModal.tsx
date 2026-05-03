import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SOURCE_DISPLAY_DELAYS } from '@/constants/aircraft-timeline'
import { saveDiagnostic } from '@/services/DiagnosticService'
import { useAircraftTimelineStore } from '@/stores/aircraftTimelineStore'
import { useAirportStore } from '@/stores/airportStore'
import { useGlobalSettingsStore } from '@/stores/globalSettingsStore'
import { useReplayStore } from '@/stores/replayStore'
import { useUIFeedbackStore } from '@/stores/uiFeedbackStore'
import type { AircraftDataSource, AircraftObservation } from '@/types/aircraft-timeline'
import { calculateDistanceNM } from '@/utils/geoMath'
import { getTowerPosition } from '@/utils/towerHeight'
import './AircraftTimelineModal.css'

interface AircraftTimelineModalProps {
  onClose: () => void
}

type FilterMode = 'all' | 'withinRange'

interface TimelineConfig {
  timeScale: number // pixels per second
  trackHeight: number // height of each track in pixels
  autoscroll: boolean // follow current time
  filterMode: FilterMode
}

interface HoveredObservation {
  x: number
  y: number
  observation: AircraftObservation
  callsign: string
  isParked?: boolean
  // Dynamic delay info
  dynamicDelay?: {
    currentDelayMs: number
    targetDelayMs: number
    intervalHistory: number[]
    extrapolationBumpMs: number
  }
}

// Source colors
const SOURCE_COLORS: Record<AircraftDataSource, string> = {
  vatsim: '#4fc3f7', // Light blue
  vnas: '#81c784', // Green
  realtraffic: '#ffb74d', // Orange
  replay: '#ce93d8', // Purple
  broadcast: '#f06292', // Pink (for inset broadcasts)
}

const LABEL_WIDTH = 150 // Increased to show delay info
const RULER_HEIGHT = 30
const TRACK_GAP = 2
const MARKER_RADIUS = 5
const DEFAULT_TIME_SCALE = 10 // 10 px per second
const MIN_TIME_SCALE = 2
const MAX_TIME_SCALE = 50

function AircraftTimelineModal({ onClose }: AircraftTimelineModalProps) {
  const rulerCanvasRef = useRef<HTMLCanvasElement>(null)
  const tracksCanvasRef = useRef<HTMLCanvasElement>(null)
  const tracksContainerRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Refs to hold latest draw functions (avoids stale closure in animation loop)
  const drawRulerRef = useRef<
    ((now: number, startTime: number, endTime: number, replayTime: number | null) => void) | null
  >(null)
  const drawTracksRef = useRef<
    ((now: number, startTime: number, endTime: number, replayTime: number | null) => void) | null
  >(null)
  const visibleDurationMsRef = useRef<number>(72000)

  // Animation frame ID ref for cleanup
  const animationIdRef = useRef<number>(0)

  const [config, setConfig] = useState<TimelineConfig>({
    timeScale: DEFAULT_TIME_SCALE,
    trackHeight: 32,
    autoscroll: true,
    filterMode: 'withinRange',
  })

  const [hoveredObs, setHoveredObs] = useState<HoveredObservation | null>(null)
  const [containerWidth, setContainerWidth] = useState(800)
  const [savedDiagnosticPath, setSavedDiagnosticPath] = useState<string | null>(null)
  const [isSavingDiagnostic, setIsSavingDiagnostic] = useState(false)

  // Get data from stores
  const timelines = useAircraftTimelineStore((state) => state.timelines)
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const towerHeight = useAirportStore((state) => state.towerHeight)
  const customTowerPosition = useAirportStore((state) => state.customTowerPosition)
  const labelVisibilityDistance = useGlobalSettingsStore((state) => state.display.labelVisibilityDistance)
  const playbackMode = useReplayStore((state) => state.playbackMode)

  // Calculate visible time window based on container width
  const visibleDurationMs = useMemo(() => {
    const timelineWidth = containerWidth - LABEL_WIDTH
    return (timelineWidth / config.timeScale) * 1000
  }, [containerWidth, config.timeScale])

  // Filter and sort timelines
  const filteredTimelines = useMemo(() => {
    // No airport selected = no timelines to show
    if (!currentAirport) {
      return []
    }

    const timelinesArray = Array.from(timelines.values())

    if (config.filterMode === 'all') {
      return timelinesArray.sort((a, b) => a.callsign.localeCompare(b.callsign))
    }

    // Filter by distance from tower
    const towerPos = getTowerPosition(currentAirport, towerHeight, customTowerPosition ?? undefined)
    const towerAltFeet = (currentAirport.elevation || 0) + towerHeight / 0.3048

    return timelinesArray
      .filter((timeline) => {
        // Use latest observation for distance calculation
        const lastObs = timeline.observations[timeline.observations.length - 1]
        if (!lastObs) return false

        const distance = calculateDistanceNM(
          towerPos.latitude,
          towerPos.longitude,
          lastObs.latitude,
          lastObs.longitude,
          towerAltFeet,
          lastObs.altitude * 3.28084, // Convert meters to feet
        )
        return distance <= labelVisibilityDistance
      })
      .sort((a, b) => a.callsign.localeCompare(b.callsign))
  }, [timelines, config.filterMode, currentAirport, towerHeight, customTowerPosition, labelVisibilityDistance])

  // Handle resize
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width)
      }
    })

    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [])

  // Handle escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Draw time ruler
  const drawRuler = useCallback(
    (now: number, startTime: number, endTime: number, replayTime: number | null) => {
      const canvas = rulerCanvasRef.current
      if (!canvas) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      const width = containerWidth
      const height = RULER_HEIGHT

      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      ctx.scale(dpr, dpr)

      // Background
      ctx.fillStyle = 'rgba(0, 0, 0, 0.3)'
      ctx.fillRect(0, 0, width, height)

      // Calculate tick interval based on zoom
      const tickIntervalSec = config.timeScale > 30 ? 1 : config.timeScale > 10 ? 5 : 10
      const tickIntervalMs = tickIntervalSec * 1000

      // Find first tick
      const firstTick = Math.ceil(startTime / tickIntervalMs) * tickIntervalMs

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)'
      ctx.fillStyle = 'rgba(255, 255, 255, 0.7)'
      ctx.font = '10px "Geist Mono", monospace'
      ctx.textAlign = 'center'

      for (let t = firstTick; t <= endTime; t += tickIntervalMs) {
        const x = LABEL_WIDTH + ((t - startTime) / 1000) * config.timeScale

        // Tick mark
        ctx.beginPath()
        ctx.moveTo(x, height - 10)
        ctx.lineTo(x, height)
        ctx.stroke()

        // Time label (relative to now)
        const relativeSec = Math.round((t - now) / 1000)
        const label = relativeSec === 0 ? 'now' : `${relativeSec}s`
        ctx.fillText(label, x, height - 14)
      }

      // Draw "NOW" indicator only in replay mode (in live mode it's at the right edge, hidden by scrollbar)
      if (replayTime !== null) {
        const nowX = LABEL_WIDTH + ((now - startTime) / 1000) * config.timeScale
        if (nowX >= LABEL_WIDTH && nowX <= width) {
          ctx.fillStyle = '#f44336'
          ctx.font = 'bold 10px "Geist", sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText('NOW', nowX, 12)
        }
      }

      // Draw "REPLAY" indicator when in replay mode
      if (replayTime !== null) {
        const replayX = LABEL_WIDTH + ((replayTime - startTime) / 1000) * config.timeScale
        if (replayX >= LABEL_WIDTH && replayX <= width) {
          ctx.fillStyle = '#ce93d8' // Purple to match replay source color
          ctx.font = 'bold 10px "Geist", sans-serif'
          ctx.fillText('REPLAY', replayX, 12)
        }
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0)
    },
    [containerWidth, config.timeScale],
  )

  // Draw tracks
  const drawTracks = useCallback(
    (now: number, startTime: number, endTime: number, replayTime: number | null) => {
      const canvas = tracksCanvasRef.current
      if (!canvas) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      const width = containerWidth
      const height = filteredTimelines.length * (config.trackHeight + TRACK_GAP)

      canvas.width = width * dpr
      canvas.height = Math.max(height, 100) * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${Math.max(height, 100)}px`
      ctx.scale(dpr, dpr)

      // Clear
      ctx.fillStyle = 'rgba(30, 30, 40, 1)'
      ctx.fillRect(0, 0, width, height)

      // Draw each track
      filteredTimelines.forEach((timeline, index) => {
        const y = index * (config.trackHeight + TRACK_GAP)
        const centerY = y + config.trackHeight / 2

        // Track background (alternating)
        ctx.fillStyle = index % 2 === 0 ? 'rgba(255, 255, 255, 0.02)' : 'rgba(255, 255, 255, 0.04)'
        ctx.fillRect(0, y, width, config.trackHeight)

        // Callsign label with delay info
        ctx.fillStyle = '#4fc3f7'
        ctx.font = '12px "Geist Mono", monospace'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        const parkedSuffix = timeline.metadata.isParked ? ' (P)' : ''
        // Show current delay in ms, with target in parentheses if different
        const currentDelay = timeline.dynamicDelay?.currentDelayMs
        const targetDelay = timeline.dynamicDelay?.targetDelayMs
        let delayInfo = ''
        if (currentDelay !== undefined) {
          const currentSec = (currentDelay / 1000).toFixed(1)
          if (targetDelay !== undefined && Math.abs(currentDelay - targetDelay) > 50) {
            const targetSec = (targetDelay / 1000).toFixed(1)
            delayInfo = ` [${currentSec}s→${targetSec}s]`
          } else {
            delayInfo = ` [${currentSec}s]`
          }
        }
        ctx.fillText(`${timeline.callsign}${parkedSuffix}${delayInfo}`, 8, centerY)

        // Draw observations
        for (const obs of timeline.observations) {
          // Skip if outside visible range
          if (obs.observedAt < startTime || obs.observedAt > endTime) continue

          const obsX = LABEL_WIDTH + ((obs.observedAt - startTime) / 1000) * config.timeScale

          // Draw latency line (observedAt to receivedAt)
          if (obs.receivedAt > obs.observedAt) {
            const receiveX = LABEL_WIDTH + ((obs.receivedAt - startTime) / 1000) * config.timeScale
            if (receiveX <= width) {
              ctx.strokeStyle = SOURCE_COLORS[obs.source]
              ctx.globalAlpha = 0.3
              ctx.lineWidth = 2
              ctx.beginPath()
              ctx.moveTo(obsX, centerY)
              ctx.lineTo(Math.min(receiveX, width), centerY)
              ctx.stroke()
              ctx.globalAlpha = 1
              ctx.lineWidth = 1
            }
          }

          // Draw observation marker
          ctx.beginPath()
          ctx.arc(obsX, centerY, MARKER_RADIUS, 0, Math.PI * 2)
          ctx.fillStyle = SOURCE_COLORS[obs.source]
          ctx.fill()
        }

        // Draw per-aircraft display delay indicator (where this aircraft is currently rendered)
        // Get dynamic delay if available, otherwise use source default
        const aircraftDelay = timeline.dynamicDelay?.currentDelayMs ?? SOURCE_DISPLAY_DELAYS[timeline.lastSource]
        const displayTime = replayTime !== null ? replayTime : now - aircraftDelay
        const delayX = LABEL_WIDTH + ((displayTime - startTime) / 1000) * config.timeScale

        if (delayX >= LABEL_WIDTH && delayX <= width) {
          // Draw a small triangle marker pointing down
          ctx.fillStyle = '#ffffff'
          ctx.globalAlpha = 0.8
          ctx.beginPath()
          ctx.moveTo(delayX, y + 2) // Top point
          ctx.lineTo(delayX - 4, y + 8) // Bottom left
          ctx.lineTo(delayX + 4, y + 8) // Bottom right
          ctx.closePath()
          ctx.fill()

          // Draw vertical line through this track
          ctx.strokeStyle = '#ffffff'
          ctx.globalAlpha = 0.4
          ctx.lineWidth = 1
          ctx.setLineDash([2, 2])
          ctx.beginPath()
          ctx.moveTo(delayX, y + 8)
          ctx.lineTo(delayX, y + config.trackHeight)
          ctx.stroke()
          ctx.setLineDash([])
          ctx.globalAlpha = 1
        }
      })

      // Draw playhead (NOW line) only in replay mode
      // In live mode it's always at the right edge, hidden by scrollbar
      if (replayTime !== null) {
        const nowX = LABEL_WIDTH + ((now - startTime) / 1000) * config.timeScale
        if (nowX >= LABEL_WIDTH && nowX <= width) {
          ctx.strokeStyle = '#f44336'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(nowX, 0)
          ctx.lineTo(nowX, height)
          ctx.stroke()
          ctx.lineWidth = 1
        }
      }

      // Draw replay playhead when in replay mode
      if (replayTime !== null) {
        const replayX = LABEL_WIDTH + ((replayTime - startTime) / 1000) * config.timeScale
        if (replayX >= LABEL_WIDTH && replayX <= width) {
          ctx.strokeStyle = '#ce93d8' // Purple to match replay source color
          ctx.lineWidth = 3
          ctx.setLineDash([])
          ctx.beginPath()
          ctx.moveTo(replayX, 0)
          ctx.lineTo(replayX, height)
          ctx.stroke()
          ctx.lineWidth = 1
        }
      }

      ctx.setTransform(1, 0, 0, 1, 0, 0)
    },
    [containerWidth, config.trackHeight, filteredTimelines, config.timeScale],
  )

  // Keep refs updated when callbacks change
  useEffect(() => {
    drawRulerRef.current = drawRuler
  }, [drawRuler])

  useEffect(() => {
    drawTracksRef.current = drawTracks
  }, [drawTracks])

  useEffect(() => {
    visibleDurationMsRef.current = visibleDurationMs
  }, [visibleDurationMs])

  // Animation loop - runs once on mount, uses refs to avoid stale closures
  useEffect(() => {
    const render = () => {
      const now = Date.now()
      const currentVisibleDuration = visibleDurationMsRef.current

      // Get fresh replay state from the store (not from stale React state)
      const replayState = useReplayStore.getState()
      let replayTime: number | null = null
      if (replayState.playbackMode !== 'live') {
        const currentSnapshot = replayState.getCurrentSnapshot()
        if (currentSnapshot) {
          replayTime = currentSnapshot.timestamp
        }
      }

      // Determine the view window:
      // - Live mode: NOW at right edge (traditional timeline view)
      // - Replay mode: replay time centered (so playhead stays visible)
      let startTime: number
      let endTime: number
      if (replayTime !== null) {
        // Replay mode: center on replay time
        endTime = replayTime + currentVisibleDuration / 2
        startTime = replayTime - currentVisibleDuration / 2
      } else {
        // Live mode: NOW at right edge
        endTime = now
        startTime = now - currentVisibleDuration
      }

      // Call draw functions via refs (always have latest version)
      drawRulerRef.current?.(now, startTime, endTime, replayTime)
      drawTracksRef.current?.(now, startTime, endTime, replayTime)

      animationIdRef.current = requestAnimationFrame(render)
    }

    animationIdRef.current = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animationIdRef.current)
  }, []) // Empty deps - runs once, uses refs for latest values

  // Handle mouse move for hover detection
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = tracksCanvasRef.current
      if (!canvas) return

      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top

      // Determine which track
      const trackIndex = Math.floor(y / (config.trackHeight + TRACK_GAP))
      if (trackIndex < 0 || trackIndex >= filteredTimelines.length) {
        setHoveredObs(null)
        return
      }

      const timeline = filteredTimelines[trackIndex]
      const now = Date.now()
      const endTime = now
      const startTime = endTime - visibleDurationMs

      // Check if mouse is near any observation
      for (const obs of timeline.observations) {
        if (obs.observedAt < startTime || obs.observedAt > endTime) continue

        const obsX = LABEL_WIDTH + ((obs.observedAt - startTime) / 1000) * config.timeScale
        const centerY = trackIndex * (config.trackHeight + TRACK_GAP) + config.trackHeight / 2

        const dx = x - obsX
        const dy = y - centerY

        if (Math.sqrt(dx * dx + dy * dy) <= MARKER_RADIUS + 3) {
          setHoveredObs({
            x: e.clientX,
            y: e.clientY,
            observation: obs,
            callsign: timeline.callsign,
            isParked: timeline.metadata.isParked,
            dynamicDelay: timeline.dynamicDelay
              ? {
                  currentDelayMs: timeline.dynamicDelay.currentDelayMs,
                  targetDelayMs: timeline.dynamicDelay.targetDelayMs,
                  intervalHistory: timeline.dynamicDelay.intervalHistory,
                  extrapolationBumpMs: timeline.dynamicDelay.extrapolationBumpMs,
                }
              : undefined,
          })
          return
        }
      }

      setHoveredObs(null)
    },
    [filteredTimelines, config.trackHeight, config.timeScale, visibleDurationMs],
  )

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts)
    return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  return (
    <div className="settings-modal-overlay">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops click propagation to overlay */}
      <div className="settings-modal timeline-debug-modal" role="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Aircraft Timeline Debug</h2>
          <button type="button" className="close-button" onClick={onClose}>
            &times;
          </button>
        </div>

        {/* Controls bar */}
        <div className="timeline-controls">
          <select
            className="timeline-filter-select"
            value={config.filterMode}
            onChange={(e) => setConfig((c) => ({ ...c, filterMode: e.target.value as FilterMode }))}
          >
            <option value="withinRange">Within Range</option>
            <option value="all">All Aircraft</option>
          </select>

          <span className="timeline-stats">{filteredTimelines.length} aircraft</span>

          {playbackMode !== 'live' && (
            <span className="timeline-replay-indicator" style={{ color: '#ce93d8' }}>
              ▶ {playbackMode === 'imported' ? 'IMPORTED' : 'REPLAY'}
            </span>
          )}

          <div className="timeline-zoom">
            <span>Zoom:</span>
            <input
              type="range"
              min={MIN_TIME_SCALE}
              max={MAX_TIME_SCALE}
              value={config.timeScale}
              onChange={(e) => setConfig((c) => ({ ...c, timeScale: Number(e.target.value) }))}
            />
          </div>

          <button
            type="button"
            className={`timeline-autoscroll ${config.autoscroll ? 'active' : ''}`}
            onClick={() => setConfig((c) => ({ ...c, autoscroll: !c.autoscroll }))}
          >
            Auto-scroll
          </button>

          <button
            type="button"
            className="timeline-autoscroll"
            disabled={isSavingDiagnostic}
            onClick={async () => {
              setIsSavingDiagnostic(true)
              try {
                const path = await saveDiagnostic()
                setSavedDiagnosticPath(path)
              } catch (err) {
                useUIFeedbackStore
                  .getState()
                  .showFeedback(`Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`, 'error')
              } finally {
                setIsSavingDiagnostic(false)
              }
            }}
            title="Export diagnostic package (.tc3d-diag) with raw timeline data"
          >
            {isSavingDiagnostic ? 'Saving...' : 'Export Diagnostic'}
          </button>

          <div className="timeline-legend">
            {(Object.entries(SOURCE_COLORS) as [AircraftDataSource, string][]).map(([source, color]) => (
              <span key={source} className="legend-item">
                <span className="legend-color" style={{ backgroundColor: color }} />
                {source}
              </span>
            ))}
          </div>
        </div>

        {/* Timeline area */}
        <div ref={containerRef} className="timeline-content">
          {/* Fixed time ruler */}
          <div className="timeline-ruler">
            <canvas ref={rulerCanvasRef} />
          </div>

          {/* Scrollable tracks */}
          <div ref={tracksContainerRef} className="timeline-tracks-container">
            <canvas ref={tracksCanvasRef} onMouseMove={handleMouseMove} onMouseLeave={() => setHoveredObs(null)} />
          </div>
        </div>

        {/* Hover tooltip */}
        {hoveredObs && (
          <div
            className="observation-tooltip"
            style={{
              left: Math.min(hoveredObs.x + 10, window.innerWidth - 250),
              top: Math.min(hoveredObs.y + 10, window.innerHeight - 300),
            }}
          >
            <div className="tooltip-header">
              {hoveredObs.callsign}
              {hoveredObs.isParked && <span className="tooltip-parked-badge">PARKED</span>}
            </div>
            <div className="tooltip-section">
              <div className="tooltip-row">
                <span className="tooltip-label">Source:</span>
                <span className="tooltip-value" style={{ color: SOURCE_COLORS[hoveredObs.observation.source] }}>
                  {hoveredObs.observation.source}
                </span>
              </div>
            </div>
            <div className="tooltip-section">
              <div className="tooltip-row">
                <span className="tooltip-label">Position:</span>
                <span className="tooltip-value">
                  {hoveredObs.observation.latitude.toFixed(4)}, {hoveredObs.observation.longitude.toFixed(4)}
                </span>
              </div>
              <div className="tooltip-row">
                <span className="tooltip-label">Altitude:</span>
                <span className="tooltip-value">{Math.round(hoveredObs.observation.altitude * 3.28084)} ft</span>
              </div>
              <div className="tooltip-row">
                <span className="tooltip-label">Groundspeed:</span>
                <span className="tooltip-value">{Math.round(hoveredObs.observation.groundspeed)} kts</span>
              </div>
              <div className="tooltip-row">
                <span className="tooltip-label">Heading:</span>
                <span className="tooltip-value">{Math.round(hoveredObs.observation.heading)}°</span>
              </div>
              {hoveredObs.observation.groundTrack !== null && (
                <div className="tooltip-row">
                  <span className="tooltip-label">Ground Track:</span>
                  <span className="tooltip-value">{Math.round(hoveredObs.observation.groundTrack)}°</span>
                </div>
              )}
            </div>
            <div className="tooltip-section timing">
              <div className="tooltip-row">
                <span className="tooltip-label">Observed:</span>
                <span className="tooltip-value">{formatTimestamp(hoveredObs.observation.observedAt)}</span>
              </div>
              <div className="tooltip-row">
                <span className="tooltip-label">Received:</span>
                <span className="tooltip-value">{formatTimestamp(hoveredObs.observation.receivedAt)}</span>
              </div>
              <div className="tooltip-row">
                <span className="tooltip-label">Latency:</span>
                <span className="tooltip-value">
                  {((hoveredObs.observation.receivedAt - hoveredObs.observation.observedAt) / 1000).toFixed(1)}s
                </span>
              </div>
            </div>
            {/* RealTraffic-specific fields */}
            {hoveredObs.observation.source === 'realtraffic' && (
              <div className="tooltip-section realtraffic">
                {hoveredObs.observation.onGround !== null && (
                  <div className="tooltip-row">
                    <span className="tooltip-label">On Ground:</span>
                    <span className="tooltip-value">{hoveredObs.observation.onGround ? 'Yes' : 'No'}</span>
                  </div>
                )}
                {hoveredObs.observation.verticalRate !== null && (
                  <div className="tooltip-row">
                    <span className="tooltip-label">Vertical Rate:</span>
                    <span className="tooltip-value">{Math.round(hoveredObs.observation.verticalRate)} fpm</span>
                  </div>
                )}
                {hoveredObs.observation.roll !== null && (
                  <div className="tooltip-row">
                    <span className="tooltip-label">Roll:</span>
                    <span className="tooltip-value">{hoveredObs.observation.roll.toFixed(1)}°</span>
                  </div>
                )}
              </div>
            )}
            {/* Dynamic delay debug info */}
            {hoveredObs.dynamicDelay && (
              <div className="tooltip-section delay-debug">
                <div className="tooltip-row">
                  <span className="tooltip-label">Current Delay:</span>
                  <span className="tooltip-value">{(hoveredObs.dynamicDelay.currentDelayMs / 1000).toFixed(2)}s</span>
                </div>
                <div className="tooltip-row">
                  <span className="tooltip-label">Target Delay:</span>
                  <span className="tooltip-value">{(hoveredObs.dynamicDelay.targetDelayMs / 1000).toFixed(2)}s</span>
                </div>
                <div className="tooltip-row">
                  <span className="tooltip-label">Extrap Bump:</span>
                  <span className="tooltip-value">{hoveredObs.dynamicDelay.extrapolationBumpMs}ms</span>
                </div>
                <div className="tooltip-row">
                  <span className="tooltip-label">Intervals:</span>
                  <span className="tooltip-value" style={{ fontSize: '9px' }}>
                    [{hoveredObs.dynamicDelay.intervalHistory.map((i) => Math.round(i)).join(', ')}]
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {savedDiagnosticPath && (
        // biome-ignore lint/a11y/noStaticElementInteractions: modal overlay backdrop
        <div
          className="settings-modal-overlay"
          role="presentation"
          style={{ zIndex: 10001 }}
          onClick={() => setSavedDiagnosticPath(null)}
        >
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: stops click propagation to overlay */}
          <div
            className="settings-modal"
            role="dialog"
            style={{ maxWidth: '500px', width: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="settings-header">
              <h2>Diagnostic Exported</h2>
              <button type="button" className="close-button" onClick={() => setSavedDiagnosticPath(null)}>
                &times;
              </button>
            </div>
            <div style={{ padding: '16px' }}>
              <p style={{ marginBottom: '12px' }}>Saved to:</p>
              <code
                style={{
                  display: 'block',
                  padding: '10px',
                  backgroundColor: 'rgba(0, 0, 0, 0.3)',
                  borderRadius: '4px',
                  wordBreak: 'break-all',
                  fontSize: '13px',
                  userSelect: 'all',
                }}
              >
                {savedDiagnosticPath}
              </code>
              <button
                type="button"
                className="control-button"
                style={{ marginTop: '16px' }}
                onClick={() => setSavedDiagnosticPath(null)}
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default AircraftTimelineModal
