/**
 * useBabylonTowerModel Hook
 *
 * Loads modded tower cab glTF models into the Babylon.js overlay scene so that
 * weather meshes (fog dome, cloud planes/domes) — which already live in Babylon —
 * depth-test correctly against the cab geometry. Replaces the previous Cesium-side
 * `useTowerModel` hook, which couldn't share a depth buffer with Babylon and let
 * weather paint over the cab interior.
 *
 * Lifecycle, position math, and wizard live-edit contract mirror the previous
 * Cesium implementation exactly (`useTowerModel.ts:1-310` in git history). Behaviors
 * preserved:
 *   - One cab per airport, swapped on airport change
 *   - Async terrain sampling with fallback to placement-only height on failure
 *   - `loadingIcaoRef` race guard against airport changes mid-load
 *   - Manifest fallback chain (modelPosition → tower-positions → skip)
 *   - Wizard Step 1 live edit via `towerPositioningStore` subscription
 *
 * Known limitations carried over from the migration:
 *   - Aircraft 3D models still render in Cesium; an aircraft passing in front of a
 *     cab pillar from camera POV would still draw over the pillar. Practical impact
 *     is low (cab pillars rarely intersect aircraft positions).
 *   - Aircraft GUI labels are screen-space and don't depth-test against cab geometry.
 *   - Cesium terrain can't receive shadows from the Babylon directional light, so the
 *     cab no longer casts a shadow on the tarmac (it self-shadows internally though).
 */

import * as BABYLON from '@babylonjs/core'
import * as Cesium from 'cesium'
import { useEffect, useRef } from 'react'
import { modService } from '../services/ModService'
import { useAirportStore } from '../stores/airportStore'
import { useTowerPositioningStore } from '../stores/towerPositioningStore'
import { ecefToEnu, enuToBabylonPosition } from '../utils/enuTransforms'
import { convertToAssetUrlSync } from '../utils/tauriApi'

interface UseBabylonTowerModelOptions {
  /** Babylon scene to load the cab into */
  scene: BABYLON.Scene | null
  /** Cesium viewer used for terrain height sampling (terrain provider lives in Cesium) */
  cesiumViewer: Cesium.Viewer | null
  /** Getter for the ECEF→ENU transform anchored at the current root-node origin */
  getFixedToEnu: () => Cesium.Matrix4 | null
  /** Shadow generator on the Babylon directional light (optional but recommended) */
  shadowGenerator: BABYLON.ShadowGenerator | null
  /** Whether the hook is enabled */
  enabled?: boolean
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180

/**
 * Apply position/rotation/scale to the glTF __root__ mesh, composing our heading
 * rotation and uniform scale on top of the handedness conversion the glTF loader
 * baked in. Centralizes the math so initial-load and wizard-live-edit paths stay in sync.
 *
 * The glTF loader produces __root__ with rotationQuaternion=(0,1,0,0) and scaling=(1,1,-1)
 * to convert from glTF's RH coords to Babylon's LH coords. We must preserve these baseline
 * transforms or the cab geometry mirrors / offsets incorrectly.
 */
function applyRootTransform(
  root: BABYLON.AbstractMesh,
  baseRotationQuat: BABYLON.Quaternion,
  baseScaling: BABYLON.Vector3,
  ecefPos: Cesium.Cartesian3,
  fixedToEnu: Cesium.Matrix4,
  rotationDegrees: number,
  scale: number,
): void {
  const enuPos = ecefToEnu(ecefPos, fixedToEnu)
  const babPos = enuToBabylonPosition(enuPos)
  root.position.copyFrom(babPos)

  // Compose: handedness flip first, then heading rotation in Babylon space.
  // Cesium HPR heading is clockwise from north around Up; Babylon Y-axis rotation is
  // counter-clockwise viewed from above, so we negate to match real-world heading.
  const headingQuat = BABYLON.Quaternion.RotationAxis(BABYLON.Vector3.Up(), -toRadians(rotationDegrees))
  root.rotationQuaternion = headingQuat.multiply(baseRotationQuat)
  // Clear euler rotation so it doesn't fight the quaternion path.
  root.rotation.set(0, 0, 0)

  // Multiply uniform scale into the handedness scaling vector to preserve the Z-flip.
  root.scaling.set(baseScaling.x * scale, baseScaling.y * scale, baseScaling.z * scale)
}

/**
 * Hook that loads and manages tower cab models inside the Babylon overlay scene.
 *
 * @param options.scene - Babylon scene
 * @param options.cesiumViewer - Cesium viewer (for terrain sampling only)
 * @param options.getFixedToEnu - Provides the ECEF→ENU matrix from useBabylonRootNode
 * @param options.shadowGenerator - Directional-light shadow generator
 * @param options.enabled - Toggle the hook on/off (default true)
 */
export function useBabylonTowerModel(options: UseBabylonTowerModelOptions): void {
  const { scene, cesiumViewer, getFixedToEnu, shadowGenerator, enabled = true } = options

  const currentAirport = useAirportStore((state) => state.currentAirport)

  // The asset container owns meshes, materials, textures, and animations from the glTF.
  // Disposing it cleans up all child resources atomically.
  const assetContainerRef = useRef<BABYLON.AssetContainer | null>(null)
  // The glTF loader's __root__ node, which we transform directly. We don't introduce
  // a wrapper because the loader sets rotationQuaternion=(0,1,0,0) and scaling=(1,1,-1)
  // on __root__ to convert glTF's right-handed coords to Babylon's left-handed; wrapping
  // it shifts cab geometry that isn't perfectly origin-centered.
  const rootMeshRef = useRef<BABYLON.AbstractMesh | null>(null)
  // The handedness quat the glTF loader baked into __root__; we compose our heading on top.
  const baseRotationQuatRef = useRef<BABYLON.Quaternion | null>(null)
  // The handedness scaling vector (typically (1,1,-1)); we multiply our uniform scale into it.
  const baseScalingRef = useRef<BABYLON.Vector3 | null>(null)
  const currentIcaoRef = useRef<string | null>(null)
  const loadingIcaoRef = useRef<string | null>(null)

  // Cached terrain height under the cab (used by wizard live-edit to recompute height
  // without re-sampling terrain on every keypress).
  const terrainHeightRef = useRef<number>(0)
  const scaleRef = useRef<number>(1.0)

  useEffect(() => {
    if (!enabled || !scene || scene.isDisposed) {
      return
    }
    if (!cesiumViewer || cesiumViewer.isDestroyed()) {
      return
    }

    const icao = currentAirport?.icao?.toUpperCase() ?? null

    if (!icao || icao === currentIcaoRef.current) {
      return
    }

    loadingIcaoRef.current = icao
    // Tear down the previous airport's cab before swapping. AssetContainer.dispose()
    // releases meshes, materials, and textures atomically.
    assetContainerRef.current?.dispose()
    assetContainerRef.current = null
    rootMeshRef.current = null
    baseRotationQuatRef.current = null
    baseScalingRef.current = null
    currentIcaoRef.current = null

    const towerMod = modService.getTowerModel(icao)
    if (!towerMod) {
      return
    }

    const placement = modService.getTowerPlacement(icao)
    if (!placement) {
      console.warn(`[useBabylonTowerModel] No position available for tower mod at ${icao}`)
      return
    }

    const modelUrl = convertToAssetUrlSync(towerMod.modelUrl)
    const scale = towerMod.manifest.scale ?? 1.0
    scaleRef.current = scale

    console.log(`[useBabylonTowerModel] Loading tower model for ${icao}:`, {
      modelUrl,
      position: { lat: placement.lat, lon: placement.lon },
      height: placement.height,
      rotation: placement.rotation,
      source: placement.source,
      scale,
    })

    const loadAtHeight = (finalHeight: number): void => {
      // Capture references at call time. Anything in this closure that reads `scene`,
      // `getFixedToEnu`, `shadowGenerator`, `icao` is stable for the duration of one
      // load attempt; staleness checks below guard against airport-change races.
      void BABYLON.LoadAssetContainerAsync(modelUrl, scene)
        .then((container) => {
          if (loadingIcaoRef.current !== icao || scene.isDisposed) {
            container.dispose()
            return
          }

          const fixedToEnu = getFixedToEnu()
          if (!fixedToEnu) {
            console.warn(
              `[useBabylonTowerModel] ENU transform not ready for ${icao}; root node setup may have raced. Disposing model.`,
            )
            container.dispose()
            return
          }

          container.addAllToScene()

          // Find the glTF loader's __root__ — top-level mesh with no parent. The loader
          // names it "__root__" but we look up by parent instead to be robust to renames.
          const root = container.meshes.find((m) => !m.parent)
          if (!root) {
            console.warn(`[useBabylonTowerModel] No root mesh found in container for ${icao}`)
            container.dispose()
            return
          }

          // Capture the loader's handedness-conversion transform, then compose an extra
          // +90° rotation around Y on top to match Cesium's glTF axis interpretation.
          //
          // Cesium's `Cesium.Model.fromGltfAsync` defaults `gltfForwardAxis = X` (model's
          // +X is "forward" = North under heading=0), overriding the glTF spec's +Z-forward.
          // Babylon's loader respects the spec and orients +Z forward. Mod authors who
          // tuned against Cesium therefore author with glTF +X = North; loading the same
          // glTF in Babylon places the cab rotated 90° relative to where Cesium had it,
          // which — combined with off-center authored geometry — produces a visible position
          // offset (empirically: ~6.7m east + ~2m north for OAK with AABB center at
          // glTF (4.32, 15.64, 2.37)).
          //
          // Composing rotY(+90°) on top of the loader's rotY(π) × scaleZ(-1) maps a glTF
          // point (a, b, c) to Babylon (c, b, a) — i.e. glTF +X → +North, +Y → +Up,
          // +Z → +East — matching Cesium's `gltfForwardAxis = X` convention. Determinant
          // stays at -1, so the loader's sideOrientation = ClockWise winding compensation
          // remains valid.
          const loaderQuat =
            root.rotationQuaternion?.clone() ??
            BABYLON.Quaternion.FromEulerAngles(root.rotation.x, root.rotation.y, root.rotation.z)
          const cesiumForwardAxisRotation = BABYLON.Quaternion.RotationAxis(BABYLON.Vector3.Up(), Math.PI / 2)
          const baseRotationQuat = cesiumForwardAxisRotation.multiply(loaderQuat)
          const baseScaling = root.scaling.clone()

          const ecefPos = Cesium.Cartesian3.fromDegrees(placement.lon, placement.lat, finalHeight)
          applyRootTransform(root, baseRotationQuat, baseScaling, ecefPos, fixedToEnu, placement.rotation, scale)

          if (shadowGenerator) {
            for (const mesh of container.meshes) {
              shadowGenerator.addShadowCaster(mesh, true)
              mesh.receiveShadows = true
            }
          }

          assetContainerRef.current = container
          rootMeshRef.current = root
          baseRotationQuatRef.current = baseRotationQuat
          baseScalingRef.current = baseScaling
          currentIcaoRef.current = icao

          console.log(`[useBabylonTowerModel] Tower model loaded for ${icao}`)
        })
        .catch((error) => {
          console.error(`[useBabylonTowerModel] Failed to load tower model for ${icao}:`, error)
        })
    }

    // Sample terrain, then load. Falls back to placement-only height on terrain-sample
    // failure so the cab still renders (matches Cesium-side behaviour).
    const terrainPosition = Cesium.Cartographic.fromDegrees(placement.lon, placement.lat)
    Cesium.sampleTerrainMostDetailed(cesiumViewer.terrainProvider, [terrainPosition])
      .then((sampledPositions) => {
        if (loadingIcaoRef.current !== icao || scene.isDisposed) {
          return
        }
        const terrainHeight = sampledPositions[0].height ?? 0
        terrainHeightRef.current = terrainHeight
        const finalHeight = terrainHeight + placement.height
        console.log(`[useBabylonTowerModel] Terrain sampled for ${icao}:`, {
          terrainHeight,
          placementHeight: placement.height,
          finalHeight,
        })
        loadAtHeight(finalHeight)
      })
      .catch((error) => {
        console.warn(`[useBabylonTowerModel] Failed to sample terrain for ${icao}:`, error)
        if (loadingIcaoRef.current !== icao || scene.isDisposed) {
          return
        }
        terrainHeightRef.current = 0
        loadAtHeight(placement.height)
      })

    return () => {
      assetContainerRef.current?.dispose()
      assetContainerRef.current = null
      rootMeshRef.current = null
      baseRotationQuatRef.current = null
      baseScalingRef.current = null
      currentIcaoRef.current = null
    }
  }, [scene, cesiumViewer, currentAirport?.icao, enabled, getFixedToEnu, shadowGenerator])

  // Reset refs on full unmount.
  useEffect(() => {
    return () => {
      assetContainerRef.current = null
      rootMeshRef.current = null
      baseRotationQuatRef.current = null
      baseScalingRef.current = null
      currentIcaoRef.current = null
      loadingIcaoRef.current = null
    }
  }, [])

  // Wizard live-edit subscription. Mirrors the Cesium hook's behaviour:
  // when the user is in Step 1 ('model') of the positioning wizard for the current
  // airport, recompute the wrapper transform on every offset/rotation change
  // without reloading the glTF.
  useEffect(() => {
    if (!scene || scene.isDisposed) {
      return
    }

    let prevOffset = { north: 0, east: 0, up: 0 }
    let prevRotation = 0

    const unsubscribe = useTowerPositioningStore.subscribe((state) => {
      const root = rootMeshRef.current
      const baseRotationQuat = baseRotationQuatRef.current
      const baseScaling = baseScalingRef.current
      if (!root || !baseRotationQuat || !baseScaling) {
        return
      }
      if (!state.isActive || state.step !== 'model') {
        return
      }
      if (state.targetIcao?.toUpperCase() !== currentIcaoRef.current) {
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

      prevOffset = { ...state.modelOffset }
      prevRotation = state.modelRotation

      const newPos = state.getAbsoluteModelPosition()
      if (!newPos) {
        return
      }

      const fixedToEnu = getFixedToEnu()
      if (!fixedToEnu) {
        return
      }

      const finalHeight = terrainHeightRef.current + newPos.height
      const ecefPos = Cesium.Cartesian3.fromDegrees(newPos.lon, newPos.lat, finalHeight)
      applyRootTransform(root, baseRotationQuat, baseScaling, ecefPos, fixedToEnu, newPos.rotation, scaleRef.current)
    })

    return unsubscribe
  }, [scene, getFixedToEnu])
}

export default useBabylonTowerModel
