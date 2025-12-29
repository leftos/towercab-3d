import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useAircraftTimelineStore } from '@/stores/aircraftTimelineStore'
import { useAirportStore } from '@/stores/airportStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useReplayStore } from '@/stores/replayStore'
import { calculateDistanceNM } from '@/utils/interpolation'
import { getTowerPosition } from '@/utils/towerHeight'
import { SOURCE_DISPLAY_DELAYS } from '@/constants/aircraft-timeline'
import type { AircraftObservation, AircraftDataSource } from '@/types/aircraft-timeline'
import './AircraftTimelineModal.css'

interface AircraftTimelineModalProps {
  onClose: () => void
}

type FilterMode = 'all' | 'withinRange'

interface TimelineConfig {
  timeScale: number        // pixels per second
  trackHeight: number      // height of each track in pixels
  autoscroll: boolean      // follow current time
  filterMode: FilterMode
}

interface HoveredObservation {
  x: number
  y: number
  observation: AircraftObservation
  callsign: string
}

// Source colors
const SOURCE_COLORS: Record<AircraftDataSource, string> = {
  vatsim: '#4fc3f7',      // Light blue
  vnas: '#81c784',        // Green
  realtraffic: '#ffb74d', // Orange
  replay: '#ce93d8'       // Purple
}

const LABEL_WIDTH = 80
const RULER_HEIGHT = 30
const TRACK_GAP = 2
const MARKER_RADIUS = 5
const DEFAULT_TIME_SCALE = 10  // 10 px per second
const MIN_TIME_SCALE = 2
const MAX_TIME_SCALE = 50

function AircraftTimelineModal({ onClose }: AircraftTimelineModalProps) {
  const rulerCanvasRef = useRef<HTMLCanvasElement>(null)
  const tracksCanvasRef = useRef<HTMLCanvasElement>(null)
  const tracksContainerRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const [config, setConfig] = useState<TimelineConfig>({
    timeScale: DEFAULT_TIME_SCALE,
    trackHeight: 32,
    autoscroll: true,
    filterMode: 'withinRange'
  })

  const [hoveredObs, setHoveredObs] = useState<HoveredObservation | null>(null)
  const [containerWidth, setContainerWidth] = useState(800)

  // Get data from stores
  const timelines = useAircraftTimelineStore((state) => state.timelines)
  const currentAirport = useAirportStore((state) => state.currentAirport)
  const towerHeight = useAirportStore((state) => state.towerHeight)
  const customTowerPosition = useAirportStore((state) => state.customTowerPosition)
  const labelVisibilityDistance = useSettingsStore((state) => state.aircraft.labelVisibilityDistance)
  const playbackMode = useReplayStore((state) => state.playbackMode)
  const getCurrentSnapshot = useReplayStore((state) => state.getCurrentSnapshot)

  // Calculate visible time window based on container width
  const visibleDurationMs = useMemo(() => {
    const timelineWidth = containerWidth - LABEL_WIDTH
    return (timelineWidth / config.timeScale) * 1000
  }, [containerWidth, config.timeScale])

  // Filter and sort timelines
  const filteredTimelines = useMemo(() => {
    const timelinesArray = Array.from(timelines.values())

    if (config.filterMode === 'all' || !currentAirport) {
      return timelinesArray.sort((a, b) => a.callsign.localeCompare(b.callsign))
    }

    // Filter by distance from tower
    const towerPos = getTowerPosition(currentAirport, towerHeight, customTowerPosition ?? undefined)
    const towerAltFeet = (currentAirport.elevation || 0) + (towerHeight / 0.3048)

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
          lastObs.altitude * 3.28084  // Convert meters to feet
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
  const drawRuler = useCallback((now: number, startTime: number, endTime: number, replayTime: number | null) => {
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
    ctx.font = '10px monospace'
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

    // Draw "NOW" indicator
    const nowX = LABEL_WIDTH + ((now - startTime) / 1000) * config.timeScale
    if (nowX >= LABEL_WIDTH && nowX <= width) {
      ctx.fillStyle = '#f44336'
      ctx.font = 'bold 10px sans-serif'
      ctx.fillText('NOW', nowX, 12)
    }

    // Draw "REPLAY" indicator when in replay mode
    if (replayTime !== null) {
      const replayX = LABEL_WIDTH + ((replayTime - startTime) / 1000) * config.timeScale
      if (replayX >= LABEL_WIDTH && replayX <= width) {
        ctx.fillStyle = '#ce93d8'  // Purple to match replay source color
        ctx.font = 'bold 10px sans-serif'
        ctx.fillText('REPLAY', replayX, 12)
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }, [containerWidth, config.timeScale])

  // Draw tracks
  const drawTracks = useCallback((now: number, startTime: number, endTime: number, replayTime: number | null) => {
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

      // Callsign label
      ctx.fillStyle = '#4fc3f7'
      ctx.font = '12px monospace'
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(timeline.callsign, 8, centerY)

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

      // Draw display time indicator for this aircraft
      const displayDelay = SOURCE_DISPLAY_DELAYS[timeline.lastSource]
      const displayTime = now - displayDelay
      if (displayTime >= startTime && displayTime <= endTime) {
        const displayX = LABEL_WIDTH + ((displayTime - startTime) / 1000) * config.timeScale

        // Small triangle
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)'
        ctx.beginPath()
        ctx.moveTo(displayX - 4, y + 3)
        ctx.lineTo(displayX + 4, y + 3)
        ctx.lineTo(displayX, y + 10)
        ctx.closePath()
        ctx.fill()
      }
    })

    // Draw playhead (NOW line)
    const nowX = LABEL_WIDTH + ((now - startTime) / 1000) * config.timeScale
    if (nowX >= LABEL_WIDTH && nowX <= width) {
      ctx.strokeStyle = '#f44336'
      ctx.lineWidth = 2
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.moveTo(nowX, 0)
      ctx.lineTo(nowX, height)
      ctx.stroke()
      ctx.lineWidth = 1
    }

    // Draw replay playhead when in replay mode
    if (replayTime !== null) {
      const replayX = LABEL_WIDTH + ((replayTime - startTime) / 1000) * config.timeScale
      if (replayX >= LABEL_WIDTH && replayX <= width) {
        ctx.strokeStyle = '#ce93d8'  // Purple to match replay source color
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
  }, [containerWidth, config.trackHeight, filteredTimelines, config.timeScale])

  // Animation loop
  useEffect(() => {
    let animationId: number
    let lastDataSnapshot = 0
    const DATA_SNAPSHOT_INTERVAL = 200  // Take data snapshot every 200ms

    const render = () => {
      const now = Date.now()
      const endTime = config.autoscroll ? now : now
      const startTime = endTime - visibleDurationMs

      // Only update data-dependent drawing every 200ms
      if (now - lastDataSnapshot > DATA_SNAPSHOT_INTERVAL) {
        lastDataSnapshot = now
      }

      // Get replay time if in replay mode
      let replayTime: number | null = null
      if (playbackMode !== 'live') {
        const currentSnapshot = getCurrentSnapshot()
        if (currentSnapshot) {
          replayTime = currentSnapshot.timestamp
        }
      }

      drawRuler(now, startTime, endTime, replayTime)
      drawTracks(now, startTime, endTime, replayTime)

      animationId = requestAnimationFrame(render)
    }

    animationId = requestAnimationFrame(render)
    return () => cancelAnimationFrame(animationId)
  }, [config.autoscroll, visibleDurationMs, drawRuler, drawTracks, playbackMode, getCurrentSnapshot])

  // Handle mouse move for hover detection
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
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
          callsign: timeline.callsign
        })
        return
      }
    }

    setHoveredObs(null)
  }, [filteredTimelines, config.trackHeight, config.timeScale, visibleDurationMs])

  const formatTimestamp = (ts: number) => {
    const date = new Date(ts)
    return date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  return (
    <div className="settings-modal-overlay">
      <div className="settings-modal timeline-debug-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Aircraft Timeline Debug</h2>
          <button className="close-button" onClick={onClose}>&times;</button>
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
            className={`timeline-autoscroll ${config.autoscroll ? 'active' : ''}`}
            onClick={() => setConfig((c) => ({ ...c, autoscroll: !c.autoscroll }))}
          >
            Auto-scroll
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
            <canvas
              ref={tracksCanvasRef}
              onMouseMove={handleMouseMove}
              onMouseLeave={() => setHoveredObs(null)}
            />
          </div>
        </div>

        {/* Hover tooltip */}
        {hoveredObs && (
          <div
            className="observation-tooltip"
            style={{
              left: Math.min(hoveredObs.x + 10, window.innerWidth - 250),
              top: Math.min(hoveredObs.y + 10, window.innerHeight - 300)
            }}
          >
            <div className="tooltip-header">{hoveredObs.callsign}</div>
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
          </div>
        )}
      </div>
    </div>
  )
}

export default AircraftTimelineModal
