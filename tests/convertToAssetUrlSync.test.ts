import { beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * convertToAssetUrlSync as a browser client of the desktop server sees it:
 * remote mode, the page served from the host's origin, no Tauri globals on `window`.
 */
const ORIGIN = 'http://192.168.1.10:8765'

vi.stubGlobal('window', { location: { origin: ORIGIN } })

let convertToAssetUrlSync!: (filePath: string) => string

beforeAll(async () => {
  const api = await import('../src/renderer/utils/tauriApi')
  convertToAssetUrlSync = api.convertToAssetUrlSync
})

describe('convertToAssetUrlSync in remote browser mode', () => {
  it('serves a relative tower mod path from the mods file route', () => {
    expect(convertToAssetUrlSync('mods/towers/KOAK/model.glb')).toBe(`${ORIGIN}/api/mods/file/towers/KOAK/model.glb`)
  })

  it('serves a relative aircraft mod path from the mods file route', () => {
    expect(convertToAssetUrlSync('mods/aircraft/B738/model.glb')).toBe(
      `${ORIGIN}/api/mods/file/aircraft/B738/model.glb`,
    )
  })

  it('serves an absolute Windows mod path from the mods file route', () => {
    expect(convertToAssetUrlSync('C:\\TowerCab\\mods\\towers\\KOAK\\model.glb')).toBe(
      `${ORIGIN}/api/mods/file/towers/KOAK/model.glb`,
    )
  })

  it('serves an MSFS cache path from the cache route', () => {
    expect(convertToAssetUrlSync('C:/cache/fsltl_b738.glb')).toBe(`${ORIGIN}/api/msfs/fsltl_b738.glb`)
  })

  it('keeps a cache folder whose name merely contains "mods" on the cache route', () => {
    expect(convertToAssetUrlSync('C:/tc3d-mods-cache/fsltl_b738.glb')).toBe(`${ORIGIN}/api/msfs/fsltl_b738.glb`)
  })

  it('returns already-URL inputs unchanged', () => {
    expect(convertToAssetUrlSync('/api/mods/file/x.glb')).toBe('/api/mods/file/x.glb')
    expect(convertToAssetUrlSync('http://h/x.glb')).toBe('http://h/x.glb')
  })
})
