import { createReadStream } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname } from 'node:path'
import { type ResolvedPath, resolveUnderRoot } from './safePath'

const CONTENT_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
}

/**
 * A dev-server middleware serving Cesium's static assets from `sourceDir` under `urlPrefix`
 * (for example `/cesium-package/`). A path that is malformed, leaves `sourceDir` or names no file
 * is passed on to the next middleware. A file that cannot be read gets a 500 (or a dropped
 * connection once the reply has started).
 */
export function serveCesiumAssets(sourceDir: string, urlPrefix: string) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const path = (req.url ?? '').split('?')[0]
    if (!path.startsWith(urlPrefix)) {
      next()
      return
    }
    let resolved: ResolvedPath
    try {
      resolved = resolveUnderRoot(sourceDir, path.slice(urlPrefix.length), null)
    } catch {
      failAsset(res)
      return
    }
    if (resolved.kind !== 'file') {
      next()
      return
    }
    const contentType = CONTENT_TYPES[extname(resolved.path).toLowerCase()]
    if (contentType) res.setHeader('Content-Type', contentType)
    const stream = createReadStream(resolved.path)
    stream.on('error', () => failAsset(res))
    stream.pipe(res)
  }
}

/** Ends an asset request that could not be read, logging a fixed line (the path names the user's folders). */
function failAsset(res: ServerResponse): void {
  console.error('[cesium-assets] a Cesium asset could not be read')
  if (res.headersSent) {
    res.destroy()
    return
  }
  res.removeHeader('Content-Type')
  res.statusCode = 500
  res.end()
}
