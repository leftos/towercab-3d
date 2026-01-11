import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import type { ImageryProviderType, ImageryAdjustments } from '@/types'
import { DEFAULT_IMAGERY_ADJUSTMENTS } from '@/types'

export interface ImagerySettings {
  /** Selected imagery provider */
  provider: ImageryProviderType
  /** Google Maps API key (required when provider is 'google') */
  googleMapsApiKey: string
  /** Cesium Ion token (required when provider is 'cesium') */
  cesiumIonToken: string
  /** Per-provider color adjustments */
  cesiumAdjustments: ImageryAdjustments
  googleAdjustments: ImageryAdjustments
}

/**
 * Apply color adjustments to an imagery layer
 */
function applyAdjustments(layer: Cesium.ImageryLayer, adjustments: ImageryAdjustments): void {
  // Convert hue from degrees to radians (-PI to PI)
  layer.hue = Cesium.Math.toRadians(adjustments.hueShift)
  layer.saturation = adjustments.saturation
  layer.brightness = adjustments.brightness
  layer.contrast = adjustments.contrast
}

/**
 * Manages imagery provider switching at runtime
 *
 * ## How It Works
 * This hook watches for changes to imagery settings and swaps the base
 * imagery layer accordingly. It maintains compatibility with the night
 * darkening effect by ensuring the base layer is always at index 0.
 *
 * ## Supported Providers
 * - **Cesium Ion (default)**: Uses Bing Maps satellite imagery via Cesium Ion
 * - **Google Maps**: Uses Google 2D satellite imagery
 *
 * ## Color Adjustments
 * Each provider has its own color adjustment settings (hue, saturation,
 * brightness, contrast) that are applied after the layer is created.
 *
 * ## Requirements
 * - Cesium Ion: Requires valid cesiumIonToken
 * - Google Maps: Requires valid googleMapsApiKey from Google Cloud Console
 *
 * @param viewer - Initialized Cesium.Viewer instance
 * @param settings - Imagery provider settings
 *
 * @example
 * ```tsx
 * useImageryProvider(viewer, {
 *   provider: 'google',
 *   googleMapsApiKey: 'YOUR_API_KEY',
 *   cesiumIonToken: 'YOUR_CESIUM_TOKEN',
 *   cesiumAdjustments: { hueShift: 0, saturation: 1, brightness: 1, contrast: 1 },
 *   googleAdjustments: { hueShift: -10, saturation: 0.9, brightness: 1, contrast: 1 }
 * })
 * ```
 */
export function useImageryProvider(
  viewer: Cesium.Viewer | null,
  settings: ImagerySettings
): void {
  const { provider, googleMapsApiKey, cesiumIonToken, cesiumAdjustments, googleAdjustments } = settings
  const currentProviderRef = useRef<string | null>(null)
  const isInitializedRef = useRef(false)

  // Get adjustments for current provider
  const currentAdjustments = provider === 'google' ? googleAdjustments : cesiumAdjustments

  // Effect for provider switching (creates new layer)
  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    // Skip if provider hasn't changed
    if (currentProviderRef.current === provider && isInitializedRef.current) {
      return
    }

    // For Google Maps, require an API key
    if (provider === 'google' && !googleMapsApiKey) {
      console.warn('[useImageryProvider] Google Maps selected but no API key provided')
      return
    }

    // For Cesium, require Ion token
    if (provider === 'cesium' && !cesiumIonToken) {
      console.warn('[useImageryProvider] Cesium Ion selected but no token provided')
      return
    }

    const updateImageryProvider = async () => {
      try {
        const imageryLayers = viewer.imageryLayers

        // Remove existing base layer if present
        if (imageryLayers.length > 0) {
          imageryLayers.remove(imageryLayers.get(0), true)
        }

        let newLayer: Cesium.ImageryLayer

        if (provider === 'google') {
          // Set Google Maps API key
          Cesium.GoogleMaps.defaultApiKey = googleMapsApiKey

          // Create Google 2D satellite imagery provider
          const googleProvider = await Cesium.Google2DImageryProvider.fromUrl({
            mapType: 'satellite'
          })

          // Add at index 0 (base layer for night darkening compatibility)
          // Type assertion needed due to Cesium type definition mismatch
          newLayer = new Cesium.ImageryLayer(googleProvider as unknown as Cesium.ImageryProvider)
          imageryLayers.add(newLayer, 0)
          console.log('[useImageryProvider] Switched to Google Maps satellite imagery')
        } else {
          // Use Cesium Ion default (Bing Maps)
          // Asset ID 2 is the default Bing Maps Aerial imagery
          newLayer = await Cesium.ImageryLayer.fromProviderAsync(
            Cesium.IonImageryProvider.fromAssetId(2)
          )
          imageryLayers.add(newLayer, 0)
          console.log('[useImageryProvider] Switched to Cesium Ion (Bing Maps)')
        }

        // Apply color adjustments for this provider
        const adjustments = provider === 'google' ? googleAdjustments : cesiumAdjustments
        applyAdjustments(newLayer, adjustments ?? DEFAULT_IMAGERY_ADJUSTMENTS)
        console.log('[useImageryProvider] Applied adjustments:', adjustments)

        currentProviderRef.current = provider
        isInitializedRef.current = true
      } catch (error) {
        console.error('[useImageryProvider] Failed to switch imagery provider:', error)
        // If Google fails, try falling back to Cesium Ion
        if (provider === 'google') {
          console.log('[useImageryProvider] Falling back to Cesium Ion')
          try {
            const imageryLayers = viewer.imageryLayers
            const fallbackLayer = await Cesium.ImageryLayer.fromProviderAsync(
              Cesium.IonImageryProvider.fromAssetId(2)
            )
            imageryLayers.add(fallbackLayer, 0)
            // Apply cesium adjustments for fallback
            applyAdjustments(fallbackLayer, cesiumAdjustments ?? DEFAULT_IMAGERY_ADJUSTMENTS)
            currentProviderRef.current = 'cesium'
            isInitializedRef.current = true
          } catch (fallbackError) {
            console.error('[useImageryProvider] Fallback to Cesium Ion also failed:', fallbackError)
          }
        }
      }
    }

    updateImageryProvider()
  }, [viewer, provider, googleMapsApiKey, cesiumIonToken, cesiumAdjustments, googleAdjustments])

  // Effect for adjustment changes (updates existing layer without recreating)
  useEffect(() => {
    if (!viewer || viewer.isDestroyed() || !isInitializedRef.current) return

    const imageryLayers = viewer.imageryLayers
    if (imageryLayers.length === 0) return

    const baseLayer = imageryLayers.get(0)
    if (!baseLayer) return

    // Apply adjustments to existing layer
    applyAdjustments(baseLayer, currentAdjustments ?? DEFAULT_IMAGERY_ADJUSTMENTS)
    console.log('[useImageryProvider] Updated adjustments:', currentAdjustments)
  }, [viewer, currentAdjustments])

  // Cleanup: no action needed, viewer destruction handles layer cleanup
}
