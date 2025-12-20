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

interface MeasureState {
  // Measuring mode state
  isActive: boolean

  // Points
  point1: MeasurePoint | null
  point2: MeasurePoint | null

  // Calculated distance
  distanceMeters: number | null

  // Actions
  startMeasuring: () => void
  stopMeasuring: () => void
  toggleMeasuring: () => void
  setPoint1: (point: MeasurePoint) => void
  setPoint2: (point: MeasurePoint) => void
  clearMeasurement: () => void
}

/**
 * Calculate the geodesic (great-circle) distance between two points on Earth
 */
function calculateGeodesicDistance(point1: MeasurePoint, point2: MeasurePoint): number {
  const geodesic = new Cesium.EllipsoidGeodesic(
    Cesium.Cartographic.fromDegrees(point1.cartographic.longitude, point1.cartographic.latitude),
    Cesium.Cartographic.fromDegrees(point2.cartographic.longitude, point2.cartographic.latitude)
  )
  return geodesic.surfaceDistance
}

export const useMeasureStore = create<MeasureState>((set, get) => ({
  // Initial state
  isActive: false,
  point1: null,
  point2: null,
  distanceMeters: null,

  startMeasuring: () => {
    set({
      isActive: true,
      point1: null,
      point2: null,
      distanceMeters: null
    })
  },

  stopMeasuring: () => {
    set({
      isActive: false,
      point1: null,
      point2: null,
      distanceMeters: null
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

  setPoint1: (point: MeasurePoint) => {
    set({
      point1: point,
      point2: null,
      distanceMeters: null
    })
  },

  setPoint2: (point: MeasurePoint) => {
    const state = get()
    if (!state.point1) return

    const distance = calculateGeodesicDistance(state.point1, point)
    set({
      point2: point,
      distanceMeters: distance
    })
  },

  clearMeasurement: () => {
    set({
      point1: null,
      point2: null,
      distanceMeters: null
    })
  }
}))
