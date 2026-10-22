/**
 * useTowerModel Hook
 *
 * Loads the modded tower cab glTF for the current airport as a Cesium model, so it writes the
 * scene's depth (clouds and fog of the weather stage stop at it, terrain and aircraft hide it
 * normally), casts and receives Cesium shadows, and is lit by the Cesium sun.
 *
 * One cab per airport, swapped on airport change. The position comes from
 * `modService.getTowerPlacement` (manifest `modelPosition`, then tower-positions, else no cab).
 * The cab's base sits on the ground height `resolveGroundHeight` picks (terrain sample, loaded
 * globe tile, field elevation) plus the placement height. When the terrain provider is not ready
 * at load, the cab is placed on the field elevation and re-placed once terrain arrives.
 *
 * At night the cab darkens with the scene: its light colour and image-based lighting follow the
 * same sun-elevation curve and the same settings as the imagery darkening.
 *
 * While the positioning wizard edits the model step for the current airport, every offset or
 * rotation change rewrites the model matrix without reloading the glTF.
 */

import * as Cesium from 'cesium'
import { useCallback, useEffect, useRef } from 'react'
import { geoidService } from '@/services/GeoidService'
import { modService } from '@/services/ModService'
import { useAirportStore } from '@/stores/airportStore'
import { useTowerPositioningStore } from '@/stores/towerPositioningStore'
import type { TowerModelHandle } from '@/types'
import { neutralEnvironmentMapOptions } from '@/utils/environmentMap'
import { towerModelMatrix } from '@/utils/modelOrientation'
import { cabNightFactor } from '@/utils/nightBrightness'
import { convertToAssetUrlSync } from '@/utils/tauriApi'
import { feetToMeters, resolveGroundHeight } from '@/utils/towerHeight'

export interface UseTowerModelOptions {
  /** Sun elevation in degrees at the camera, or null before it is known */
  sunElevation: number | null
  /** Whether night darkening applies (the setting is on and lighting is on) */
  nightDarkeningEnabled: boolean
  /** Night darkening intensity setting (0.0-1.0) */
  nightDarkeningIntensity: number
}

/** A terrain provider that can give real heights: the bare ellipsoid stands in until world terrain loads. */
function terrainReady(provider: Cesium.TerrainProvider | undefined): provider is Cesium.TerrainProvider {
  return provider !== undefined && !(provider instanceof Cesium.EllipsoidTerrainProvider)
}

/**
 * Lights the cab at a fraction of the scene's light. At full light the model uses the scene light
 * itself, so with night darkening off it is exactly as bright as everything else.
 */
function applyNightFactor(model: Cesium.Model, scene: Cesium.Scene, factor: number): void {
  if (factor >= 1) {
    // Cesium's declarations omit that undefined restores the scene light.
    model.lightColor = undefined as unknown as Cesium.Cartesian3
  } else {
    const { color, intensity } = scene.light
    model.lightColor = new Cesium.Cartesian3(
      color.red * intensity * factor,
      color.green * intensity * factor,
      color.blue * intensity * factor,
    )
  }
  model.imageBasedLighting.imageBasedLightingFactor = new Cesium.Cartesian2(factor, factor)
}

type PositioningState = ReturnType<typeof useTowerPositioningStore.getState>

/**
 * The positioning wizard's live placement of an airport's cab, or null when the wizard is not
 * editing that cab's model step.
 */
function wizardMatrix(
  state: PositioningState,
  icao: string | null,
  ground: number,
  scale: number,
): Cesium.Matrix4 | null {
  if (!state.isActive || state.step !== 'model' || state.targetIcao?.toUpperCase() !== icao) {
    return null
  }
  const position = state.getAbsoluteModelPosition()
  if (!position) {
    return null
  }
  return towerModelMatrix(position.lon, position.lat, ground + position.height, position.rotation, scale)
}

function removeModel(viewer: Cesium.Viewer, model: Cesium.Model): void {
  viewer.scene.primitives.remove(model)
  if (!model.isDestroyed()) {
    model.destroy()
  }
}

/**
 * Loads and places the current airport's tower cab model in the Cesium scene.
 *
 * @param viewer - Cesium viewer (null during initialization)
 * @param options - Night lighting inputs
 * @returns Getter for the cab's state, for the dev harness
 */
export function useTowerModel(viewer: Cesium.Viewer | null, options: UseTowerModelOptions): () => TowerModelHandle {
  const { sunElevation, nightDarkeningEnabled, nightDarkeningIntensity } = options

  const currentAirport = useAirportStore((state) => state.currentAirport)
  const icao = currentAirport?.icao?.toUpperCase() ?? null
  const fieldElevationFt = currentAirport?.elevation ?? 0

  const modelRef = useRef<Cesium.Model | null>(null)
  const currentIcaoRef = useRef<string | null>(null)
  const loadingIcaoRef = useRef<string | null>(null)
  // Ground under the cab and its scale, kept for the wizard's live edits.
  const groundHeightRef = useRef<number>(0)
  const scaleRef = useRef<number>(1.0)

  const nightFactor = cabNightFactor(sunElevation, nightDarkeningIntensity, nightDarkeningEnabled)
  const nightFactorRef = useRef<number>(nightFactor)
  nightFactorRef.current = nightFactor

  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !icao || icao === currentIcaoRef.current) {
      return
    }

    loadingIcaoRef.current = icao
    if (modelRef.current) {
      removeModel(viewer, modelRef.current)
      modelRef.current = null
      currentIcaoRef.current = null
    }

    const towerMod = modService.getTowerModel(icao)
    if (!towerMod) {
      return
    }
    const placement = modService.getTowerPlacement(icao)
    if (!placement) {
      console.warn(`[useTowerModel] No position available for tower mod at ${icao}`)
      return
    }

    const modelUrl = convertToAssetUrlSync(towerMod.modelUrl)
    const scale = towerMod.manifest.scale ?? 1.0
    scaleRef.current = scale
    const fieldEllipsoidal = geoidService.mslToEllipsoidal(placement.lat, placement.lon, feetToMeters(fieldElevationFt))
    const cartographic = Cesium.Cartographic.fromDegrees(placement.lon, placement.lat)
    // A wizard edit in progress wins over the manifest placement, so late terrain keeps it.
    const matrixAt = (ground: number) =>
      wizardMatrix(useTowerPositioningStore.getState(), icao, ground, scale) ??
      towerModelMatrix(placement.lon, placement.lat, ground + placement.height, placement.rotation, scale)

    console.log(`[useTowerModel] Loading tower model for ${icao}:`, {
      modelUrl,
      position: { lat: placement.lat, lon: placement.lon },
      height: placement.height,
      rotation: placement.rotation,
      source: placement.source,
      scale,
    })

    let cancelled = false
    let loadStarted = false
    let removeTerrainListener: Cesium.Event.RemoveCallback | null = null
    const isCurrent = () => !cancelled && loadingIcaoRef.current === icao && !viewer.isDestroyed()
    const globeHeight = () => viewer.scene.globe.getHeight(cartographic)

    const loadAt = (ground: number): void => {
      groundHeightRef.current = ground
      if (modelRef.current && currentIcaoRef.current === icao) {
        modelRef.current.modelMatrix = matrixAt(ground)
        return
      }
      if (loadStarted) {
        // The load in flight reads the latest ground when it lands.
        return
      }
      loadStarted = true
      Cesium.Model.fromGltfAsync({
        url: modelUrl,
        modelMatrix: matrixAt(ground),
        show: true,
        shadows: Cesium.ShadowMode.ENABLED,
        environmentMapOptions: neutralEnvironmentMapOptions(),
      })
        .then((model) => {
          if (!isCurrent()) {
            model.destroy()
            return
          }
          model.modelMatrix = matrixAt(groundHeightRef.current)
          applyNightFactor(model, viewer.scene, nightFactorRef.current)
          viewer.scene.primitives.add(model)
          modelRef.current = model
          currentIcaoRef.current = icao
          console.log(
            `[useTowerModel] Tower model loaded for ${icao} at ground ${groundHeightRef.current.toFixed(1)} m`,
          )
        })
        .catch((error) => {
          console.error(`[useTowerModel] Failed to load tower model for ${icao}:`, error)
        })
    }

    const sampleAndPlace = (provider: Cesium.TerrainProvider): void => {
      Cesium.sampleTerrainMostDetailed(provider, [cartographic.clone()])
        .then((samples) => {
          if (isCurrent()) {
            loadAt(resolveGroundHeight(samples[0]?.height, globeHeight(), fieldEllipsoidal))
          }
        })
        .catch((error) => {
          console.warn(`[useTowerModel] Failed to sample terrain for ${icao}; placing on the field elevation:`, error)
          if (isCurrent()) {
            loadAt(resolveGroundHeight(undefined, globeHeight(), fieldEllipsoidal))
          }
        })
    }

    const provider = viewer.terrainProvider as Cesium.TerrainProvider | undefined
    if (terrainReady(provider)) {
      sampleAndPlace(provider)
    } else {
      loadAt(resolveGroundHeight(undefined, globeHeight(), fieldEllipsoidal))
      removeTerrainListener = viewer.scene.globe.terrainProviderChanged.addEventListener(() => {
        const next = viewer.terrainProvider as Cesium.TerrainProvider | undefined
        if (!isCurrent() || !terrainReady(next)) {
          return
        }
        removeTerrainListener?.()
        removeTerrainListener = null
        sampleAndPlace(next)
      })
    }

    return () => {
      cancelled = true
      removeTerrainListener?.()
      if (modelRef.current && !viewer.isDestroyed()) {
        removeModel(viewer, modelRef.current)
      }
      modelRef.current = null
      currentIcaoRef.current = null
    }
  }, [viewer, icao, fieldElevationFt])

  useEffect(() => {
    const model = modelRef.current
    if (!viewer || viewer.isDestroyed() || !model) {
      return
    }
    applyNightFactor(model, viewer.scene, nightFactor)
  }, [viewer, nightFactor])

  useEffect(() => {
    return () => {
      modelRef.current = null
      currentIcaoRef.current = null
      loadingIcaoRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) {
      return
    }

    let prevOffset = { north: 0, east: 0, up: 0 }
    let prevRotation = 0

    return useTowerPositioningStore.subscribe((state) => {
      const model = modelRef.current
      if (!model) {
        return
      }
      if (
        state.modelOffset.north === prevOffset.north &&
        state.modelOffset.east === prevOffset.east &&
        state.modelOffset.up === prevOffset.up &&
        state.modelRotation === prevRotation
      ) {
        return
      }
      const matrix = wizardMatrix(state, currentIcaoRef.current, groundHeightRef.current, scaleRef.current)
      if (!matrix) {
        return
      }
      prevOffset = { ...state.modelOffset }
      prevRotation = state.modelRotation
      model.modelMatrix = matrix
    })
  }, [viewer])

  return useCallback(
    () => ({
      loaded: modelRef.current !== null,
      modelMatrix: modelRef.current ? Cesium.Matrix4.toArray(modelRef.current.modelMatrix) : null,
      nightFactor: nightFactorRef.current,
    }),
    [],
  )
}
