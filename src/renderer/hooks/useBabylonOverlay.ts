import { useEffect, useRef, useCallback, useState } from 'react'
import * as BABYLON from '@babylonjs/core'
import * as GUI from '@babylonjs/gui'
import * as Cesium from 'cesium'
import { useWeatherStore } from '../stores/weatherStore'
import { useSettingsStore } from '../stores/settingsStore'
import {
  setupEnuTransforms,
  calculateBabylonCameraSync
} from '../utils/enuTransforms'

// Memory diagnostic counters
const memoryCounters = {
  materialsCreated: 0,
  materialsDisposed: 0,
  meshesCreated: 0,
  meshesDisposed: 0,
  guiControlsCreated: 0,
  guiControlsDisposed: 0,
}

// Export for external access if needed
export function getMemoryCounters() {
  return { ...memoryCounters }
}

interface AircraftLabel {
  label: GUI.Rectangle
  labelText: GUI.TextBlock
  leaderLine: GUI.Line
}

interface CloudMeshData {
  plane: BABYLON.Mesh
  material: BABYLON.StandardMaterial
}

const CLOUD_POOL_SIZE = 4  // Max 4 cloud layers
const CLOUD_PLANE_DIAMETER = 50000  // 50km diameter to cover horizon

interface BabylonOverlayOptions {
  cesiumViewer: Cesium.Viewer | null
  canvas: HTMLCanvasElement | null
}

/**
 * Hook that creates a Babylon.js overlay on top of Cesium for 3D rendering
 * Syncs the Babylon camera with Cesium's camera each frame
 */
export function useBabylonOverlay({ cesiumViewer, canvas }: BabylonOverlayOptions) {
  const engineRef = useRef<BABYLON.Engine | null>(null)
  const sceneRef = useRef<BABYLON.Scene | null>(null)
  const cameraRef = useRef<BABYLON.FreeCamera | null>(null)
  const rootNodeRef = useRef<BABYLON.TransformNode | null>(null)
  const aircraftLabelsRef = useRef<Map<string, AircraftLabel>>(new Map())
  const basePointRef = useRef<BABYLON.Vector3 | null>(null)
  const basePointUpRef = useRef<BABYLON.Vector3 | null>(null)
  const baseCartesianRef = useRef<Cesium.Cartesian3 | null>(null)
  const enuToFixedMatrixRef = useRef<Cesium.Matrix4 | null>(null)
  const fixedToEnuMatrixRef = useRef<Cesium.Matrix4 | null>(null)
  const guiTextureRef = useRef<GUI.AdvancedDynamicTexture | null>(null)

  // For 2D view: simple lat/lon based positioning
  const camera2DLatRef = useRef<number>(0)
  const camera2DLonRef = useRef<number>(0)
  const camera2DHeadingRef = useRef<number>(0)
  const isTopDownModeRef = useRef(false)

  // Terrain offset: difference between MSL elevation and actual Cesium terrain height
  // This corrects for geoid undulation (varies by location, e.g., -30m at Boston)
  const terrainOffsetRef = useRef<number>(0)

  // Cloud plane mesh pool for weather visualization
  const cloudMeshPoolRef = useRef<CloudMeshData[]>([])
  const cloudPlanesCreatedRef = useRef(false)

  // Fog dome mesh for visibility effect (hemisphere that follows camera)
  const fogDomeRef = useRef<BABYLON.Mesh | null>(null)
  const fogDomeMaterialRef = useRef<BABYLON.StandardMaterial | null>(null)

  // State to track when scene is ready (triggers re-render for dependents)
  const [sceneReady, setSceneReady] = useState(false)

  // State to track top-down mode for cloud visibility (clouds hidden in 2D view)
  const [isTopDownView, setIsTopDownView] = useState(false)

  // Weather store subscriptions
  const cloudLayers = useWeatherStore((state) => state.cloudLayers)
  const fogDensity = useWeatherStore((state) => state.fogDensity)
  const currentMetar = useWeatherStore((state) => state.currentMetar)
  const showWeatherEffects = useSettingsStore((state) => state.showWeatherEffects)
  const showCesiumFog = useSettingsStore((state) => state.showCesiumFog)
  const showBabylonFog = useSettingsStore((state) => state.showBabylonFog)
  const showClouds = useSettingsStore((state) => state.showClouds)
  const cloudOpacity = useSettingsStore((state) => state.cloudOpacity)
  const fogIntensity = useSettingsStore((state) => state.fogIntensity)
  const visibilityScale = useSettingsStore((state) => state.visibilityScale)

  // Initialize Babylon.js engine and scene
  useEffect(() => {
    if (!canvas || !cesiumViewer) return

    // Set canvas size to match display size
    const rect = canvas.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return

    canvas.width = rect.width * window.devicePixelRatio
    canvas.height = rect.height * window.devicePixelRatio

    // Create Babylon engine with transparent background
    const engine = new BABYLON.Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
      alpha: true
    })
    engineRef.current = engine

    // Create scene with transparent background
    const scene = new BABYLON.Scene(engine)
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0)
    // autoClear = true with transparent clearColor allows depth buffer to clear
    // while keeping the background transparent for Cesium to show through
    scene.autoClear = true
    scene.autoClearDepthAndStencil = true
    sceneRef.current = scene

    // Create camera (will be synced with Cesium)
    const camera = new BABYLON.FreeCamera('camera', new BABYLON.Vector3(0, 0, -10), scene)
    camera.minZ = 1 // Increase to avoid z-fighting at globe scale
    camera.maxZ = 1e10 // Very far for globe scale
    cameraRef.current = camera

    // Create fullscreen GUI texture for labels
    const guiTexture = GUI.AdvancedDynamicTexture.CreateFullscreenUI('UI', true, scene)
    guiTextureRef.current = guiTexture

    setSceneReady(true)

    // Add strong ambient light
    const light = new BABYLON.HemisphericLight('light', new BABYLON.Vector3(0, 1, 0), scene)
    light.intensity = 1.0
    light.groundColor = new BABYLON.Color3(0.5, 0.5, 0.5)

    // Add directional light
    const dirLight = new BABYLON.DirectionalLight('dirLight', new BABYLON.Vector3(-1, -2, -1), scene)
    dirLight.intensity = 0.6

    // Create cloud plane mesh pool for weather visualization
    for (let i = 0; i < CLOUD_POOL_SIZE; i++) {
      // Create large horizontal plane for cloud layer
      const plane = BABYLON.MeshBuilder.CreatePlane(`cloud_layer_${i}`, {
        size: CLOUD_PLANE_DIAMETER
      }, scene)
      memoryCounters.meshesCreated++

      // Rotate to horizontal (XZ plane) - plane is created in XY, we need it in XZ
      plane.rotation.x = Math.PI / 2
      plane.isVisible = false  // Start hidden until weather data is available

      // Create semi-transparent cloud material
      const material = new BABYLON.StandardMaterial(`cloud_mat_${i}`, scene)
      memoryCounters.materialsCreated++
      material.diffuseColor = new BABYLON.Color3(0.95, 0.95, 0.98)
      material.emissiveColor = new BABYLON.Color3(0.4, 0.4, 0.45)
      material.alpha = 0.5
      material.backFaceCulling = false  // Visible from both above and below
      material.disableLighting = false
      plane.material = material

      cloudMeshPoolRef.current.push({ plane, material })
    }
    cloudPlanesCreatedRef.current = true

    // Create fog dome - a sphere that surrounds the camera to simulate visibility limits
    // Uses inside rendering (sideOrientation = BACKSIDE) so fog is visible from inside
    const fogDome = BABYLON.MeshBuilder.CreateSphere('fog_dome', {
      diameter: 2,  // Will be scaled dynamically based on visibility
      segments: 32,
      sideOrientation: BABYLON.Mesh.BACKSIDE  // Render inside faces only
    }, scene)
    memoryCounters.meshesCreated++
    fogDome.isVisible = false  // Start hidden until fog is enabled

    // Fog dome material - subtle fog color with fresnel for edge fade
    // Designed to be barely visible at moderate visibility, only prominent at very low vis
    const fogDomeMaterial = new BABYLON.StandardMaterial('fog_dome_mat', scene)
    memoryCounters.materialsCreated++
    fogDomeMaterial.diffuseColor = new BABYLON.Color3(0.8, 0.8, 0.82)
    fogDomeMaterial.emissiveColor = new BABYLON.Color3(0.6, 0.6, 0.65)
    fogDomeMaterial.specularColor = new BABYLON.Color3(0, 0, 0)
    fogDomeMaterial.alpha = 0.3  // Base opacity - will be adjusted dynamically
    fogDomeMaterial.backFaceCulling = true  // Only render inside faces
    fogDomeMaterial.disableLighting = true

    // Fresnel effect - fog only visible at edges (looking through the sphere wall)
    // Center should be almost completely transparent
    fogDomeMaterial.opacityFresnelParameters = new BABYLON.FresnelParameters()
    fogDomeMaterial.opacityFresnelParameters.bias = 0.1   // Center almost fully transparent
    fogDomeMaterial.opacityFresnelParameters.power = 3    // Sharp edge falloff
    fogDomeMaterial.opacityFresnelParameters.leftColor = new BABYLON.Color3(1, 1, 1)   // Edges visible
    fogDomeMaterial.opacityFresnelParameters.rightColor = new BABYLON.Color3(0, 0, 0)  // Center invisible

    fogDome.material = fogDomeMaterial
    fogDomeRef.current = fogDome
    fogDomeMaterialRef.current = fogDomeMaterial

    // Handle resize
    const handleResize = () => {
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * window.devicePixelRatio
      canvas.height = rect.height * window.devicePixelRatio
      engine.resize()
    }
    window.addEventListener('resize', handleResize)

    // Capture ref values before cleanup to avoid stale reference issues
    // (refs may change by the time cleanup runs)
    const labelsToDispose = aircraftLabelsRef.current
    const cloudsToDispose = cloudMeshPoolRef.current

    return () => {
      window.removeEventListener('resize', handleResize)

      // Dispose all aircraft label resources BEFORE disposing scene
      for (const [, labelData] of labelsToDispose) {
        labelData.labelText.dispose()
        memoryCounters.guiControlsDisposed++
        labelData.leaderLine.dispose()
        memoryCounters.guiControlsDisposed++
        labelData.label.dispose()
        memoryCounters.guiControlsDisposed++
      }
      labelsToDispose.clear()

      // Dispose cloud plane resources
      for (const cloudData of cloudsToDispose) {
        if (cloudData.material) {
          cloudData.material.dispose()
          memoryCounters.materialsDisposed++
        }
        cloudData.plane.dispose()
        memoryCounters.meshesDisposed++
      }
      cloudMeshPoolRef.current = []
      cloudPlanesCreatedRef.current = false

      // Dispose fog dome resources
      if (fogDomeMaterialRef.current) {
        fogDomeMaterialRef.current.dispose()
        memoryCounters.materialsDisposed++
      }
      if (fogDomeRef.current) {
        fogDomeRef.current.dispose()
        memoryCounters.meshesDisposed++
      }
      fogDomeRef.current = null
      fogDomeMaterialRef.current = null

      guiTexture.dispose()
      scene.dispose()
      engine.dispose()
      engineRef.current = null
      sceneRef.current = null
      cameraRef.current = null
      rootNodeRef.current = null
      guiTextureRef.current = null
      baseCartesianRef.current = null
      enuToFixedMatrixRef.current = null
      fixedToEnuMatrixRef.current = null
      camera2DLatRef.current = 0
      camera2DLonRef.current = 0
      camera2DHeadingRef.current = 0
      isTopDownModeRef.current = false
      setSceneReady(false)
    }
  }, [canvas, cesiumViewer])

  // Update cloud planes based on weather data and settings
  // Clouds are hidden in 2D/top-down view since looking straight down through clouds
  // would obscure the entire view
  useEffect(() => {
    if (!cloudPlanesCreatedRef.current) return

    // Don't show clouds in 2D top-down view - they would obscure everything
    const shouldShowClouds = showWeatherEffects && showClouds && !isTopDownView
    const pool = cloudMeshPoolRef.current

    for (let i = 0; i < CLOUD_POOL_SIZE; i++) {
      const meshData = pool[i]
      if (!meshData) continue

      // Hide if clouds disabled, no layer at this index, or in 2D view
      if (!shouldShowClouds || i >= cloudLayers.length) {
        meshData.plane.isVisible = false
        continue
      }

      const layer = cloudLayers[i]

      // Position cloud at its altitude above ground (Y is up in Babylon)
      // Cloud planes follow the camera horizontally but stay at fixed altitude
      meshData.plane.position.y = layer.altitude
      meshData.plane.isVisible = true

      // Adjust opacity based on coverage and user setting
      meshData.material.alpha = layer.coverage * cloudOpacity
    }
  }, [cloudLayers, showWeatherEffects, showClouds, cloudOpacity, isTopDownView])

  // Apply Babylon.js fog effect using a fog dome mesh
  // The dome surrounds the camera at visibility distance, creating a fog wall
  // This actually affects visibility since scene.fogMode only affects Babylon meshes (not Cesium terrain)
  useEffect(() => {
    const fogDome = fogDomeRef.current
    const fogMaterial = fogDomeMaterialRef.current
    if (!fogDome || !fogMaterial) return

    const shouldShowFog = showWeatherEffects && showBabylonFog && currentMetar && fogDensity > 0

    if (shouldShowFog && currentMetar) {
      // Convert visibility from statute miles to meters
      // 1 SM = 1609.34 meters
      const visibilityMeters = currentMetar.visib * 1609.34

      // Scale the fog dome to the visibility distance, adjusted by user preference
      // The dome was created with diameter=2, so scale = visibilityMeters
      // visibilityScale: 1.0 = match METAR, 2.0 = see twice as far
      const domeScale = visibilityMeters * visibilityScale
      fogDome.scaling.setAll(domeScale)

      // Adjust fog opacity based on visibility severity
      // Use logarithmic scale since visibility perception is logarithmic
      // Only make fog prominent at very low visibility (under 1 SM)
      const visib = currentMetar.visib

      let baseAlpha: number
      let fresnelBias: number

      if (visib <= 0.25) {
        // Extremely low vis (1/4 SM or less) - heavy fog
        baseAlpha = 0.5
        fresnelBias = 0.3
      } else if (visib <= 1) {
        // Low vis (1/4 to 1 SM) - moderate to heavy fog
        // Interpolate: 0.5 at 0.25 SM to 0.25 at 1 SM
        const t = (visib - 0.25) / 0.75
        baseAlpha = 0.5 - (t * 0.25)
        fresnelBias = 0.3 - (t * 0.15)
      } else if (visib <= 3) {
        // Moderate vis (1 to 3 SM) - light fog
        // Interpolate: 0.25 at 1 SM to 0.1 at 3 SM
        const t = (visib - 1) / 2
        baseAlpha = 0.25 - (t * 0.15)
        fresnelBias = 0.15 - (t * 0.05)
      } else if (visib <= 6) {
        // Decent vis (3 to 6 SM) - very light haze
        // Interpolate: 0.1 at 3 SM to 0.03 at 6 SM
        const t = (visib - 3) / 3
        baseAlpha = 0.1 - (t * 0.07)
        fresnelBias = 0.1
      } else {
        // Good vis (6+ SM) - barely visible hint
        baseAlpha = 0.03
        fresnelBias = 0.1
      }

      // Apply user's fog intensity preference
      // fogIntensity: 0.5 = half opacity, 1.0 = default, 2.0 = double opacity
      fogMaterial.alpha = Math.min(1.0, baseAlpha * fogIntensity)
      fogMaterial.opacityFresnelParameters!.bias = fresnelBias

      fogDome.isVisible = true
    } else {
      // Hide fog dome when fog is disabled
      fogDome.isVisible = false
    }
  }, [showWeatherEffects, showBabylonFog, currentMetar, fogDensity, fogIntensity, visibilityScale])

  // Check if a datablock should be visible based on weather conditions
  // Returns true if datablock should be shown, false if it should be hidden due to weather
  // cameraAltitudeMeters: camera height above ground in meters
  // aircraftAltitudeMeters: aircraft height above ground in meters (AGL)
  // horizontalDistanceMeters: horizontal distance from camera to aircraft
  const isDatablockVisibleByWeather = useCallback((
    cameraAltitudeMeters: number,
    aircraftAltitudeMeters: number,
    horizontalDistanceMeters: number
  ): boolean => {
    // If weather effects are disabled, always show
    if (!showWeatherEffects) return true

    // Check visibility range (surface visibility culling)
    // Use Cesium fog setting since that controls draw distance visibility
    if (currentMetar && showCesiumFog) {
      // Apply visibilityScale: 1.0 = match METAR, 2.0 = see twice as far
      const visibilityMeters = currentMetar.visib * 1609.34 * visibilityScale  // SM to meters, scaled
      if (horizontalDistanceMeters > visibilityMeters) {
        return false
      }
    }

    // Check cloud ceiling culling
    // Only cull if clouds are enabled and we have cloud data
    // Skip cloud culling in 2D top-down view - clouds don't visually obscure in this mode
    if (showClouds && cloudLayers.length > 0 && !isTopDownModeRef.current) {
      const lowerAlt = Math.min(cameraAltitudeMeters, aircraftAltitudeMeters)
      const higherAlt = Math.max(cameraAltitudeMeters, aircraftAltitudeMeters)

      // Check if any BKN (0.75) or OVC (1.0) layer is between camera and aircraft
      for (const layer of cloudLayers) {
        // BKN = 0.75, OVC = 1.0 - these are "ceilings" that block visibility
        if (layer.coverage >= 0.75) {
          // Check if this ceiling is between camera and aircraft
          if (layer.altitude > lowerAlt && layer.altitude < higherAlt) {
            return false
          }
        }
      }
    }

    return true
  }, [showWeatherEffects, showCesiumFog, showClouds, currentMetar, cloudLayers, visibilityScale])

  // Setup root node when we have a base position
  const setupRootNode = useCallback((lat: number, lon: number, height: number) => {
    const scene = sceneRef.current
    const viewer = cesiumViewer
    if (!scene) return

    // Use utility function for ENU transform setup
    const enuData = setupEnuTransforms(lat, lon, height)

    // Store the transform data in refs
    baseCartesianRef.current = enuData.baseCartesian
    enuToFixedMatrixRef.current = enuData.enuToFixed
    fixedToEnuMatrixRef.current = enuData.fixedToEnu
    basePointRef.current = enuData.basePoint
    basePointUpRef.current = enuData.basePointUp

    // Sample terrain to calculate offset between MSL elevation and actual terrain height
    // This corrects for geoid undulation automatically at any location
    if (viewer?.terrainProvider) {
      const positions = [Cesium.Cartographic.fromDegrees(lon, lat)]
      Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, positions).then((updatedPositions) => {
        const terrainHeight = updatedPositions[0].height
        // Offset = terrain height - MSL height (height parameter is MSL-based)
        terrainOffsetRef.current = terrainHeight - height
      }).catch((err) => {
        console.warn('Failed to sample terrain, using default offset:', err)
        terrainOffsetRef.current = 0
      })
    }

    // Create or update root node
    if (rootNodeRef.current) {
      rootNodeRef.current.dispose()
    }

    const rootNode = new BABYLON.TransformNode('RootNode', scene)
    rootNodeRef.current = rootNode
  }, [cesiumViewer])

  // Sync Babylon camera for 2D topdown view - completely separate from 3D
  // Simple design: camera at fixed position looking down, heading applied to positions
  const syncCamera2D = useCallback(() => {
    const viewer = cesiumViewer
    const camera = cameraRef.current

    if (!viewer || !camera) return

    camera.rotationQuaternion = null

    // Update state only when mode changes (to trigger cloud visibility update)
    if (!isTopDownModeRef.current) {
      isTopDownModeRef.current = true
      setIsTopDownView(true)
    }

    // Get Cesium camera's geographic position
    const cartographic = Cesium.Cartographic.fromCartesian(viewer.camera.positionWC)
    const camLat = Cesium.Math.toDegrees(cartographic.latitude)
    const camLon = Cesium.Math.toDegrees(cartographic.longitude)
    const camHeight = cartographic.height

    // Store camera lat/lon and heading for aircraft positioning
    camera2DLatRef.current = camLat
    camera2DLonRef.current = camLon
    camera2DHeadingRef.current = viewer.camera.heading

    // Position Babylon camera at origin, at the same height as Cesium camera
    camera.position.set(0, camHeight, 0)

    // Set FOV from Cesium
    const frustum = viewer.camera.frustum
    if (frustum instanceof Cesium.PerspectiveFrustum && frustum.fovy !== undefined) {
      camera.fov = frustum.fovy
    }

    // Look straight down with no rotation - heading is applied to positions instead
    camera.rotation.set(Math.PI / 2, 0, 0)

    // Position fog dome at camera position
    if (fogDomeRef.current) {
      fogDomeRef.current.position.copyFrom(camera.position)
    }
  }, [cesiumViewer])

  // Sync Babylon camera for 3D view
  // Returns true if sync was successful, false if prerequisites are missing
  const syncCamera3D = useCallback((): boolean => {
    const viewer = cesiumViewer
    const camera = cameraRef.current
    const fixedToEnu = fixedToEnuMatrixRef.current

    if (!viewer || !camera || !fixedToEnu) return false

    // Clear any quaternion so Euler angles work
    camera.rotationQuaternion = null

    // Update state only when mode changes (to trigger cloud visibility update)
    if (isTopDownModeRef.current) {
      isTopDownModeRef.current = false
      setIsTopDownView(false)
    }

    // Use utility function for camera sync calculation
    const syncData = calculateBabylonCameraSync(viewer, fixedToEnu)
    if (!syncData) return false

    // Apply position, rotation, and FOV
    camera.position.copyFrom(syncData.position)
    camera.rotation.set(
      syncData.rotation.rotationX,
      syncData.rotation.rotationY,
      syncData.rotation.rotationZ
    )
    camera.fov = syncData.fov

    // Position fog dome at camera position
    if (fogDomeRef.current) {
      fogDomeRef.current.position.copyFrom(camera.position)
    }

    return true
  }, [cesiumViewer])

  // Main sync camera function - dispatches to 2D or 3D based on view
  const syncCamera = useCallback(() => {
    const viewer = cesiumViewer
    if (!viewer) return

    // Check if we're in topdown view by looking at the camera pitch
    // Cesium pitch: -PI/2 = looking straight down
    const isTopDown = viewer.camera.pitch < -1.4  // roughly -80 degrees or more

    if (isTopDown) {
      syncCamera2D()
    } else {
      syncCamera3D()
    }
  }, [cesiumViewer, syncCamera2D, syncCamera3D])

  // Create or update aircraft label (labels and leader lines only - Cesium handles 3D aircraft models)
  const updateAircraftLabel = useCallback((
    callsign: string,
    color: { r: number; g: number; b: number },
    isFollowed: boolean,
    labelText?: string
  ) => {
    const guiTexture = guiTextureRef.current
    if (!guiTexture) return

    let labelData = aircraftLabelsRef.current.get(callsign)

    if (!labelData) {
      // Create GUI label (positioned by updateLeaderLine)
      const label = new GUI.Rectangle(`${callsign}_label`)
      memoryCounters.guiControlsCreated++
      label.width = 'auto'
      label.height = 'auto'
      label.cornerRadius = 4
      label.thickness = 1
      label.background = isFollowed ? 'rgba(0, 50, 80, 0.85)' : 'rgba(0, 0, 0, 0.85)'
      label.color = rgbToHex(color.r, color.g, color.b)
      label.adaptWidthToChildren = true
      label.adaptHeightToChildren = true
      label.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT
      label.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_TOP
      label.zIndex = 10  // Labels render on top of leader lines
      label.isVisible = false  // Start hidden until positioned
      guiTexture.addControl(label)

      const text = new GUI.TextBlock(`${callsign}_text`)
      memoryCounters.guiControlsCreated++
      text.text = labelText || callsign
      text.color = rgbToHex(color.r, color.g, color.b)
      text.fontSize = 12
      text.fontFamily = 'monospace'
      text.fontWeight = 'bold'
      text.textHorizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT
      text.resizeToFit = true
      text.paddingLeft = '4px'
      text.paddingRight = '4px'
      text.paddingTop = '2px'
      text.paddingBottom = '2px'
      label.addControl(text)

      // Create leader line (positioned by updateLeaderLine)
      const leaderLine = new GUI.Line(`${callsign}_leaderLine`)
      memoryCounters.guiControlsCreated++
      leaderLine.lineWidth = 3
      leaderLine.color = rgbToHex(color.r, color.g, color.b)
      leaderLine.zIndex = 1  // Leader lines render below labels (zIndex 10)
      leaderLine.isVisible = false  // Start hidden until positioned
      guiTexture.addControl(leaderLine)

      labelData = { label, labelText: text, leaderLine }
      aircraftLabelsRef.current.set(callsign, labelData)
    }

    // Update colors and text
    labelData.leaderLine.color = rgbToHex(color.r, color.g, color.b)
    labelData.labelText.text = labelText || callsign
    labelData.labelText.color = rgbToHex(color.r, color.g, color.b)
    labelData.label.color = rgbToHex(color.r, color.g, color.b)
    labelData.label.background = isFollowed ? 'rgba(0, 50, 80, 0.85)' : 'rgba(0, 0, 0, 0.85)'
    const scale = isFollowed ? 1.2 : 1.0
    labelData.label.scaleX = scale
    labelData.label.scaleY = scale
  }, [])

  // Update label position using screen coordinates from Cesium
  // screenX, screenY are the screen position of the aircraft model (from Cesium projection)
  // labelOffsetX, labelOffsetY are the offset from the model to position the label
  const updateLeaderLine = useCallback((
    callsign: string,
    screenX: number,
    screenY: number,
    labelOffsetX: number,
    labelOffsetY: number
  ) => {
    const labelData = aircraftLabelsRef.current.get(callsign)
    if (!labelData) return

    // Show label and leader line
    labelData.label.isVisible = true
    labelData.leaderLine.isVisible = true

    // Position label with offset from model screen position
    // GUI uses left/top from top-left corner when using LEFT/TOP alignment
    const labelX = screenX + labelOffsetX
    const labelY = screenY + labelOffsetY

    labelData.label.left = labelX
    labelData.label.top = labelY

    // Get label dimensions for line endpoint calculation
    const labelW = labelData.label.widthInPixels || 80
    const labelH = labelData.label.heightInPixels || 24

    // Line from label center to model screen position
    const labelCenterX = labelX + labelW / 2
    const labelCenterY = labelY + labelH / 2

    // Calculate direction from label to model
    const dirX = screenX - labelCenterX
    const dirY = screenY - labelCenterY
    const dist = Math.sqrt(dirX * dirX + dirY * dirY)

    if (dist < 1) {
      // Too close, hide line
      labelData.leaderLine.isVisible = false
      return
    }

    // Normalize direction
    const nx = dirX / dist
    const ny = dirY / dist

    // Line starts at label edge - calculate intersection with rectangle
    // Find t where the ray from label center hits the label boundary
    const tX = Math.abs(nx) > 0.001 ? (labelW / 2) / Math.abs(nx) : 10000
    const tY = Math.abs(ny) > 0.001 ? (labelH / 2) / Math.abs(ny) : 10000
    const tEdge = Math.min(tX, tY) + 3  // +3 pixel gap from edge

    const startX = labelCenterX + nx * tEdge
    const startY = labelCenterY + ny * tEdge

    // Line ends near model (leave small gap)
    const endX = screenX - nx * 10
    const endY = screenY - ny * 10

    // GUI Line uses absolute screen coordinates (top-left origin)
    labelData.leaderLine.x1 = startX
    labelData.leaderLine.y1 = startY
    labelData.leaderLine.x2 = endX
    labelData.leaderLine.y2 = endY
  }, [])

  // Remove aircraft label - properly disposes all GUI resources
  const removeAircraftLabel = useCallback((callsign: string) => {
    const labelData = aircraftLabelsRef.current.get(callsign)
    if (labelData) {
      labelData.labelText.dispose()
      memoryCounters.guiControlsDisposed++
      labelData.leaderLine.dispose()
      memoryCounters.guiControlsDisposed++
      labelData.label.dispose()
      memoryCounters.guiControlsDisposed++
      aircraftLabelsRef.current.delete(callsign)
    }
  }, [])

  // Get all current aircraft callsigns
  const getAircraftCallsigns = useCallback(() => {
    return Array.from(aircraftLabelsRef.current.keys())
  }, [])

  // Hide all labels (called at start of frame before updating visible ones)
  const hideAllLabels = useCallback(() => {
    for (const [, labelData] of aircraftLabelsRef.current) {
      labelData.label.isVisible = false
      labelData.leaderLine.isVisible = false
    }
  }, [])

  // Render one frame
  const render = useCallback(() => {
    const engine = engineRef.current
    const scene = sceneRef.current

    if (!engine || !scene) return

    syncCamera()
    scene.render()
  }, [syncCamera])

  return {
    engine: engineRef.current,
    scene: sceneRef.current,
    sceneReady,
    setupRootNode,
    updateAircraftLabel,
    updateLeaderLine,
    removeAircraftLabel,
    getAircraftCallsigns,
    hideAllLabels,
    isDatablockVisibleByWeather,
    render,
    syncCamera
  }
}

// Helper to convert RGB values (0-1) to hex color string
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export default useBabylonOverlay
