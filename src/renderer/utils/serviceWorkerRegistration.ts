/**
 * Registers the tile caching service worker.
 * The service worker intercepts tile requests at the HTTP layer,
 * completely transparent to Cesium, avoiding any interference with
 * Cesium's request throttling mechanism.
 */
export async function registerTileCacheServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service workers not supported in this environment')
    return null
  }

  try {
    // Service worker is in public folder
    // In dev: served from root (/)
    // In prod: served relative to the HTML file (./)
    const swUrl = import.meta.env.DEV ? '/service-worker.js' : './service-worker.js'
    const scope = import.meta.env.DEV ? '/' : './'

    const registration = await navigator.serviceWorker.register(swUrl, {
      scope
    })

    console.log('[TileCache] Service worker registered:', registration.scope)

    // Wait for the service worker to be ready
    await navigator.serviceWorker.ready
    console.log('[TileCache] Service worker is ready')

    return registration
  } catch (error) {
    console.error('[TileCache] Service worker registration failed:', error)
    return null
  }
}

/**
 * Clears the tile cache via the service worker.
 */
export async function clearServiceWorkerCache(): Promise<boolean> {
  if (!navigator.serviceWorker.controller) {
    // No active service worker, try clearing caches directly
    if ('caches' in window) {
      try {
        await caches.delete('cesium-tiles-v1')
        console.log('[TileCache] Cache cleared directly')
        return true
      } catch {
        return false
      }
    }
    return false
  }

  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = (event) => {
      resolve(event.data.success)
    }

    navigator.serviceWorker.controller.postMessage(
      { type: 'CLEAR_CACHE' },
      [channel.port2]
    )

    // Timeout after 5 seconds
    setTimeout(() => resolve(false), 5000)
  })
}

/**
 * Gets cache statistics from the service worker cache.
 */
export async function getServiceWorkerCacheStats(): Promise<{ count: number; sizeBytes: number }> {
  if (!('caches' in window)) {
    return { count: 0, sizeBytes: 0 }
  }

  try {
    const cache = await caches.open('cesium-tiles-v1')
    const keys = await cache.keys()

    let totalSize = 0
    for (const request of keys) {
      const response = await cache.match(request)
      if (response) {
        const blob = await response.clone().blob()
        totalSize += blob.size
      }
    }

    return { count: keys.length, sizeBytes: totalSize }
  } catch {
    return { count: 0, sizeBytes: 0 }
  }
}
