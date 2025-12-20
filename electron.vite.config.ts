import { resolve, join } from 'node:path'
import { createReadStream, existsSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { viteStaticCopy } from 'vite-plugin-static-copy'
import type { Plugin } from 'vite'

const cesiumBaseUrl = 'cesium-package'
const cesiumSource = resolve('node_modules/cesium/Build/Cesium')

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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    base: './',
    define: {
      CESIUM_BASE_URL: JSON.stringify(`./${cesiumBaseUrl}`)
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer')
      }
    },
    plugins: [
      react(),
      serveCesiumDev(),
      viteStaticCopy({
        targets: [
          { src: '../../node_modules/cesium/Build/Cesium/ThirdParty', dest: cesiumBaseUrl },
          { src: '../../node_modules/cesium/Build/Cesium/Workers', dest: cesiumBaseUrl },
          { src: '../../node_modules/cesium/Build/Cesium/Assets', dest: cesiumBaseUrl },
          { src: '../../node_modules/cesium/Build/Cesium/Widgets', dest: cesiumBaseUrl }
        ]
      })
    ]
  }
})
