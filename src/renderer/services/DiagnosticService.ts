/**
 * Diagnostic Service
 *
 * Captures raw aircraft timeline data and app state for bug reproduction.
 * Export produces a .tc3d-diag JSON file containing all AircraftTimeline
 * objects with full observation fidelity, plus a snapshot of relevant app state.
 *
 * In Tauri mode: saves to {appData}/diagnostics/ via Rust command.
 * In remote mode: POSTs to /api/diagnostic on the host server.
 */

import { invoke } from '@tauri-apps/api/core'
import { SOURCE_DISPLAY_DELAYS } from '../constants/aircraft-timeline'
import { DIAGNOSTIC_FILE_EXTENSION, DIAGNOSTIC_FILE_PREFIX, DIAGNOSTIC_VERSION } from '../constants/diagnostic'
import { GROUNDSPEED_THRESHOLD_KNOTS } from '../constants/rendering'
import { useAircraftTimelineStore } from '../stores/aircraftTimelineStore'
import { useAirportStore } from '../stores/airportStore'
import { useRealTrafficStore } from '../stores/realTrafficStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useVatsimStore } from '../stores/vatsimStore'
import { useViewportStore } from '../stores/viewportStore'
import { useVnasStore } from '../stores/vnasStore'
import { useWeatherStore } from '../stores/weatherStore'
import type { AircraftTimeline } from '../types/aircraft-timeline'
import type { DiagnosticAppState, DiagnosticPackage, SerializedTimeline } from '../types/diagnostic'
import { isTauri } from '../utils/tauriApi'

function serializeTimeline(callsign: string, timeline: AircraftTimeline): SerializedTimeline {
  return {
    callsign,
    observations: [...timeline.observations],
    metadata: { ...timeline.metadata },
    lastSource: timeline.lastSource,
    lastReceivedAt: timeline.lastReceivedAt,
    dynamicDelay: timeline.dynamicDelay
      ? { ...timeline.dynamicDelay, intervalHistory: [...timeline.dynamicDelay.intervalHistory] }
      : undefined,
  }
}

function captureAppState(): DiagnosticAppState {
  const airportState = useAirportStore.getState()
  const viewportState = useViewportStore.getState()
  const vnasState = useVnasStore.getState()
  const vatsimState = useVatsimStore.getState()
  const rtState = useRealTrafficStore.getState()
  const weatherState = useWeatherStore.getState()
  const settingsState = useSettingsStore.getState()

  const mainViewport = viewportState.getMainViewport()
  const cam = mainViewport.cameraState

  return {
    airport: airportState.currentAirport
      ? { icao: airportState.currentAirport.icao, towerHeight: airportState.towerHeight }
      : null,
    camera: {
      latitude: airportState.currentAirport?.lat ?? 0,
      longitude: airportState.currentAirport?.lon ?? 0,
      altitude: airportState.towerHeight,
      heading: cam.heading,
      pitch: cam.pitch,
    },
    vnas: {
      connected: vnasState.isConnected(),
      sessionActive: vnasState.status.state === 'connected',
    },
    vatsim: {
      lastTimestamp: vatsimState.lastVatsimTimestamp || null,
    },
    realTraffic: {
      connected: rtState.status === 'connected',
    },
    weather: {
      metar: weatherState.currentMetar?.rawOb ?? null,
    },
    settings: {
      sourceDisplayDelays: { ...SOURCE_DISPLAY_DELAYS },
      enableDynamicDisplayDelay: settingsState.advanced?.enableDynamicDisplayDelay ?? true,
      groundspeedThresholdKnots: GROUNDSPEED_THRESHOLD_KNOTS,
    },
  }
}

function buildFilename(icao: string | undefined): string {
  const date = new Date()
  const dateStr = date.toISOString().slice(0, 10)
  const timeStr = date.toISOString().slice(11, 16).replace(':', '')
  const airportStr = icao ?? 'unknown'
  return `${DIAGNOSTIC_FILE_PREFIX}-${airportStr}-${dateStr}-${timeStr}.${DIAGNOSTIC_FILE_EXTENSION}`
}

/**
 * Build a DiagnosticPackage from current app state.
 */
export function exportDiagnostic(): DiagnosticPackage {
  const { timelines, recentlyRemoved } = useAircraftTimelineStore.getState()
  const serialized: SerializedTimeline[] = []

  for (const [callsign, timeline] of timelines) {
    serialized.push(serializeTimeline(callsign, timeline))
  }

  // Include recently removed aircraft so diagnostics capture aircraft
  // that timed out before the export was triggered
  for (const [callsign, entry] of recentlyRemoved) {
    serialized.push({ ...serializeTimeline(callsign, entry.timeline), removedAt: entry.removedAt })
  }

  return {
    version: DIAGNOSTIC_VERSION,
    exportedAt: Date.now(),
    appVersion: APP_VERSION,
    timelines: serialized,
    appState: captureAppState(),
  }
}

/**
 * Save a diagnostic package to the host filesystem.
 * Returns the full path of the saved file.
 *
 * - Tauri mode: calls save_diagnostic Rust command
 * - Remote mode: POSTs to /api/diagnostic on the host
 */
export async function saveDiagnostic(): Promise<string> {
  const pkg = exportDiagnostic()
  const json = JSON.stringify(pkg)
  const filename = buildFilename(pkg.appState.airport?.icao)

  if (isTauri()) {
    const path = await invoke<string>('save_diagnostic', { filename, content: json })
    console.log(`[Diagnostic] Saved ${pkg.timelines.length} timelines to ${path}`)
    return path
  }

  // Remote mode: POST to host server
  const response = await fetch('/api/diagnostic', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, content: json }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to save diagnostic: ${text}`)
  }

  const result = (await response.json()) as { path: string }
  console.log(`[Diagnostic] Saved ${pkg.timelines.length} timelines to ${result.path}`)
  return result.path
}
