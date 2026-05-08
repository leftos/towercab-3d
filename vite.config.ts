import { resolve, join } from 'node:path'
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { defineConfig } from 'vite'

// Read version from package.json
const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf-8'))
const appVersion = packageJson.version
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import type { Plugin } from 'vite'

const cesiumBaseUrl = 'cesium-package'
// Use forward slashes for glob patterns (fast-glob requirement)
const cesiumSource = resolve('node_modules/cesium/Build/Cesium').replace(/\\/g, '/')

// Check if Cesium assets already exist in dist (skip copying for faster rebuilds)
const cesiumAssetsExist = existsSync(resolve('dist/cesium-package/Workers'))

// Fast dev build mode - skip minification for faster iteration
const fastDevBuild = process.env.VITE_FAST_BUILD === '1'

// Plugin to write build mode marker after build completes
// This allows dev-wrapper.js to detect if last build was dev (unminified) or prod (minified)
function writeBuildModeMarker(): Plugin {
  return {
    name: 'write-build-mode-marker',
    closeBundle() {
      const mode = fastDevBuild ? 'dev' : 'prod'
      writeFileSync(resolve('dist/.build-mode'), mode)
    }
  }
}

// Middleware plugin to serve Cesium assets in dev mode
function serveCesiumDev(): Plugin {
  return {
    name: 'serve-cesium-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith(`/${cesiumBaseUrl}/`)) {
          const assetPath = req.url.replace(`/${cesiumBaseUrl}/`, '')
          const filePath = join(cesiumSource, assetPath)
          if (existsSync(filePath)) {
            // Set appropriate content type
            if (filePath.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript')
            else if (filePath.endsWith('.json')) res.setHeader('Content-Type', 'application/json')
            else if (filePath.endsWith('.png')) res.setHeader('Content-Type', 'image/png')
            else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) res.setHeader('Content-Type', 'image/jpeg')
            else if (filePath.endsWith('.css')) res.setHeader('Content-Type', 'text/css')
            else if (filePath.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm')
            createReadStream(filePath).pipe(res)
            return
          }
        }
        next()
      })
    }
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  publicDir: resolve('src/renderer/public'),
  root: resolve('src/renderer'),

  define: {
    CESIUM_BASE_URL: JSON.stringify(`/${cesiumBaseUrl}`),
    APP_VERSION: JSON.stringify(appVersion)
  },

  resolve: {
    alias: {
      '@': resolve('src/renderer')
    }
  },

  // Babylon 9.x AudioV2 has a circular import that breaks when esbuild pre-bundles
  // it (audioBus.js extends an undefined AbstractAudioBus). Skip optimization so the
  // browser handles the ESM directly — native ESM resolves the cycle correctly.
  optimizeDeps: {
    exclude: ['@babylonjs/core']
  },

  // Worker configuration - compile TypeScript workers to JS
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js'
      }
    }
  },

  build: {
    outDir: resolve('dist'),
    // Skip emptying dist if Cesium assets exist (faster rebuilds)
    // Full rebuild still happens on clean builds or after npm update cesium
    emptyOutDir: !cesiumAssetsExist,
    // Skip minification in fast dev mode (VITE_FAST_BUILD=1)
    minify: fastDevBuild ? false : 'esbuild',
    target: 'esnext',
    sourcemap: false,
    rollupOptions: {
      // Multi-entry build: main app + inset iframe app
      input: {
        main: resolve('src/renderer/index.html'),
        inset: resolve('src/renderer/inset.html')
      }
    },
    rolldownOptions: {
      output: {
        // Replaces the deprecated manualChunks API. Each group emits a
        // standalone chunk, which keeps cesium/babylon/react cacheable
        // independently of the application code that imports them.
        codeSplitting: {
          groups: [
            // cesium ships its widgets as a separate @cesium/widgets package; both must land in the same chunk.
            { name: 'cesium', test: /[\\/]node_modules[\\/]@?cesium[\\/]/, priority: 10 },
            { name: 'babylon', test: /[\\/]node_modules[\\/]@babylonjs[\\/]/, priority: 10 },
            { name: 'react-vendor', test: /[\\/]node_modules[\\/](react|react-dom)[\\/]/, priority: 10 },
            // zustand must live in its own chunk: stores are split into separate
            // chunks (via dynamic imports in MigrationService etc.), and if `create`
            // ships in the main index chunk it forms a circular dep — the stores
            // call `create()` at module top level before the binding is initialized,
            // producing `TypeError: F is not a function` at boot.
            { name: 'zustand', test: /[\\/]node_modules[\\/]zustand[\\/]/, priority: 10 }
          ]
        }
      }
    }
  },

  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Proxy RealTraffic API requests through Tauri backend (bypasses CORS)
      '/api/realtraffic': {
        target: 'http://localhost:8765',
        changeOrigin: true
      }
    }
  },

  plugins: [
    react(),
    serveCesiumDev(),
    writeBuildModeMarker(),
    // Only copy Cesium assets if they don't exist (speeds up rebuilds significantly).
    //
    // NOTE: pinned to vite-plugin-static-copy ^3 in package.json. v4.0.0 made
    // two breaking changes that silently corrupt this config:
    //   1. Glob patterns no longer flatten — `<source>/Workers/**/*` preserves
    //      the entire matched source path inside `dest`, so files end up at
    //      `cesium-package/Workers/node_modules/cesium/Build/Cesium/Workers/<file>`
    //      instead of `cesium-package/Workers/<file>`.
    //   2. Globs only match files (not directories).
    // The v4 result here is that Cesium's runtime worker requests 404 and Tauri
    // serves index.html as text/html, surfacing as
    // `InvalidStateError: source image could not be decoded` on the first
    // imagery tile. v3 keeps the historic flatten-into-dest behavior we depend on.
    ...(!cesiumAssetsExist ? [viteStaticCopy({
      targets: [
        { src: `${cesiumSource}/ThirdParty/**/*`, dest: `${cesiumBaseUrl}/ThirdParty` },
        { src: `${cesiumSource}/Workers/**/*`, dest: `${cesiumBaseUrl}/Workers` },
        { src: `${cesiumSource}/Assets/**/*`, dest: `${cesiumBaseUrl}/Assets` },
        { src: `${cesiumSource}/Widgets/**/*`, dest: `${cesiumBaseUrl}/Widgets` }
      ]
    })] : [])
  ]
})
