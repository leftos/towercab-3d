import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serveCesiumAssets } from '../scripts/dev/cesiumAssets'

const hooks = vi.hoisted(() => ({ beforeRead: null as ((path: string) => void) | null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const createReadStream = (path: string, options?: Parameters<typeof actual.createReadStream>[1]) => {
    hooks.beforeRead?.(path)
    return actual.createReadStream(path, options)
  }
  return { ...actual, createReadStream }
})

let dir: string
let server: Server

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tc3d-cesium-assets-'))
  mkdirSync(join(dir, 'Cesium', 'Workers'), { recursive: true })
  writeFileSync(join(dir, 'Cesium', 'Workers', 'task.js'), 'export const task = 1')
  writeFileSync(join(dir, 'Cesium', 'Workers', 'data.json'), '{}')
  writeFileSync(join(dir, 'secret.txt'), 'OUTSIDE-SECRET')
  mkdirSync(join(dir, 'outside'))
  writeFileSync(join(dir, 'outside', 'secret.js'), 'OUTSIDE-SECRET')
  symlinkSync(join(dir, 'outside'), join(dir, 'Cesium', 'link'), 'junction')
})

afterEach(async () => {
  hooks.beforeRead = null
  await new Promise((done) => server.close(done))
  rmSync(dir, { recursive: true, force: true })
})

async function listen(): Promise<number> {
  const middleware = serveCesiumAssets(join(dir, 'Cesium'), '/cesium-package/')
  server = createServer((req, res) =>
    middleware(req, res, () => {
      res.statusCode = 299
      res.end('next')
    }),
  )
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return (server.address() as AddressInfo).port
}

function get(port: number, path: string): Promise<{ status: number; type: string | undefined; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: '127.0.0.1', port, path }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => done({ status: res.statusCode ?? 0, type: res.headers['content-type'], body }))
    })
    req.on('error', fail)
    req.end()
  })
}

describe('serveCesiumDev', () => {
  it('servesAssetsInsideTheCesiumFolderOnly', async () => {
    const port = await listen()
    const served = await get(port, '/cesium-package/Workers/task.js?v=1')
    expect(served).toEqual({ status: 200, type: 'application/javascript', body: 'export const task = 1' })
    expect((await get(port, '/cesium-package/Workers/data.json')).type).toBe('application/json')

    for (const path of [
      '/cesium-package/../secret.txt',
      '/cesium-package/Workers/../../secret.txt',
      '/cesium-package/%2e%2e/secret.txt',
      '/cesium-package/..%2Fsecret.txt',
      '/cesium-package/..%5Csecret.txt',
      '/cesium-package/Workers\\..\\..\\secret.txt',
      '/cesium-package/link/secret.js',
      '/cesium-package/C:/Windows/win.ini',
      '/cesium-package/Workers/missing.js',
      '/cesium-package/Workers',
    ]) {
      const reply = await get(port, path)
      expect({ path, status: reply.status }).toEqual({ path, status: 299 })
      expect(reply.body).not.toContain('OUTSIDE-SECRET')
    }
    expect((await get(port, '/other/Workers/task.js')).status).toBe(299)
  })

  it('fileDeletedBeforeReadGives500', async () => {
    const port = await listen()
    // The file passes the path check, then goes before the stream opens it.
    hooks.beforeRead = (path) => rmSync(path)
    const reply = await get(port, '/cesium-package/Workers/task.js')
    expect(reply.status).toBe(500)
    expect(reply.body).not.toContain('task')
    hooks.beforeRead = null
    expect((await get(port, '/cesium-package/Workers/data.json')).status).toBe(200)
  })
})
