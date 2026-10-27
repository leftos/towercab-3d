import { describe, expect, it, vi } from 'vitest'
import { useWeatherStore } from '@/stores/weatherStore'

describe('weatherStore.updateCameraPosition', () => {
  it('does not write cameraPosition when the position is unchanged', () => {
    useWeatherStore.setState({
      cameraPosition: { lat: 37.7213, lon: -122.2208 },
      useInterpolation: false,
      useNearestMetar: false,
    })
    const stored = useWeatherStore.getState().cameraPosition
    const listener = vi.fn()
    const unsubscribe = useWeatherStore.subscribe(listener)

    useWeatherStore.getState().updateCameraPosition(37.7213, -122.2208)
    unsubscribe()

    expect(listener).not.toHaveBeenCalled()
    expect(useWeatherStore.getState().cameraPosition).toBe(stored)
  })

  it('writes cameraPosition and notifies when the position moves', () => {
    useWeatherStore.setState({
      cameraPosition: { lat: 37.7213, lon: -122.2208 },
      useInterpolation: false,
      useNearestMetar: false,
    })
    const listener = vi.fn()
    const unsubscribe = useWeatherStore.subscribe(listener)

    useWeatherStore.getState().updateCameraPosition(37.7231, -122.2208)
    unsubscribe()

    expect(listener).toHaveBeenCalledTimes(1)
    expect(useWeatherStore.getState().cameraPosition).toEqual({ lat: 37.7231, lon: -122.2208 })
  })
})
