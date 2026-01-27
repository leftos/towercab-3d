/**
 * Tower Positioning Store
 *
 * Manages the two-step tower mod positioning wizard:
 * - Step 1 (Model): Position and rotate the 3D tower model
 * - Step 2 (Camera): Set the default camera viewpoint (cab position)
 *
 * Model position is stored as offsets (north/east/up in meters + rotation in degrees)
 * which are converted to absolute lat/lon when saving.
 */

import { create } from 'zustand'

// Constants for coordinate math
const METERS_PER_DEGREE_LAT = 111320

function getMetersPerDegreeLon(lat: number): number {
  return 111320 * Math.cos(lat * Math.PI / 180)
}

export type WizardStep = 'model' | 'camera'

// During Step 1, controls can be either model or camera
export type Step1ControlMode = 'model' | 'camera'

interface ModelPosition {
  lat: number
  lon: number
  height: number
  rotation: number
}

interface CameraPosition {
  lat: number
  lon: number
  height: number
  heading: number
  pitch: number
}

interface TowerPositioningState {
  // Wizard state
  isActive: boolean
  step: WizardStep
  targetIcao: string | null
  manifestPath: string | null

  // Step 1: Model positioning
  originalModelPosition: ModelPosition | null
  modelOffset: { north: number; east: number; up: number }  // Meters
  modelRotation: number  // Degrees (0-360, clockwise from north)

  // Step 1: Control mode toggle (model vs camera controls)
  step1ControlMode: Step1ControlMode

  // Cached terrain height (needed for recalculating model matrix)
  terrainHeight: number

  // Step 2: Camera positioning
  originalCameraPosition: CameraPosition | null
  cameraPosition: CameraPosition | null

  // Actions
  startPositioning: (
    icao: string,
    manifestPath: string,
    originalModelPos: ModelPosition,
    originalCameraPos: CameraPosition | null,
    terrainHeight: number
  ) => void
  proceedToStep2: () => void
  goBackToStep1: () => void
  stopPositioning: () => void
  adjustModelOffset: (axis: 'north' | 'east' | 'up', delta: number) => void
  adjustModelRotation: (delta: number) => void
  resetModelOffset: () => void
  toggleStep1ControlMode: () => void
  captureCameraPosition: (pos: CameraPosition) => void
  getAbsoluteModelPosition: () => ModelPosition | null
  setTerrainHeight: (height: number) => void
}

export const useTowerPositioningStore = create<TowerPositioningState>((set, get) => ({
  // Initial state
  isActive: false,
  step: 'model',
  targetIcao: null,
  manifestPath: null,

  originalModelPosition: null,
  modelOffset: { north: 0, east: 0, up: 0 },
  modelRotation: 0,

  step1ControlMode: 'model',

  terrainHeight: 0,

  originalCameraPosition: null,
  cameraPosition: null,

  /**
   * Start the positioning wizard at Step 1 (model positioning)
   */
  startPositioning: (icao, manifestPath, originalModelPos, originalCameraPos, terrainHeight) => {
    set({
      isActive: true,
      step: 'model',
      targetIcao: icao,
      manifestPath,
      originalModelPosition: originalModelPos,
      modelOffset: { north: 0, east: 0, up: 0 },
      modelRotation: originalModelPos.rotation,
      step1ControlMode: 'model',
      terrainHeight,
      originalCameraPosition: originalCameraPos,
      cameraPosition: originalCameraPos
    })
  },

  /**
   * Advance from Step 1 (model) to Step 2 (camera)
   */
  proceedToStep2: () => {
    set({ step: 'camera' })
  },

  /**
   * Return to Step 1 from Step 2 (keeps model changes)
   */
  goBackToStep1: () => {
    set({ step: 'model' })
  },

  /**
   * Exit the wizard and reset all state
   */
  stopPositioning: () => {
    set({
      isActive: false,
      step: 'model',
      targetIcao: null,
      manifestPath: null,
      originalModelPosition: null,
      modelOffset: { north: 0, east: 0, up: 0 },
      modelRotation: 0,
      step1ControlMode: 'model',
      terrainHeight: 0,
      originalCameraPosition: null,
      cameraPosition: null
    })
  },

  /**
   * Adjust model offset by delta along specified axis
   */
  adjustModelOffset: (axis, delta) => {
    const state = get()
    set({
      modelOffset: {
        ...state.modelOffset,
        [axis]: state.modelOffset[axis] + delta
      }
    })
  },

  /**
   * Adjust model rotation by delta (wraps at 360)
   */
  adjustModelRotation: (delta) => {
    const state = get()
    let newRotation = state.modelRotation + delta
    // Wrap to [0, 360)
    while (newRotation < 0) newRotation += 360
    while (newRotation >= 360) newRotation -= 360
    set({ modelRotation: newRotation })
  },

  /**
   * Reset model offsets and rotation to original
   */
  resetModelOffset: () => {
    const state = get()
    set({
      modelOffset: { north: 0, east: 0, up: 0 },
      modelRotation: state.originalModelPosition?.rotation ?? 0
    })
  },

  /**
   * Toggle between model and camera controls during Step 1
   */
  toggleStep1ControlMode: () => {
    const state = get()
    if (state.step !== 'model') return
    set({
      step1ControlMode: state.step1ControlMode === 'model' ? 'camera' : 'model'
    })
  },

  /**
   * Capture current camera position for Step 2
   */
  captureCameraPosition: (pos) => {
    set({ cameraPosition: pos })
  },

  /**
   * Convert model offsets to absolute lat/lon position
   */
  getAbsoluteModelPosition: () => {
    const state = get()
    if (!state.originalModelPosition) return null

    const baseLat = state.originalModelPosition.lat
    const baseLon = state.originalModelPosition.lon
    const baseHeight = state.originalModelPosition.height

    // Convert meter offsets to lat/lon
    const newLat = baseLat + state.modelOffset.north / METERS_PER_DEGREE_LAT
    const newLon = baseLon + state.modelOffset.east / getMetersPerDegreeLon(baseLat)
    const newHeight = baseHeight + state.modelOffset.up

    return {
      lat: newLat,
      lon: newLon,
      height: newHeight,
      rotation: state.modelRotation
    }
  },

  /**
   * Update cached terrain height
   */
  setTerrainHeight: (height) => {
    set({ terrainHeight: height })
  }
}))

export default useTowerPositioningStore
