// Tile caching service worker
// Intercepts tile requests at the HTTP layer, transparent to Cesium

const CACHE_NAME = 'cesium-tiles-v1'
const CACHE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

// Patterns for tile URLs we want to cache
const TILE_URL_PATTERNS = [
  /\.cesium\.com.*\/tiles\//,           // Cesium Ion tiles
  /\.virtualearth\.net.*\/tiles\//,     // Bing Maps tiles
  /\.arcgisonline\.com.*\/tile\//,      // ArcGIS tiles
  /\.googleapis\.com.*\/tile\?/,        // Google tiles
  /\.openstreetmap\.org.*\/\d+\/\d+\/\d+/, // OSM tiles
]

// Max cache size in bytes (2GB default)
const MAX_CACHE_SIZE = 2 * 1024 * 1024 * 1024

self.addEventListener('install', (event) => {
  console.log('[SW] Service worker installed')
  // Skip waiting to activate immediately
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  console.log('[SW] Service worker activated')
  // Claim all clients immediately
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  const url = event.request.url

  // Only cache tile requests
  const isTileRequest = TILE_URL_PATTERNS.some(pattern => pattern.test(url))
  if (!isTileRequest) {
    return // Let the request pass through normally
  }

  event.respondWith(handleTileRequest(event.request))
})

async function handleTileRequest(request) {
  const cache = await caches.open(CACHE_NAME)

  // Try cache first
  const cachedResponse = await cache.match(request)
  if (cachedResponse) {
    // Check if cache entry is still valid
    const cachedDate = cachedResponse.headers.get('sw-cached-date')
    if (cachedDate) {
      const age = Date.now() - parseInt(cachedDate, 10)
      if (age < CACHE_EXPIRY_MS) {
        return cachedResponse
      }
      // Cache expired, delete it
      await cache.delete(request)
    } else {
      // No date header, assume it's valid
      return cachedResponse
    }
  }

  // Not in cache or expired, fetch from network
  try {
    const networkResponse = await fetch(request)

    // Only cache successful responses
    if (networkResponse.ok) {
      // Clone the response since we need to read it twice
      const responseToCache = networkResponse.clone()

      // Add a custom header with the cache timestamp
      const headers = new Headers(responseToCache.headers)
      headers.set('sw-cached-date', Date.now().toString())

      const modifiedResponse = new Response(await responseToCache.blob(), {
        status: responseToCache.status,
        statusText: responseToCache.statusText,
        headers
      })

      // Cache the response (fire and forget)
      cache.put(request, modifiedResponse).catch(() => {
        // Caching failed, that's ok
      })

      // Periodically clean up old cache entries
      if (Math.random() < 0.01) { // 1% chance per request
        cleanupCache().catch(() => {})
      }
    }

    return networkResponse
  } catch (error) {
    // Network error - try to return stale cache if available
    const staleResponse = await cache.match(request)
    if (staleResponse) {
      console.log('[SW] Serving stale cache for:', request.url)
      return staleResponse
    }
    throw error
  }
}

async function cleanupCache() {
  const cache = await caches.open(CACHE_NAME)
  const keys = await cache.keys()

  let totalSize = 0
  const entries = []

  // Collect cache entries with their sizes and dates
  for (const request of keys) {
    const response = await cache.match(request)
    if (!response) continue

    const blob = await response.clone().blob()
    const size = blob.size
    totalSize += size

    const cachedDate = response.headers.get('sw-cached-date')
    const date = cachedDate ? parseInt(cachedDate, 10) : 0

    entries.push({ request, date, size })
  }

  // If over size limit, delete oldest entries
  if (totalSize > MAX_CACHE_SIZE) {
    // Sort by date, oldest first
    entries.sort((a, b) => a.date - b.date)

    let freedSize = 0
    const targetFree = totalSize - MAX_CACHE_SIZE * 0.8 // Free 20% extra

    for (const entry of entries) {
      if (freedSize >= targetFree) break
      await cache.delete(entry.request)
      freedSize += entry.size
    }

    console.log(`[SW] Cache cleanup: freed ${(freedSize / 1024 / 1024).toFixed(1)}MB`)
  }

  // Also delete expired entries
  const now = Date.now()
  for (const entry of entries) {
    if (now - entry.date > CACHE_EXPIRY_MS) {
      await cache.delete(entry.request)
    }
  }
}

// Listen for messages from the main thread
self.addEventListener('message', (event) => {
  if (event.data.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(() => {
      console.log('[SW] Cache cleared')
      if (event.ports[0]) {
        event.ports[0].postMessage({ success: true })
      }
    })
  }
})
