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
        creditContainer: document.createElement('div'),
      })

      // Disable the globe and imagery for simple 3D model display
      viewer.scene.globe.show = false
      if (viewer.scene.skyBox) viewer.scene.skyBox.show = false
      if (viewer.scene.sun) viewer.scene.sun.show = false
      if (viewer.scene.moon) viewer.scene.moon.show = false
      if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false

      // Remove all imagery
      viewer.imageryLayers.removeAll()

      // Configure scene for model preview
      viewer.scene.backgroundColor = new Cesium.Color(0.1, 0.1, 0.12, 1.0)
      viewer.scene.logarithmicDepthBuffer = false // Not needed for close-up model
      viewer.scene.highDynamicRange = false
      viewer.scene.postProcessStages.fxaa.enabled = true

      // Simple directional lighting for model visibility
      viewer.scene.light = new Cesium.DirectionalLight({
        direction: new Cesium.Cartesian3(0.3, -0.5, -0.8),
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

    // Load model in simple 3D space (not geographic)
    Cesium.Model.fromGltfAsync({
      url: modelInfo.modelUrl,
      show: true,
      shadows: Cesium.ShadowMode.DISABLED,
    })
      .then((model: Cesium.Model) => {
        if (!viewer || viewer.isDestroyed()) return

        // Create transformation matrix at origin (0,0,0)
        // Start with identity matrix
        let modelMatrix = Cesium.Matrix4.IDENTITY.clone()

        // Apply rotation around Z axis for heading (if specified)
        if (modelInfo.rotationOffset && modelInfo.rotationOffset !== 0) {
          const rotation = Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(modelInfo.rotationOffset))
          const rotationMatrix = Cesium.Matrix4.fromRotationTranslation(rotation)
          modelMatrix = Cesium.Matrix4.multiply(modelMatrix, rotationMatrix, new Cesium.Matrix4())
        }

        // Apply scale
        const scaleMatrix = Cesium.Matrix4.fromScale(
          new Cesium.Cartesian3(modelInfo.scale.x, modelInfo.scale.y, modelInfo.scale.z),
        )
        modelMatrix = Cesium.Matrix4.multiply(modelMatrix, scaleMatrix, new Cesium.Matrix4())

        model.modelMatrix = modelMatrix

        // Add to scene
        viewer.scene.primitives.add(model)

        // Wait for model to be fully ready before positioning camera
        // This ensures boundingSphere is available
        model.readyEvent.addEventListener(() => {
          if (!viewer || viewer.isDestroyed()) return

          // Position camera based on model bounds
          const boundingSphere = model.boundingSphere as Cesium.BoundingSphere
          const center = boundingSphere?.center ?? Cesium.Cartesian3.ZERO
          const radius = boundingSphere?.radius ?? 15
          const distance = radius * 2.5

          // Camera positioned to the side and slightly above
          const cameraPosition = new Cesium.Cartesian3(center.x + distance, center.y, center.z + radius * 0.5)

          viewer.camera.position = cameraPosition
          viewer.camera.direction = Cesium.Cartesian3.normalize(
            Cesium.Cartesian3.subtract(center, cameraPosition, new Cesium.Cartesian3()),
            new Cesium.Cartesian3(),
          )
          viewer.camera.up = Cesium.Cartesian3.UNIT_Z.clone()
          viewer.camera.right = Cesium.Cartesian3.cross(
            viewer.camera.direction,
            viewer.camera.up,
            new Cesium.Cartesian3(),
          )

          setIsLoading(false)
        })
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

      // Get model bounding sphere for distance and center
      const model = viewer.scene.primitives.get(0) as Cesium.Model | undefined
      const center = model?.boundingSphere?.center ?? Cesium.Cartesian3.ZERO
      const radius = model?.boundingSphere?.radius ?? 15
      const distance = radius * 2.5

      // Rotate camera around model in local space
      const cameraX = center.x + Math.cos(angle) * distance
      const cameraY = center.y + Math.sin(angle) * distance
      const cameraZ = center.z + radius * 0.5

      const cameraPosition = new Cesium.Cartesian3(cameraX, cameraY, cameraZ)

      // Update camera to look at model center
      viewer.camera.position = cameraPosition
      viewer.camera.direction = Cesium.Cartesian3.normalize(
        Cesium.Cartesian3.subtract(center, cameraPosition, new Cesium.Cartesian3()),
        new Cesium.Cartesian3(),
      )
      viewer.camera.up = Cesium.Cartesian3.UNIT_Z.clone()
      viewer.camera.right = Cesium.Cartesian3.cross(viewer.camera.direction, viewer.camera.up, new Cesium.Cartesian3())

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
