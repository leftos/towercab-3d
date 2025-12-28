/**
 * Render Culling Utility
 *
 * Filters interpolated aircraft for rendering based on camera position,
 * distance culling, and max aircraft limits. This is an intermediate layer
 * between data interpolation and rendering.
 *
 * The filtering is applied every frame based on current camera position,
 * ensuring that aircraft closest to the camera are prioritized for rendering.
 *
 * @see useAircraftInterpolation - Provides interpolated aircraft data
 * @see useAircraftModels - Consumes filtered aircraft for 3D rendering
 * @see useCesiumLabels - Consumes filtered aircraft for label rendering
 */

import * as Cesium from 'cesium'
import { useSettingsStore } from '../stores/settingsStore'
import type { InterpolatedAircraftState } from '../types/vatsim'

// ============================================================================
// FRAME-LEVEL CACHING
// ============================================================================
// Cache the filtered result for the duration of a single frame.
// Both useAircraftModels (preRender) and useCesiumLabels (postRender) call
// this function each frame. Caching prevents redundant O(n) filtering.
// We use Cesium's frameNumber to ensure cache is valid within the same render.

interface CachedCullingResult {
  /** Cesium frame number when this cache was created */
  frameNumber: number
  /** The interpolatedAircraft Map reference we filtered */
  sourceMapRef: Map<string, InterpolatedAircraftState>
  /** Cached result */
  result: RenderCullingResult
}

let cachedCullingResult: CachedCullingResult | null = null

/**
 * Calculate distance in nautical miles between two lat/lon points
 * Uses Haversine formula for accuracy
 */
function calculateDistanceNM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 3440.065 // Earth radius in nautical miles
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) *
    Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

/**
 * Get camera position in lat/lon from Cesium viewer
 */
function getCameraLatLon(viewer: Cesium.Viewer | null): { lat: number; lon: number } | null {
  if (!viewer?.camera) return null

  const cartographic = viewer.camera.positionCartographic
  if (!cartographic) return null

  return {
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: Cesium.Math.toDegrees(cartographic.longitude)
  }
}

export interface RenderCullingOptions {
  /** Cesium viewer for camera position */
  viewer: Cesium.Viewer | null
  /** All interpolated aircraft (unfiltered) */
  interpolatedAircraft: Map<string, InterpolatedAircraftState>
  /** Override max aircraft limit (uses settings if not provided) */
  maxAircraft?: number
  /** Override render radius in NM (uses settings if not provided) */
  renderRadiusNM?: number
  /** Always include this callsign regardless of culling (e.g., followed aircraft) */
  alwaysInclude?: string | null
}

export interface RenderCullingResult {
  /** Filtered aircraft map for rendering */
  filteredAircraft: Map<string, InterpolatedAircraftState>
  /** Number of aircraft before filtering */
  totalCount: number
  /** Number of aircraft after filtering */
  filteredCount: number
}

/**
 * Filters interpolated aircraft for rendering based on camera position.
 *
 * This is a PURE FUNCTION designed to be called from within animation frame
 * callbacks (preRender/postRender). It reads settings directly from the store
 * using getState() for synchronous access.
 *
 * Uses settings for:
 * - maxAircraftDisplay: Maximum number of aircraft to render
 * - aircraftDataRadiusNM: Maximum distance from camera to render aircraft
 *
 * Aircraft are sorted by distance from camera, closest first, then limited
 * to the max count. The followed aircraft is always included if specified.
 *
 * Results are cached for the duration of a single frame to avoid redundant
 * filtering when called from both preRender (models) and postRender (labels).
 */
export function filterAircraftForRendering({
  viewer,
  interpolatedAircraft,
  maxAircraft,
  renderRadiusNM,
  alwaysInclude
}: RenderCullingOptions): RenderCullingResult {
  // Get current frame number from Cesium scene (0 if viewer not available)
  // frameState is not in Cesium's public types but exists at runtime
  const frameNumber = (viewer?.scene as { frameState?: { frameNumber?: number } })?.frameState?.frameNumber ?? 0

  // Check cache: if we filtered the same Map within the same frame, reuse result
  // We check the Map reference (not contents) since it's the same shared Map
  // that gets mutated by the interpolation loop
  if (cachedCullingResult &&
      cachedCullingResult.sourceMapRef === interpolatedAircraft &&
      cachedCullingResult.frameNumber === frameNumber &&
      frameNumber > 0) {
    return cachedCullingResult.result
  }

  // Get settings for culling limits (synchronous access from animation callback)
  const settings = useSettingsStore.getState()
  const maxAircraftDisplay = settings.aircraft.maxAircraftDisplay
  const aircraftDataRadiusNM = settings.memory.aircraftDataRadiusNM

  // Use provided values or fall back to settings
  const effectiveMaxAircraft = maxAircraft ?? maxAircraftDisplay
  const effectiveRadiusNM = renderRadiusNM ?? aircraftDataRadiusNM

  const totalCount = interpolatedAircraft.size

  // Early exit if no filtering needed
  if (totalCount === 0) {
    const result: RenderCullingResult = {
      filteredAircraft: interpolatedAircraft,
      totalCount: 0,
      filteredCount: 0
    }
    // Cache even empty results
    cachedCullingResult = { frameNumber, sourceMapRef: interpolatedAircraft, result }
    return result
  }

  // Get camera position
  const cameraPos = getCameraLatLon(viewer)
  if (!cameraPos) {
    // No camera position available - return all aircraft
    const result: RenderCullingResult = {
      filteredAircraft: interpolatedAircraft,
      totalCount,
      filteredCount: totalCount
    }
    cachedCullingResult = { frameNumber, sourceMapRef: interpolatedAircraft, result }
    return result
  }

  // Calculate distance for each aircraft and filter by radius
  const aircraftWithDistance: Array<{
    callsign: string
    aircraft: InterpolatedAircraftState
    distance: number
  }> = []

  for (const [callsign, aircraft] of interpolatedAircraft) {
    const distance = calculateDistanceNM(
      cameraPos.lat,
      cameraPos.lon,
      aircraft.interpolatedLatitude,
      aircraft.interpolatedLongitude
    )

    // Include if within radius OR if it's the always-include callsign
    if (distance <= effectiveRadiusNM || callsign === alwaysInclude) {
      aircraftWithDistance.push({ callsign, aircraft, distance })
    }
  }

  // Sort by distance (closest first)
  aircraftWithDistance.sort((a, b) => a.distance - b.distance)

  // Ensure always-include aircraft is in the final list
  // If it was culled by max count, we need to add it back
  let finalList = aircraftWithDistance.slice(0, effectiveMaxAircraft)

  if (alwaysInclude) {
    const alwaysIncludeInList = finalList.some(a => a.callsign === alwaysInclude)
    if (!alwaysIncludeInList) {
      // Find it in the full list and add it
      const alwaysIncludeAircraft = aircraftWithDistance.find(a => a.callsign === alwaysInclude)
      if (alwaysIncludeAircraft) {
        // Replace the farthest aircraft with the always-include one
        finalList = finalList.slice(0, effectiveMaxAircraft - 1)
        finalList.push(alwaysIncludeAircraft)
      }
    }
  }

  // Build filtered map
  const filteredAircraft = new Map<string, InterpolatedAircraftState>()
  for (const { callsign, aircraft } of finalList) {
    filteredAircraft.set(callsign, aircraft)
  }

  const result: RenderCullingResult = {
    filteredAircraft,
    totalCount,
    filteredCount: filteredAircraft.size
  }

  // Cache for reuse within the same frame
  cachedCullingResult = { frameNumber, sourceMapRef: interpolatedAircraft, result }

  return result
}

export default filterAircraftForRendering
