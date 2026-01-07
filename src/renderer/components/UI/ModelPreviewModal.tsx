import { useEffect, useRef, useState } from 'react'
import * as Cesium from 'cesium'
import { useGlobalSettingsStore } from '../../stores/globalSettingsStore'
import type { ModelInfo } from '../../services/AircraftModelService'
import './ModelPreviewModal.css'

interface ModelPreviewModalProps {
  modelInfo: ModelInfo
  onClose: () => void
}

export function ModelPreviewModal({ modelInfo, onClose }: ModelPreviewModalProps) {
  const cesiumIonToken = useGlobalSettingsStore((state) => state.cesiumIonToken)
  const containerRef = useRef<HTMLDivElement>(null)
  const viewerRef = useRef<Cesium.Viewer | null>(null)
  const animationFrameRef = useRef<number>(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Initialize Cesium viewer
  useEffect(() => {
    if (!containerRef.current || !cesiumIonToken) return

    try {
      // Set Cesium Ion token (required before creating viewer)
      Cesium.Ion.defaultAccessToken = cesiumIonToken

      // Create minimal Cesium viewer
      const viewer = new Cesium.Viewer(containerRef.current, {
        // Disable all UI
        animation: false,
        baseLayerPicker: false,
        fullscreenButton: false,
        geocoder: false,
        homeButton: false,
        infoBox: false,
        sceneModePicker: false,
        selectionIndicator: false,
        timeline: false,
        navigationHelpButton: false,
        navigationInstructionsInitiallyVisible: false,

        // No terrain provider for minimal setup
        terrain: undefined,

        // Quality settings
        msaaSamples: 4,
        creditContainer: document.createElement('div')
      })

      // Set single color background (no imagery)
      const imageryLayers = viewer.imageryLayers
      imageryLayers.removeAll()
      imageryLayers.addImageryProvider(
        new Cesium.SingleTileImageryProvider({
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mM8duzYfwAHwQL9h9FqHwAAAABJRU5ErkJggg==',
          rectangle: Cesium.Rectangle.MAX_VALUE
        })
      )

      // Configure scene
      viewer.scene.globe.enableLighting = false
      viewer.scene.globe.depthTestAgainstTerrain = false
      viewer.scene.backgroundColor = new Cesium.Color(0.1, 0.1, 0.15, 1.0)
      viewer.scene.logarithmicDepthBuffer = true
      viewer.scene.highDynamicRange = true
      viewer.scene.postProcessStages.fxaa.enabled = true

      // Simple lighting
      viewer.scene.light = new Cesium.DirectionalLight({
        direction: new Cesium.Cartesian3(0.3, -0.5, -0.8)
      })

      viewerRef.current = viewer
    } catch (err) {
      setError('Failed to initialize preview viewer')
      console.error('Cesium viewer creation failed:', err)
    }

    return () => {
      if (viewerRef.current && !viewerRef.current.isDestroyed()) {
        viewerRef.current.destroy()
        viewerRef.current = null
      }
    }
  }, [cesiumIonToken])

  // Load model
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed()) return

    setIsLoading(true)
    setError(null)

    // Clear previous models
    viewer.scene.primitives.removeAll()

    // Load model at world origin
    Cesium.Model.fromGltfAsync({
      url: modelInfo.modelUrl,
      show: true,
      shadows: Cesium.ShadowMode.DISABLED,
      modelMatrix: Cesium.Matrix4.IDENTITY
    })
      .then((model: Cesium.Model) => {
        if (!viewer || viewer.isDestroyed()) return

        // Apply scale and rotation from ModelInfo
        const position = Cesium.Cartesian3.ZERO
        const hpr = new Cesium.HeadingPitchRoll(
          Cesium.Math.toRadians(modelInfo.rotationOffset ?? 0),
          0,
          0
        )
        const modelMatrix = Cesium.Transforms.headingPitchRollToFixedFrame(position, hpr)

        const scaleMatrix = Cesium.Matrix4.fromScale(
          new Cesium.Cartesian3(
            modelInfo.scale.x,
            modelInfo.scale.y,
            modelInfo.scale.z
          )
        )
        Cesium.Matrix4.multiply(modelMatrix, scaleMatrix, modelMatrix)
        model.modelMatrix = modelMatrix

        // Add to scene
        viewer.scene.primitives.add(model)

        // Position camera based on model bounds
        const boundingSphere = model.boundingSphere as Cesium.BoundingSphere
        const radius = boundingSphere?.radius ?? 15
        const distance = radius * 2.5

        viewer.camera.setView({
          destination: new Cesium.Cartesian3(distance, 0, radius * 0.8),
          orientation: {
            heading: Cesium.Math.toRadians(-90),
            pitch: Cesium.Math.toRadians(-20),
            roll: 0
          }
        })

        setIsLoading(false)
      })
      .catch((err: Error) => {
        console.error('Model loading failed:', err)
        setError(`Failed to load model: ${err.message || 'Unknown error'}`)
        setIsLoading(false)
      })
  }, [modelInfo])

  // Auto-rotation animation
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || viewer.isDestroyed() || isLoading || error) return

    const startTime = Date.now()

    const animate = () => {
      if (!viewer || viewer.isDestroyed()) return

      const currentTime = Date.now()
      const elapsed = currentTime - startTime

      // Calculate rotation angle (360° in 10 seconds)
      const angle = (elapsed / 10000) * Math.PI * 2

      // Get model bounding sphere for distance calculation
      const model = viewer.scene.primitives.get(0) as Cesium.Model | undefined
      const radius = model?.boundingSphere?.radius ?? 15
      const distance = radius * 2.5

      const cameraX = Math.cos(angle) * distance
      const cameraY = Math.sin(angle) * distance
      const cameraZ = radius * 0.8

      // Update camera position
      viewer.camera.setView({
        destination: new Cesium.Cartesian3(cameraX, cameraY, cameraZ),
        orientation: {
          heading: angle + Math.PI / 2,
          pitch: Cesium.Math.toRadians(-20),
          roll: 0
        }
      })

      animationFrameRef.current = requestAnimationFrame(animate)
    }

    animationFrameRef.current = requestAnimationFrame(animate)

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
    }
  }, [isLoading, error])

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  // Get display name for the model
  const getModelDisplayName = (): string => {
    if (modelInfo.matchedModel) {
      return modelInfo.matchedModel
    }
    return 'Aircraft Model'
  }

  return (
    <div className="model-preview-overlay" onClick={onClose}>
      <div className="model-preview-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="model-preview-header">
          <h3>{getModelDisplayName()}</h3>
          <button className="close-button" onClick={onClose}>
            ×
          </button>
        </div>

        {/* Cesium Container */}
        <div className="model-preview-container" ref={containerRef} />

        {/* Loading Overlay */}
        {isLoading && (
          <div className="model-preview-overlay-content model-preview-loading">
            <div className="spinner" />
            <p>Loading model...</p>
          </div>
        )}

        {/* Error Overlay */}
        {error && (
          <div className="model-preview-overlay-content model-preview-error">
            <p className="error-message">{error}</p>
            <p className="error-url">{modelInfo.modelUrl}</p>
            <button className="error-close-button" onClick={onClose}>
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
