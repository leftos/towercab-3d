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

// ============================================================================
// QUICKSELECT ALGORITHM
// ============================================================================
// O(n) average-case algorithm to find the k smallest elements
// Much faster than O(n log n) full sort when we only need top-N

interface AircraftWithDistance {
  callsign: string
  aircraft: InterpolatedAircraftState
  distance: number
}

/**
 * Partition array around a pivot (Lomuto partition scheme)
 * Returns the final index of the pivot
 */
function partition(arr: AircraftWithDistance[], left: number, right: number): number {
  const pivot = arr[right].distance
  let i = left

  for (let j = left; j < right; j++) {
    if (arr[j].distance <= pivot) {
      // Swap arr[i] and arr[j]
      const temp = arr[i]
      arr[i] = arr[j]
      arr[j] = temp
      i++
    }
  }

  // Swap arr[i] and arr[right] (put pivot in correct position)
  const temp = arr[i]
  arr[i] = arr[right]
  arr[right] = temp

  return i
}

/**
 * Quickselect: rearrange array so that the k smallest elements are at indices 0..k-1
 * Average O(n) time complexity vs O(n log n) for full sort
 *
 * After this function, arr[0..k-1] contains the k smallest elements (not necessarily sorted)
 */
function quickselect(arr: AircraftWithDistance[], k: number): void {
  if (arr.length <= k) return // Already small enough

  let left = 0
  let right = arr.length - 1

  while (left < right) {
    const pivotIndex = partition(arr, left, right)

    if (pivotIndex === k - 1) {
      // Pivot is at the boundary - we're done
      return
    } else if (pivotIndex < k - 1) {
      // Need more elements on the left, search right partition
      left = pivotIndex + 1
    } else {
      // Too many elements on the left, search left partition
      right = pivotIndex - 1
    }
  }
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
  const aircraftWithDistance: AircraftWithDistance[] = []

  // Track always-include aircraft separately for guaranteed inclusion
  let alwaysIncludeEntry: AircraftWithDistance | null = null

  for (const [callsign, aircraft] of interpolatedAircraft) {
    const distance = calculateDistanceNM(
      cameraPos.lat,
      cameraPos.lon,
      aircraft.interpolatedLatitude,
      aircraft.interpolatedLongitude
    )

    // Include if within radius OR if it's the always-include callsign
    if (distance <= effectiveRadiusNM || callsign === alwaysInclude) {
      const entry = { callsign, aircraft, distance }
      aircraftWithDistance.push(entry)

      // Track always-include for later
      if (callsign === alwaysInclude) {
        alwaysIncludeEntry = entry
      }
    }
  }

  // Use quickselect O(n) instead of sort O(n log n) to find closest N aircraft
  // After quickselect, arr[0..k-1] contains the k smallest elements (unordered)
  quickselect(aircraftWithDistance, effectiveMaxAircraft)

  // Take the first effectiveMaxAircraft elements (these are the closest, but unordered)
  const finalList = aircraftWithDistance.slice(0, Math.min(effectiveMaxAircraft, aircraftWithDistance.length))

  // Ensure always-include aircraft is in the final list
  if (alwaysInclude && alwaysIncludeEntry) {
    const alwaysIncludeInList = finalList.some(a => a.callsign === alwaysInclude)
    if (!alwaysIncludeInList) {
      // Replace the last element (one of the k-th closest) with always-include
      if (finalList.length >= effectiveMaxAircraft) {
        finalList[finalList.length - 1] = alwaysIncludeEntry
      } else {
        finalList.push(alwaysIncludeEntry)
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
