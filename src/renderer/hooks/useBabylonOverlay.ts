import { useEffect, useRef, useCallback, useState } from 'react'
import * as BABYLON from '@babylonjs/core'
import * as GUI from '@babylonjs/gui'
import * as Cesium from 'cesium'

interface AircraftMesh {
  cone: BABYLON.Mesh
  shadow?: BABYLON.Mesh
  label?: GUI.Rectangle
  labelText?: GUI.TextBlock
  leaderLine?: GUI.Line
  // Smoothed screen position for reducing jitter in orbit follow mode
  smoothedScreenX?: number
  smoothedScreenY?: number
}

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
  const aircraftMeshesRef = useRef<Map<string, AircraftMesh>>(new Map())
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

  // State to track when scene is ready (triggers re-render for dependents)
  const [sceneReady, setSceneReady] = useState(false)

  // Convert Cesium Cartesian3 to Babylon Vector3 (swap Y and Z)
  const cart2vec = useCallback((cart: { x: number; y: number; z: number }) => {
    return new BABYLON.Vector3(cart.x, cart.z, cart.y)
  }, [])

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

    // Handle resize
    const handleResize = () => {
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * window.devicePixelRatio
      canvas.height = rect.height * window.devicePixelRatio
      engine.resize()
    }
    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
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
      aircraftMeshesRef.current.clear()
      setSceneReady(false)
    }
  }, [canvas, cesiumViewer])

  // Setup root node when we have a base position
  const setupRootNode = useCallback((lat: number, lon: number, height: number) => {
    const scene = sceneRef.current
    const viewer = cesiumViewer
    if (!scene) return

    // Calculate base point in ECEF coordinates
    const baseCart = Cesium.Cartesian3.fromDegrees(lon, lat, height)
    const baseCartUp = Cesium.Cartesian3.fromDegrees(lon, lat, height + 1000)

    // Store the base cartesian for later use
    baseCartesianRef.current = baseCart

    // Calculate the ENU (East-North-Up) to Fixed (ECEF) transformation matrix
    // This allows us to convert local ENU coordinates to ECEF
    const enuToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(baseCart)
    enuToFixedMatrixRef.current = enuToFixed

    // Calculate the inverse (Fixed to ENU) for converting ECEF positions to local ENU
    const fixedToEnu = Cesium.Matrix4.inverse(enuToFixed, new Cesium.Matrix4())
    fixedToEnuMatrixRef.current = fixedToEnu

    basePointRef.current = cart2vec(baseCart)
    basePointUpRef.current = cart2vec(baseCartUp)

    // Sample terrain to calculate offset between MSL elevation and actual terrain height
    // This corrects for geoid undulation automatically at any location
    if (viewer?.terrainProvider) {
      const positions = [Cesium.Cartographic.fromDegrees(lon, lat)]
      Cesium.sampleTerrainMostDetailed(viewer.terrainProvider, positions).then((updatedPositions) => {
        const terrainHeight = updatedPositions[0].height
        // Offset = terrain height - MSL height (height parameter is MSL-based)
        terrainOffsetRef.current = terrainHeight - height
        //console.log(`Terrain offset calculated: ${terrainOffsetRef.current.toFixed(1)}m (terrain: ${terrainHeight.toFixed(1)}m, MSL: ${height.toFixed(1)}m)`)
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
  }, [cart2vec, cesiumViewer])

  // Sync Babylon camera for 2D topdown view - completely separate from 3D
  // Simple design: camera at fixed position looking down, heading applied to positions
  const syncCamera2D = useCallback(() => {
    const viewer = cesiumViewer
    const camera = cameraRef.current

    if (!viewer || !camera) return

    camera.rotationQuaternion = null
    isTopDownModeRef.current = true

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
    isTopDownModeRef.current = false

    // Get Cesium camera FOV
    const frustum = viewer.camera.frustum
    if (frustum instanceof Cesium.PerspectiveFrustum && frustum.fovy !== undefined) {
      camera.fov = frustum.fovy
    }

    // Get camera position in ECEF and transform to local ENU (relative to tower)
    const cesiumCamPos = viewer.camera.positionWC
    const camEnu = Cesium.Matrix4.multiplyByPoint(fixedToEnu, cesiumCamPos, new Cesium.Cartesian3())

    // Transform camera direction from ECEF to ENU (direction vector, not point)
    const cesiumCamDir = viewer.camera.direction
    const dirEnu = Cesium.Matrix4.multiplyByPointAsVector(fixedToEnu, cesiumCamDir, new Cesium.Cartesian3())

    // Transform camera up vector from ECEF to ENU
    const cesiumCamUp = viewer.camera.up
    const upEnu = Cesium.Matrix4.multiplyByPointAsVector(fixedToEnu, cesiumCamUp, new Cesium.Cartesian3())

    // Convert ENU to Babylon coordinates: ENU(X,Y,Z) -> Babylon(X=East, Y=Up, Z=North)
    // ENU: X=East, Y=North, Z=Up
    // Babylon: X=East, Y=Up, Z=North
    camera.position.set(camEnu.x, camEnu.z, camEnu.y)

    const dirBabylon = new BABYLON.Vector3(dirEnu.x, dirEnu.z, dirEnu.y)
    const upBabylon = new BABYLON.Vector3(upEnu.x, upEnu.z, upEnu.y)

    // Calculate rotation from direction and up vectors
    const forward = dirBabylon.normalize()

    // Normal 3D view - use standard Euler angle calculation
    // Yaw: rotation around Y axis (heading)
    const rotationY = Math.atan2(forward.x, forward.z)

    // Pitch: rotation around X axis (looking up/down)
    const rotationX = -Math.asin(Math.max(-1, Math.min(1, forward.y)))

    // Roll: rotation around Z axis
    const cosY = Math.cos(rotationY)
    const sinY = Math.sin(rotationY)
    const cosX = Math.cos(rotationX)
    const sinX = Math.sin(rotationX)

    // Expected right vector after yaw
    const rightAfterYaw = new BABYLON.Vector3(cosY, 0, -sinY)
    // Expected up after yaw and pitch
    const upAfterYawPitch = new BABYLON.Vector3(
      sinY * sinX,
      cosX,
      cosY * sinX
    )

    // Project actual up onto the plane perpendicular to forward
    const upNormalized = upBabylon.normalize()
    const upInPlane = upNormalized.subtract(forward.scale(BABYLON.Vector3.Dot(upNormalized, forward)))
    const upInPlaneLen = upInPlane.length()

    let rotationZ = 0
    if (upInPlaneLen > 0.001) {
      upInPlane.scaleInPlace(1 / upInPlaneLen)
      const dotUp = BABYLON.Vector3.Dot(upAfterYawPitch, upInPlane)
      const dotRight = BABYLON.Vector3.Dot(rightAfterYaw, upInPlane)
      rotationZ = Math.atan2(dotRight, dotUp)
    }

    camera.rotation.set(rotationX, rotationY, rotationZ)
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

  // Create or update aircraft cone mesh and label
  const updateAircraftMesh = useCallback((
    callsign: string,
    lat: number,
    lon: number,
    altitudeMeters: number,
    groundElevationMeters: number,
    heading: number,
    color: { r: number; g: number; b: number },
    isFollowed: boolean,
    labelText?: string,
    viewModeScale: number = 1.0
  ) => {
    const scene = sceneRef.current
    const guiTexture = guiTextureRef.current

    if (!scene || !guiTexture) return

    let localPos: BABYLON.Vector3

    if (isTopDownModeRef.current) {
      // 2D VIEW: Simple lat/lon to meter offset calculation
      // No complex matrix math - just basic geography
      const camLat = camera2DLatRef.current
      const camLon = camera2DLonRef.current
      const camHeading = camera2DHeadingRef.current

      // Convert lat/lon difference to meters
      // 1 degree latitude ≈ 111,111 meters
      // 1 degree longitude ≈ 111,111 * cos(latitude) meters
      const metersPerDegreeLat = 111111
      const metersPerDegreeLon = 111111 * Math.cos(camLat * Math.PI / 180)

      const deltaLat = lat - camLat
      const deltaLon = lon - camLon

      const northOffset = deltaLat * metersPerDegreeLat  // +North in world
      const eastOffset = deltaLon * metersPerDegreeLon   // +East in world

      // Rotate by heading so that the heading direction points "up" on screen
      // Cesium heading: 0=North, 90=East (clockwise from above)
      // We want to rotate world coordinates into screen coordinates
      // Screen: +Z = up, +X = right (when looking down)
      const cosH = Math.cos(camHeading)
      const sinH = Math.sin(camHeading)

      // Rotate (east, north) by -heading
      const rotatedX = eastOffset * cosH - northOffset * sinH
      const rotatedZ = eastOffset * sinH + northOffset * cosH

      // Babylon coordinates: X=right on screen, Y=Up (towards camera), Z=up on screen
      // For 2D, Y position is just a small offset above ground (flatten everything)
      localPos = new BABYLON.Vector3(rotatedX, 50, rotatedZ)
    } else {
      // 3D VIEW: Use ENU transformation relative to tower
      const fixedToEnu = fixedToEnuMatrixRef.current
      if (!fixedToEnu) return

      // Check if aircraft is on or near ground (within 15m of ground elevation)
      const isOnGround = (altitudeMeters - groundElevationMeters) < 15
      const coneRadius = 6 // Half of 12m diameter

      // Compute effective altitude including terrain offset (matches Cesium model positioning)
      const effectiveAltitude = isOnGround
        ? groundElevationMeters + terrainOffsetRef.current + 0.5  // ground level with small offset
        : altitudeMeters + terrainOffsetRef.current

      // Get ENU position at actual altitude (accounts for Earth curvature at high altitudes)
      const posCart = Cesium.Cartesian3.fromDegrees(lon, lat, effectiveAltitude)
      const enuPos = Cesium.Matrix4.multiplyByPoint(fixedToEnu, posCart, new Cesium.Cartesian3())

      // Convert ENU to Babylon: ENU(X,Y,Z) -> Babylon(X=East, Y=Up, Z=North)
      // enuPos.z is the ENU "Up" component, which becomes Babylon Y
      // Add coneRadius so cone mesh center is above the aircraft position
      localPos = new BABYLON.Vector3(enuPos.x, enuPos.z + coneRadius, enuPos.y)
    }


    // Calculate heading direction in Babylon coordinates
    // Heading: 0 = North, 90 = East, etc.
    const headingRad = Cesium.Math.toRadians(heading)
    let dirEast = Math.sin(headingRad)
    let dirNorth = Math.cos(headingRad)

    // In 2D view, rotate the direction by camera heading (same as positions)
    if (isTopDownModeRef.current) {
      const camHeading = camera2DHeadingRef.current
      const cosH = Math.cos(camHeading)
      const sinH = Math.sin(camHeading)
      const rotatedDirX = dirEast * cosH - dirNorth * sinH
      const rotatedDirZ = dirEast * sinH + dirNorth * cosH
      dirEast = rotatedDirX
      dirNorth = rotatedDirZ
    }

    // Direction in Babylon coordinates (Y-up): X = East, Y = Up (0 for level flight), Z = North
    const dirBabylon = new BABYLON.Vector3(dirEast, 0, dirNorth)

    let meshData = aircraftMeshesRef.current.get(callsign)

    if (!meshData) {
      // Create cone mesh - pointing along +Y axis by default (will be rotated)
      // Size in meters - should be small enough to represent aircraft position
      const coneHeight = 25
      const coneDiameter = 12
      const cone = BABYLON.MeshBuilder.CreateCylinder(callsign, {
        height: coneHeight,
        diameterTop: 0,  // Point at top
        diameterBottom: coneDiameter,
        tessellation: 16
      }, scene)
      // Store cone dimensions for leader line calculation
      cone.metadata = { height: coneHeight, diameter: coneDiameter }

      // Create material for the cone (invisible - Cesium handles cone rendering)
      const material = new BABYLON.StandardMaterial(`${callsign}_mat`, scene)
      material.emissiveColor = new BABYLON.Color3(color.r, color.g, color.b)
      material.diffuseColor = new BABYLON.Color3(color.r, color.g, color.b)
      material.disableLighting = true
      material.alpha = 0  // Invisible - Cesium cones are visible instead
      material.backFaceCulling = false
      cone.material = material
      cone.isVisible = false  // Hide - Cesium handles cone rendering with proper depth occlusion

      // Create shadow mesh - a flat disc that sits on the ground
      // Hidden since Cesium renders the visible shadows
      const shadow = BABYLON.MeshBuilder.CreateDisc(`${callsign}_shadow`, {
        radius: coneDiameter * 0.8,
        tessellation: 16
      }, scene)
      shadow.rotation.x = Math.PI / 2
      shadow.isVisible = false // Hide - Cesium handles shadow rendering
      const shadowMaterial = new BABYLON.StandardMaterial(`${callsign}_shadow_mat`, scene)
      shadowMaterial.diffuseColor = new BABYLON.Color3(0, 0, 0)
      shadowMaterial.emissiveColor = new BABYLON.Color3(0, 0, 0)
      shadowMaterial.alpha = 0
      shadowMaterial.disableLighting = true
      shadowMaterial.backFaceCulling = false
      shadow.material = shadowMaterial

      // Create GUI label (positioned manually in updateLeaderLine)
      const label = new GUI.Rectangle(`${callsign}_label`)
      label.width = 'auto'
      label.height = 'auto'
      label.cornerRadius = 4
      label.thickness = 1
      label.background = isFollowed ? 'rgba(0, 50, 80, 0.85)' : 'rgba(0, 0, 0, 0.85)'
      label.color = rgbToHex(color.r, color.g, color.b)
      label.paddingLeft = '6px'
      label.paddingRight = '6px'
      label.paddingTop = '4px'
      label.paddingBottom = '4px'
      label.adaptWidthToChildren = true
      label.adaptHeightToChildren = true
      label.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT
      label.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_TOP
      label.zIndex = 10  // Labels render on top of leader lines
      label.isVisible = false  // Start hidden until camera is synced and position is valid
      guiTexture.addControl(label)

      const text = new GUI.TextBlock(`${callsign}_text`)
      text.text = labelText || callsign
      text.color = rgbToHex(color.r, color.g, color.b)
      text.fontSize = 12
      text.fontFamily = 'monospace'
      text.fontWeight = 'bold'
      text.textHorizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT
      text.resizeToFit = true
      label.addControl(text)

      // Create leader line (positioned manually in updateLeaderLine)
      const leaderLine = new GUI.Line(`${callsign}_leaderLine`)
      leaderLine.lineWidth = 3
      leaderLine.color = 'white'  // Use white for visibility testing
      leaderLine.zIndex = 1  // Leader lines render below labels (zIndex 10)
      leaderLine.isVisible = false  // Start hidden until camera is synced and position is valid
      // Set initial test coordinates - simple line from center
      leaderLine.x1 = 0
      leaderLine.y1 = 0
      leaderLine.x2 = 100
      leaderLine.y2 = 100
      guiTexture.addControl(leaderLine)

      meshData = { cone, shadow, label, labelText: text, leaderLine }
      aircraftMeshesRef.current.set(callsign, meshData)
    }

    // Update cone position
    meshData.cone.position = localPos

    // Update shadow position - place at ground level below the cone
    if (meshData.shadow) {
      if (isTopDownModeRef.current) {
        // In 2D view, shadow sits just below the cone
        meshData.shadow.position = new BABYLON.Vector3(localPos.x, 40, localPos.z)
      } else {
        // In 3D view, place shadow at terrain level (applying same geoid correction)
        const shadowY = terrainOffsetRef.current + 0.5
        meshData.shadow.position = new BABYLON.Vector3(localPos.x, shadowY, localPos.z)
      }
    }

    // Orient cone to point in heading direction
    // Cone's default axis is +Y, we need to rotate it to point along dirBabylon
    const defaultAxis = new BABYLON.Vector3(0, 1, 0)
    const targetDir = dirBabylon.normalize()

    // Calculate rotation quaternion from default axis to target direction
    const cross = BABYLON.Vector3.Cross(defaultAxis, targetDir)
    const dot = BABYLON.Vector3.Dot(defaultAxis, targetDir)

    if (cross.length() > 0.0001) {
      const angle = Math.acos(Math.max(-1, Math.min(1, dot)))
      const axis = cross.normalize()
      meshData.cone.rotationQuaternion = BABYLON.Quaternion.RotationAxis(axis, angle)
    } else if (dot < 0) {
      // Pointing opposite direction
      meshData.cone.rotationQuaternion = BABYLON.Quaternion.RotationAxis(
        new BABYLON.Vector3(1, 0, 0),
        Math.PI
      )
    } else {
      meshData.cone.rotationQuaternion = BABYLON.Quaternion.Identity()
    }

    // Update color
    const mat = meshData.cone.material as BABYLON.StandardMaterial
    mat.emissiveColor = new BABYLON.Color3(color.r, color.g, color.b)
    mat.diffuseColor = new BABYLON.Color3(color.r, color.g, color.b)

    if (meshData.leaderLine) {
      meshData.leaderLine.color = rgbToHex(color.r, color.g, color.b)
    }

    // Update label
    if (meshData.label && meshData.labelText) {
      meshData.labelText.text = labelText || callsign
      meshData.labelText.color = rgbToHex(color.r, color.g, color.b)
      meshData.label.color = rgbToHex(color.r, color.g, color.b)
      meshData.label.background = isFollowed ? 'rgba(0, 50, 80, 0.85)' : 'rgba(0, 0, 0, 0.85)'
      const scale = isFollowed ? 1.2 : 1.0
      meshData.label.scaleX = scale
      meshData.label.scaleY = scale
    }

    // Scale followed aircraft, with additional view mode scale
    const baseScale = isFollowed ? 1.5 : 1.0
    const scale = baseScale * viewModeScale
    meshData.cone.scaling.setAll(scale)
    // Scale shadow to match cone
    if (meshData.shadow) {
      meshData.shadow.scaling.setAll(scale)
    }
  }, [])

  // Update leader line and label position manually
  // We project the cone's 3D position to screen space and position GUI elements accordingly
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
    const meshData = aircraftMeshesRef.current.get(callsign)

    if (!meshData?.leaderLine || !meshData?.label) return

    // Show label and leader line
    meshData.label.isVisible = true
    meshData.leaderLine.isVisible = true

    // Position label with offset from model screen position
    // GUI uses left/top from top-left corner when using LEFT/TOP alignment
    const labelX = screenX + labelOffsetX
    const labelY = screenY + labelOffsetY

    meshData.label.left = labelX
    meshData.label.top = labelY

    // Get label dimensions for line endpoint calculation
    const labelW = meshData.label.widthInPixels || 80
    const labelH = meshData.label.heightInPixels || 24

    // Line from label center to model screen position
    const labelCenterX = labelX + labelW / 2
    const labelCenterY = labelY + labelH / 2

    // Calculate direction from label to model
    const dirX = screenX - labelCenterX
    const dirY = screenY - labelCenterY
    const dist = Math.sqrt(dirX * dirX + dirY * dirY)

    if (dist < 1) {
      // Too close, hide line
      meshData.leaderLine.isVisible = false
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
    meshData.leaderLine.x1 = startX
    meshData.leaderLine.y1 = startY
    meshData.leaderLine.x2 = endX
    meshData.leaderLine.y2 = endY
  }, [])

  // Remove aircraft mesh
  const removeAircraftMesh = useCallback((callsign: string) => {
    const meshData = aircraftMeshesRef.current.get(callsign)
    if (meshData) {
      meshData.cone.dispose()
      meshData.shadow?.dispose()
      meshData.leaderLine?.dispose()
      meshData.label?.dispose()
      aircraftMeshesRef.current.delete(callsign)
    }
  }, [])

  // Get all current aircraft callsigns
  const getAircraftCallsigns = useCallback(() => {
    return Array.from(aircraftMeshesRef.current.keys())
  }, [])

  // Hide all labels (called at start of frame before updating visible ones)
  const hideAllLabels = useCallback(() => {
    for (const [, meshData] of aircraftMeshesRef.current) {
      if (meshData.label) meshData.label.isVisible = false
      if (meshData.leaderLine) meshData.leaderLine.isVisible = false
    }
  }, [])

  // Get screen position of a cone (for overlap detection)
  // Applies exponential smoothing to reduce jitter in orbit follow mode
  const getConeScreenPosition = useCallback((callsign: string): { x: number; y: number; visible: boolean } | null => {
    const meshData = aircraftMeshesRef.current.get(callsign)
    const scene = sceneRef.current
    const engine = engineRef.current

    if (!meshData?.cone || !scene || !engine) return null

    const screenWidth = engine.getRenderWidth()
    const screenHeight = engine.getRenderHeight()

    const coneWorldPos = meshData.cone.absolutePosition
    const screenPos = BABYLON.Vector3.Project(
      coneWorldPos,
      BABYLON.Matrix.Identity(),
      scene.getTransformMatrix(),
      new BABYLON.Viewport(0, 0, screenWidth, screenHeight)
    )

    const visible = screenPos.z >= 0 && screenPos.z <= 1

    // Apply exponential smoothing to reduce jitter
    // Higher smoothing factor = more responsive but more jittery
    // Lower smoothing factor = smoother but more laggy
    const smoothingFactor = 0.4

    let smoothedX: number
    let smoothedY: number

    if (meshData.smoothedScreenX === undefined || meshData.smoothedScreenY === undefined) {
      // First time - initialize with raw position
      smoothedX = screenPos.x
      smoothedY = screenPos.y
    } else {
      // Check if the position jumped significantly (e.g., aircraft came back into view)
      const jumpThreshold = 100
      const dx = Math.abs(screenPos.x - meshData.smoothedScreenX)
      const dy = Math.abs(screenPos.y - meshData.smoothedScreenY)

      if (dx > jumpThreshold || dy > jumpThreshold) {
        // Large jump - snap to new position
        smoothedX = screenPos.x
        smoothedY = screenPos.y
      } else {
        // Apply exponential smoothing: new = old + factor * (raw - old)
        smoothedX = meshData.smoothedScreenX + smoothingFactor * (screenPos.x - meshData.smoothedScreenX)
        smoothedY = meshData.smoothedScreenY + smoothingFactor * (screenPos.y - meshData.smoothedScreenY)
      }
    }

    // Store smoothed values for next frame
    meshData.smoothedScreenX = smoothedX
    meshData.smoothedScreenY = smoothedY

    return { x: smoothedX, y: smoothedY, visible }
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
    updateAircraftMesh,
    updateLeaderLine,
    removeAircraftMesh,
    getAircraftCallsigns,
    hideAllLabels,
    getConeScreenPosition,
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
