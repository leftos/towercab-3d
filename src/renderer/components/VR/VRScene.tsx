import { useRef, useEffect, useCallback } from 'react'
import * as BABYLON from '@babylonjs/core'
import { useVRStore } from '../../stores/vrStore'
import { useCesiumStereo } from '../../hooks/useCesiumStereo'
import * as Cesium from 'cesium'
import './VRScene.css'

interface VRSceneProps {
  cesiumViewer: Cesium.Viewer | null
}

/**
 * VR Scene Component
 *
 * Creates a Babylon.js WebXR scene that:
 * 1. Displays Cesium stereo renders as background textures
 * 2. Renders Babylon.js overlay elements (labels, weather, aircraft) in VR
 * 3. Manages WebXR session lifecycle
 */
function VRScene({ cesiumViewer }: VRSceneProps) {
  const isVRActive = useVRStore((state) => state.isVRActive)
  const setVRActive = useVRStore((state) => state.setVRActive)
  const setVRError = useVRStore((state) => state.setVRError)

  // Refs for Babylon.js resources
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<BABYLON.Engine | null>(null)
  const sceneRef = useRef<BABYLON.Scene | null>(null)
  const xrHelperRef = useRef<BABYLON.WebXRDefaultExperience | null>(null)

  // Refs for background texture planes
  const leftEyePlaneRef = useRef<BABYLON.Mesh | null>(null)
  const rightEyePlaneRef = useRef<BABYLON.Mesh | null>(null)
  const leftTextureRef = useRef<BABYLON.DynamicTexture | null>(null)
  const rightTextureRef = useRef<BABYLON.DynamicTexture | null>(null)

  // Cesium stereo rendering
  const { stereoTextures, renderStereoFrame, isActive: isStereoActive } = useCesiumStereo(
    cesiumViewer,
    1536, // Render resolution per eye
    1536
  )

  // Store stereoTextures in a ref for access inside render loop
  const stereoTexturesRef = useRef(stereoTextures)
  stereoTexturesRef.current = stereoTextures

  // Cleanup function - defined first so it can be used in other functions
  const cleanup = useCallback(() => {
    if (xrHelperRef.current) {
      xrHelperRef.current.dispose()
      xrHelperRef.current = null
    }

    if (sceneRef.current) {
      sceneRef.current.dispose()
      sceneRef.current = null
    }

    if (engineRef.current) {
      engineRef.current.dispose()
      engineRef.current = null
    }

    leftEyePlaneRef.current = null
    rightEyePlaneRef.current = null
    leftTextureRef.current = null
    rightTextureRef.current = null
  }, [])

  // Initialize Babylon.js engine and scene
  const initializeBabylon = useCallback(async () => {
    if (!canvasRef.current) return

    try {
      // Create engine
      const engine = new BABYLON.Engine(canvasRef.current, true, {
        preserveDrawingBuffer: true,
        stencil: true,
        antialias: true
      })
      engineRef.current = engine

      // Create scene
      const scene = new BABYLON.Scene(engine)
      scene.clearColor = new BABYLON.Color4(0, 0, 0, 1)
      sceneRef.current = scene

      // Create camera (will be overridden by WebXR)
      const camera = new BABYLON.FreeCamera(
        'vrCamera',
        new BABYLON.Vector3(0, 1.6, 0), // Approximate eye height
        scene
      )
      camera.attachControl(canvasRef.current, true)
      camera.minZ = 0.1
      camera.maxZ = 100000

      // Lighting
      const light = new BABYLON.HemisphericLight(
        'light',
        new BABYLON.Vector3(0, 1, 0),
        scene
      )
      light.intensity = 1.0

      // Create background planes for stereo Cesium renders
      createBackgroundPlanesInline(scene)

      // Initialize WebXR
      const xrHelper = await scene.createDefaultXRExperienceAsync({
        uiOptions: {
          sessionMode: 'immersive-vr'
        },
        optionalFeatures: true
      })
      xrHelperRef.current = xrHelper

      // Handle XR session state changes
      xrHelper.baseExperience.onStateChangedObservable.add((state) => {
        switch (state) {
          case BABYLON.WebXRState.NOT_IN_XR:
            console.log('VR: Exited XR session')
            setVRActive(false)
            break
          case BABYLON.WebXRState.ENTERING_XR:
            console.log('VR: Entering XR session')
            break
          case BABYLON.WebXRState.IN_XR:
            console.log('VR: In XR session')
            break
          case BABYLON.WebXRState.EXITING_XR:
            console.log('VR: Exiting XR session')
            break
        }
      })

      // Start render loop
      engine.runRenderLoop(() => {
        if (scene && !scene.isDisposed) {
          // Render Cesium stereo frames and update textures
          if (isStereoActive) {
            renderStereoFrame()
            updateTexturesInline()
          }

          scene.render()
        }
      })

      // Handle resize
      const handleResize = () => engine.resize()
      window.addEventListener('resize', handleResize)

      // Enter VR immediately
      await xrHelper.baseExperience.enterXRAsync('immersive-vr', 'local-floor')

    } catch (error) {
      console.error('Failed to initialize VR scene:', error)
      setVRError(error instanceof Error ? error.message : 'Failed to initialize VR')
      setVRActive(false)
    }

    // Helper function to create background planes (inline to avoid dependency issues)
    function createBackgroundPlanesInline(scene: BABYLON.Scene) {
      // Create dynamic textures for each eye
      const leftTexture = new BABYLON.DynamicTexture(
        'leftEyeTexture',
        { width: 1536, height: 1536 },
        scene,
        false
      )
      leftTextureRef.current = leftTexture

      const rightTexture = new BABYLON.DynamicTexture(
        'rightEyeTexture',
        { width: 1536, height: 1536 },
        scene,
        false
      )
      rightTextureRef.current = rightTexture

      // Create materials
      const leftMaterial = new BABYLON.StandardMaterial('leftEyeMaterial', scene)
      leftMaterial.diffuseTexture = leftTexture
      leftMaterial.emissiveTexture = leftTexture // Make it self-lit
      leftMaterial.backFaceCulling = false

      const rightMaterial = new BABYLON.StandardMaterial('rightEyeMaterial', scene)
      rightMaterial.diffuseTexture = rightTexture
      rightMaterial.emissiveTexture = rightTexture
      rightMaterial.backFaceCulling = false

      // Create large planes positioned far back
      // In VR, these will serve as the "skybox" showing the Cesium globe
      const planeSize = 1000 // Large enough to fill peripheral vision
      const planeDistance = 500 // Distance from camera

      const leftPlane = BABYLON.MeshBuilder.CreatePlane(
        'leftEyePlane',
        { size: planeSize },
        scene
      )
      leftPlane.position = new BABYLON.Vector3(0, 0, planeDistance)
      leftPlane.material = leftMaterial
      leftPlane.isPickable = false
      // Left eye only (layer mask)
      leftPlane.layerMask = 0x10000000
      leftEyePlaneRef.current = leftPlane

      const rightPlane = BABYLON.MeshBuilder.CreatePlane(
        'rightEyePlane',
        { size: planeSize },
        scene
      )
      rightPlane.position = new BABYLON.Vector3(0, 0, planeDistance)
      rightPlane.material = rightMaterial
      rightPlane.isPickable = false
      // Right eye only (layer mask)
      rightPlane.layerMask = 0x20000000
      rightEyePlaneRef.current = rightPlane
    }

    // Helper function to update textures (inline to access refs)
    function updateTexturesInline() {
      const textures = stereoTexturesRef.current
      if (!textures.leftCanvas || !textures.rightCanvas) return
      if (!leftTextureRef.current || !rightTextureRef.current) return

      // Get the texture contexts
      const leftCtx = leftTextureRef.current.getContext()
      const rightCtx = rightTextureRef.current.getContext()

      if (leftCtx && textures.leftCanvas) {
        leftCtx.drawImage(textures.leftCanvas, 0, 0)
        leftTextureRef.current.update()
      }

      if (rightCtx && textures.rightCanvas) {
        rightCtx.drawImage(textures.rightCanvas, 0, 0)
        rightTextureRef.current.update()
      }
    }
  }, [setVRActive, setVRError, isStereoActive, renderStereoFrame])

  // Initialize when VR becomes active
  useEffect(() => {
    if (isVRActive && canvasRef.current && !engineRef.current) {
      initializeBabylon()
    }

    return () => {
      // Cleanup on unmount or VR deactivation
      if (!isVRActive && engineRef.current) {
        cleanup()
      }
    }
  }, [isVRActive, initializeBabylon, cleanup])

  // Don't render if VR is not active
  if (!isVRActive) {
    return null
  }

  return (
    <canvas
      ref={canvasRef}
      className="vr-scene-canvas"
    />
  )
}

export default VRScene
