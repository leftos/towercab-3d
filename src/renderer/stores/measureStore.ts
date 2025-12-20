import { create } from 'zustand'
import * as Cesium from 'cesium'

export interface MeasurePoint {
  cartesian: Cesium.Cartesian3
  cartographic: {
    latitude: number  // degrees
    longitude: number // degrees
    height: number    // meters
  }
}

export interface Measurement {
  id: string
  point1: MeasurePoint
  point2: MeasurePoint
  distanceMeters: number
}

interface MeasureState {
  // Measuring mode state
  isActive: boolean

  // Completed measurements (can have multiple)
  measurements: Measurement[]

  // Current in-progress measurement
  pendingPoint: MeasurePoint | null  // First point clicked, waiting for second
  previewPoint: MeasurePoint | null  // Mouse hover position for live preview
  previewDistance: number | null     // Distance from pendingPoint to previewPoint

  // Actions
  startMeasuring: () => void
  stopMeasuring: () => void
  toggleMeasuring: () => void
  setPendingPoint: (point: MeasurePoint) => void
  setPreviewPoint: (point: MeasurePoint | null) => void
  completeMeasurement: (point: MeasurePoint) => void
  cancelPendingMeasurement: () => void
  removeMeasurement: (id: string) => void
  clearAllMeasurements: () => void
}

/**
 * Calculate the geodesic (great-circle) distance between two points on Earth
 */
export function calculateGeodesicDistance(point1: MeasurePoint, point2: MeasurePoint): number {
  const geodesic = new Cesium.EllipsoidGeodesic(
    Cesium.Cartographic.fromDegrees(point1.cartographic.longitude, point1.cartographic.latitude),
    Cesium.Cartographic.fromDegrees(point2.cartographic.longitude, point2.cartographic.latitude)
  )
  return geodesic.surfaceDistance
}

/**
 * Generate a unique ID for measurements
 */
function generateId(): string {
  return `measure_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

export const useMeasureStore = create<MeasureState>((set, get) => ({
  // Initial state
  isActive: false,
  measurements: [],
  pendingPoint: null,
  previewPoint: null,
  previewDistance: null,

  startMeasuring: () => {
    set({
      isActive: true,
      pendingPoint: null,
      previewPoint: null,
      previewDistance: null
    })
  },

  stopMeasuring: () => {
    set({
      isActive: false,
      pendingPoint: null,
      previewPoint: null,
      previewDistance: null
    })
  },

  toggleMeasuring: () => {
    const state = get()
    if (state.isActive) {
      state.stopMeasuring()
    } else {
      state.startMeasuring()
    }
  },

  setPendingPoint: (point: MeasurePoint) => {
    set({
      pendingPoint: point,
      previewPoint: null,
      previewDistance: null
    })
  },

  setPreviewPoint: (point: MeasurePoint | null) => {
    const state = get()
    if (!state.pendingPoint || !point) {
      set({ previewPoint: null, previewDistance: null })
      return
    }

    const distance = calculateGeodesicDistance(state.pendingPoint, point)
    set({
      previewPoint: point,
      previewDistance: distance
    })
  },

  completeMeasurement: (point: MeasurePoint) => {
    const state = get()
    if (!state.pendingPoint) return

    const distance = calculateGeodesicDistance(state.pendingPoint, point)
    const newMeasurement: Measurement = {
      id: generateId(),
      point1: state.pendingPoint,
      point2: point,
      distanceMeters: distance
    }

    set({
      measurements: [...state.measurements, newMeasurement],
      pendingPoint: null,
      previewPoint: null,
      previewDistance: null,
      // Keep measuring mode active so user can add more measurements
      isActive: true
    })
  },

  cancelPendingMeasurement: () => {
    set({
      pendingPoint: null,
      previewPoint: null,
      previewDistance: null
    })
  },

  removeMeasurement: (id: string) => {
    const state = get()
    set({
      measurements: state.measurements.filter(m => m.id !== id)
    })
  },

  clearAllMeasurements: () => {
    set({
      measurements: [],
      pendingPoint: null,
      previewPoint: null,
      previewDistance: null
    })
  }
}))
