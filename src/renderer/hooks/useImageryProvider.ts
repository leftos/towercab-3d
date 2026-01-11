import { useEffect, useRef } from 'react'
import * as Cesium from 'cesium'
import type { ImageryProviderType } from '@/types'

export interface ImagerySettings {
  /** Selected imagery provider */
  provider: ImageryProviderType
  /** Google Maps API key (required when provider is 'google') */
  googleMapsApiKey: string
  /** Cesium Ion token (required when provider is 'cesium') */
  cesiumIonToken: string
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
 *   cesiumIonToken: 'YOUR_CESIUM_TOKEN'
 * })
 * ```
 */
export function useImageryProvider(
  viewer: Cesium.Viewer | null,
  settings: ImagerySettings
): void {
  const { provider, googleMapsApiKey, cesiumIonToken } = settings
  const currentProviderRef = useRef<string | null>(null)
  const isInitializedRef = useRef(false)

  useEffect(() => {
    if (!viewer || viewer.isDestroyed()) return

    // Skip if settings haven't effectively changed
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

        if (provider === 'google') {
          // Set Google Maps API key
          Cesium.GoogleMaps.defaultApiKey = googleMapsApiKey

          // Create Google 2D satellite imagery provider
          const googleProvider = await Cesium.Google2DImageryProvider.fromUrl({
            mapType: 'satellite'
          })

          // Add at index 0 (base layer for night darkening compatibility)
          // Type assertion needed due to Cesium type definition mismatch
          const googleLayer = new Cesium.ImageryLayer(googleProvider as unknown as Cesium.ImageryProvider)
          imageryLayers.add(googleLayer, 0)
          console.log('[useImageryProvider] Switched to Google Maps satellite imagery')
        } else {
          // Use Cesium Ion default (Bing Maps)
          // Asset ID 2 is the default Bing Maps Aerial imagery
          const ionLayer = await Cesium.ImageryLayer.fromProviderAsync(
            Cesium.IonImageryProvider.fromAssetId(2)
          )
          imageryLayers.add(ionLayer, 0)
          console.log('[useImageryProvider] Switched to Cesium Ion (Bing Maps)')
        }

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
            currentProviderRef.current = 'cesium'
            isInitializedRef.current = true
          } catch (fallbackError) {
            console.error('[useImageryProvider] Fallback to Cesium Ion also failed:', fallbackError)
          }
        }
      }
    }

    updateImageryProvider()
  }, [viewer, provider, googleMapsApiKey, cesiumIonToken])

  // Cleanup: no action needed, viewer destruction handles layer cleanup
}
