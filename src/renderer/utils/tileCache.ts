import * as Cesium from 'cesium'

const DB_NAME = 'cesium-tile-cache'
const DB_VERSION = 1
const STORE_NAME = 'tiles'
const MAX_CACHE_SIZE = 200 * 1024 * 1024 // 200MB max cache size (reduced from 500MB to prevent OOM)
const CACHE_EXPIRY_DAYS = 7

interface CachedTile {
  key: string
  data: ArrayBuffer
  timestamp: number
  size: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      console.error('Failed to open tile cache database:', request.error)
      reject(request.error)
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' })
        store.createIndex('timestamp', 'timestamp', { unique: false })
      }
    }
  })

  return dbPromise
}

async function getCachedTile(key: string): Promise<ArrayBuffer | null> {
  try {
    const db = await openDatabase()
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(key)

      request.onsuccess = () => {
        const result = request.result as CachedTile | undefined
        if (result) {
          // Check if cache entry has expired
          const expiryTime = CACHE_EXPIRY_DAYS * 24 * 60 * 60 * 1000
          if (Date.now() - result.timestamp > expiryTime) {
            // Entry expired, delete it
            deleteCachedTile(key)
            resolve(null)
          } else {
            resolve(result.data)
          }
        } else {
          resolve(null)
        }
      }

      request.onerror = () => {
        console.warn('Failed to get cached tile:', request.error)
        resolve(null)
      }
    })
  } catch {
    return null
  }
}

async function setCachedTile(key: string, data: ArrayBuffer): Promise<void> {
  try {
    const db = await openDatabase()
    const tile: CachedTile = {
      key,
      data,
      timestamp: Date.now(),
      size: data.byteLength
    }

    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      store.put(tile)

      transaction.oncomplete = () => {
        // Check cache size and cleanup if needed (fire and forget)
        cleanupCacheIfNeeded()
        resolve()
      }

      transaction.onerror = () => {
        console.warn('Failed to cache tile:', transaction.error)
        resolve()
      }
    })
  } catch {
    // Silently fail - caching is best-effort
  }
}

async function deleteCachedTile(key: string): Promise<void> {
  try {
    const db = await openDatabase()
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      store.delete(key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
    })
  } catch {
    // Silently fail
  }
}

async function cleanupCacheIfNeeded(): Promise<void> {
  try {
    const db = await openDatabase()
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const store = transaction.objectStore(STORE_NAME)

    // Get all entries to calculate total size
    const request = store.getAll()

    request.onsuccess = async () => {
      const tiles = request.result as CachedTile[]
      const totalSize = tiles.reduce((sum, tile) => sum + tile.size, 0)

      if (totalSize > MAX_CACHE_SIZE) {
        // Sort by timestamp (oldest first) and delete until under limit
        tiles.sort((a, b) => a.timestamp - b.timestamp)

        let sizeToFree = totalSize - MAX_CACHE_SIZE * 0.8 // Free 20% extra
        const keysToDelete: string[] = []

        for (const tile of tiles) {
          if (sizeToFree <= 0) break
          keysToDelete.push(tile.key)
          sizeToFree -= tile.size
        }

        // Delete old tiles
        const deleteDb = await openDatabase()
        const deleteTx = deleteDb.transaction(STORE_NAME, 'readwrite')
        const deleteStore = deleteTx.objectStore(STORE_NAME)
        for (const key of keysToDelete) {
          deleteStore.delete(key)
        }

        console.log(`Tile cache cleanup: removed ${keysToDelete.length} tiles`)
      }
    }
  } catch {
    // Silently fail
  }
}

/**
 * Creates a caching wrapper around a Cesium ImageryProvider.
 * Tiles are cached to IndexedDB for persistence across sessions.
 */
export function createCachingImageryProvider(
  baseProvider: Cesium.ImageryProvider
): Cesium.ImageryProvider {
  // Create a proxy that intercepts requestImage
  const originalRequestImage = baseProvider.requestImage.bind(baseProvider)

  baseProvider.requestImage = function (
    x: number,
    y: number,
    level: number,
    request?: Cesium.Request
  ): Promise<Cesium.ImageryTypes> | undefined {
    const cacheKey = `imagery_${level}_${x}_${y}`

    // Try to get from cache first
    return getCachedTile(cacheKey).then((cachedData) => {
      if (cachedData) {
        // Convert ArrayBuffer back to ImageBitmap or HTMLImageElement
        return createImageFromBuffer(cachedData)
      }

      // Not in cache, fetch from original provider
      const result = originalRequestImage(x, y, level, request)
      if (!result) return undefined

      return Promise.resolve(result).then(async (image) => {
        // Cache the result (fire and forget)
        if (image) {
          try {
            const buffer = await imageToArrayBuffer(image)
            if (buffer) {
              setCachedTile(cacheKey, buffer)
            }
          } catch {
            // Caching failed, that's ok
          }
        }
        return image
      })
    }) as Promise<Cesium.ImageryTypes> | undefined
  }

  return baseProvider
}

async function createImageFromBuffer(buffer: ArrayBuffer): Promise<ImageBitmap> {
  const blob = new Blob([buffer], { type: 'image/png' })
  return createImageBitmap(blob)
}

async function imageToArrayBuffer(
  image: Cesium.ImageryTypes
): Promise<ArrayBuffer | null> {
  try {
    // Handle ImageBitmap
    if (image instanceof ImageBitmap) {
      const canvas = new OffscreenCanvas(image.width, image.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(image, 0, 0)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      return blob.arrayBuffer()
    }

    // Handle HTMLImageElement or HTMLCanvasElement
    if (image instanceof HTMLImageElement || image instanceof HTMLCanvasElement) {
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(image, 0, 0)
      return new Promise((resolve) => {
        canvas.toBlob((blob) => {
          if (blob) {
            blob.arrayBuffer().then(resolve)
          } else {
            resolve(null)
          }
        }, 'image/png')
      })
    }

    return null
  } catch {
    return null
  }
}

/**
 * Clears the entire tile cache
 */
export async function clearTileCache(): Promise<void> {
  try {
    const db = await openDatabase()
    const transaction = db.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    store.clear()
    console.log('Tile cache cleared')
  } catch (error) {
    console.error('Failed to clear tile cache:', error)
  }
}

/**
 * Gets cache statistics
 */
export async function getCacheStats(): Promise<{ count: number; sizeBytes: number }> {
  try {
    const db = await openDatabase()
    return new Promise((resolve) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.getAll()

      request.onsuccess = () => {
        const tiles = request.result as CachedTile[]
        resolve({
          count: tiles.length,
          sizeBytes: tiles.reduce((sum, tile) => sum + tile.size, 0)
        })
      }

      request.onerror = () => {
        resolve({ count: 0, sizeBytes: 0 })
      }
    })
  } catch {
    return { count: 0, sizeBytes: 0 }
  }
}
